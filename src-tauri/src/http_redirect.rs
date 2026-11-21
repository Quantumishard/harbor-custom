use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::{Client, Method, RequestBuilder, Response, Url};

const MAX_REDIRECTS: usize = 10;

pub(crate) fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

// Custom headers can contain credentials under any name. Only protocol metadata
// may cross an origin boundary; a denylist of known token names is insufficient.
pub(crate) fn safe_cross_origin_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "accept-language" | "accept-encoding" | "user-agent" | "range"
    )
}

fn strip_cross_origin_headers(headers: &mut HeaderMap) {
    let remove: Vec<_> = headers
        .keys()
        .filter(|name| !safe_cross_origin_header(name.as_str()))
        .cloned()
        .collect();
    for name in remove {
        headers.remove(name);
    }
}

/// A hop is usable when it speaks HTTP(S). Playback additionally accepts the two
/// things a player accepts: an HTTPS link that hands off to plain HTTP, and a
/// redirect target that carries basic-auth credentials in its URL (they are
/// lifted into an `Authorization` header, never sent inside the request line).
fn validate_hop(current: &Url, next: &Url, playback: bool) -> Result<(), &'static str> {
    if !matches!(next.scheme(), "http" | "https") {
        return Err("invalid redirect target");
    }
    if !playback && (!next.username().is_empty() || next.password().is_some()) {
        return Err("invalid redirect target");
    }
    if !playback && current.scheme() == "https" && next.scheme() != "https" {
        return Err("HTTPS downgrade is not allowed");
    }
    Ok(())
}

/// Moves `user:password@` out of a redirect target into an `Authorization`
/// header, exactly as the initial request URL is handled. The credentials are
/// percent-decoded first: basic auth is defined over the decoded pair.
fn apply_url_credentials(headers: &mut HeaderMap, url: &mut Url) -> Result<(), &'static str> {
    let username = url.username().to_string();
    let password = url.password().unwrap_or("").to_string();
    if username.is_empty() && password.is_empty() {
        return Ok(());
    }
    let pair = format!(
        "{}:{}",
        percent_decode(&username),
        percent_decode(&password)
    );
    let value = HeaderValue::from_str(&format!("Basic {}", BASE64.encode(pair)))
        .map_err(|_| "invalid redirect target")?;
    headers.insert(AUTHORIZATION, value);
    url.set_username("")
        .map_err(|_| "invalid redirect target")?;
    url.set_password(None)
        .map_err(|_| "invalid redirect target")?;
    Ok(())
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_digit(bytes[index + 1]), hex_digit(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn validate_public(url: &Url, public_only: bool) -> Result<(), &'static str> {
    if !public_only {
        return Ok(());
    }
    crate::http_fetch::validate_target(url, false)
        .await
        .map_err(|_| "blocked internal target")
}

/// The client must have automatic redirects disabled. Keep origin-bound headers
/// on same-origin hops, but never restore them after leaving that origin.
pub(crate) async fn send_get(
    client: &Client,
    builder: RequestBuilder,
    credential_origin: &str,
) -> Result<Response, &'static str> {
    send_get_checked(client, builder, credential_origin, false, false).await
}

/// Same as `send_get`, but also refuses loopback, link-local and private
/// targets on every hop. Use it when the URL came from an add-on.
pub(crate) async fn send_get_public(
    client: &Client,
    builder: RequestBuilder,
    credential_origin: &str,
) -> Result<Response, &'static str> {
    send_get_checked(client, builder, credential_origin, true, false).await
}

/// Follows redirects for a user-selected playback URL the way the player does.
///
/// The stream proxy stands in for mpv here, and mpv (libcurl) follows an HTTPS
/// link that hands off to a plain-HTTP host on the viewer's own network, and
/// carries the basic-auth credentials a redirect target such as an NzbDAV link
/// puts in its URL. The stricter [send_get] refuses both, which turns a link
/// that Stremio, Nuvio and mpv open into an immediate `502` from the local
/// proxy. Credential isolation at origin changes is unchanged: the add-on's
/// headers still stop there.
pub(crate) async fn send_get_playback(
    client: &Client,
    builder: RequestBuilder,
    credential_origin: &str,
) -> Result<Response, &'static str> {
    send_get_checked(client, builder, credential_origin, false, true).await
}

async fn send_get_checked(
    client: &Client,
    builder: RequestBuilder,
    credential_origin: &str,
    public_only: bool,
    playback: bool,
) -> Result<Response, &'static str> {
    let origin = Url::parse(credential_origin).map_err(|_| "invalid request origin")?;
    let mut request = builder.build().map_err(|_| "invalid upstream request")?;
    if request.method() != Method::GET {
        return Err("redirect helper requires GET");
    }
    validate_hop(&origin, request.url(), playback)?;
    validate_public(request.url(), public_only).await?;
    if !same_origin(&origin, request.url()) {
        strip_cross_origin_headers(request.headers_mut());
    }
    for redirects in 0..=MAX_REDIRECTS {
        let next_request = request.try_clone().ok_or("request cannot be replayed")?;
        let response = client
            .execute(request)
            .await
            .map_err(|_| "upstream request failed")?;
        let status = response.status().as_u16();
        if !matches!(status, 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
            return Ok(response);
        };
        if redirects == MAX_REDIRECTS {
            return Err("too many redirects");
        }
        let mut next = response
            .url()
            .join(location.to_str().map_err(|_| "invalid redirect")?)
            .map_err(|_| "invalid redirect")?;
        validate_hop(response.url(), &next, playback)?;
        validate_public(&next, public_only).await?;
        request = next_request;
        if !same_origin(response.url(), &next) {
            strip_cross_origin_headers(request.headers_mut());
        }
        // After the strip: these arrive with the redirect target itself, so they
        // are that host's credentials, not the previous origin's.
        if playback {
            apply_url_credentials(request.headers_mut(), &mut next)?;
        }
        *request.url_mut() = next;
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, routing::get, Json, Router};
    use std::collections::HashMap;

    struct Server {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn serve(router: Router) -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Server { url, task }
    }
    fn echo() -> Router {
        Router::new().route(
            "/echo",
            get(|headers: HeaderMap| async move {
                Json(
                    headers
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
                        .collect::<HashMap<_, _>>(),
                )
            }),
        )
    }
    fn redirect(target: String, status: u16) -> Router {
        Router::new().route(
            "/start",
            get(move || {
                let target = target.clone();
                async move {
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        [("location", target)],
                    )
                }
            }),
        )
    }
    fn client() -> Client {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }
    fn request(client: &Client, url: &str) -> RequestBuilder {
        client
            .get(url)
            .header("x-test-token", "synthetic-only")
            .header("authorization", "Bearer synthetic-only")
            .header("cookie", "test=synthetic-only")
            .header("referer", "https://example.com/private")
            .header("origin", "https://example.com")
            .header("range", "bytes=0-100")
            .header("accept", "video/*")
    }

    #[tokio::test]
    async fn baseline_default_redirects_forward_custom_tokens() {
        let target = serve(echo()).await;
        let source = serve(redirect(format!("{}/echo", target.url), 302)).await;
        let default_client = Client::builder().no_proxy().build().unwrap();
        let headers: HashMap<String, String> =
            request(&default_client, &format!("{}/start", source.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
        assert_eq!(headers.get("x-test-token").unwrap(), "synthetic-only");
    }

    #[tokio::test]
    async fn cross_origin_redirects_drop_all_credentials_and_keep_range() {
        let target = serve(echo()).await;
        for status in [301, 302, 303, 307, 308] {
            let source = serve(redirect(format!("{}/echo", target.url), status)).await;
            let client = client();
            let headers: HashMap<String, String> = send_get(
                &client,
                request(&client, &format!("{}/start", source.url)),
                &source.url,
            )
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
            for key in [
                "x-test-token",
                "authorization",
                "cookie",
                "referer",
                "origin",
            ] {
                assert!(!headers.contains_key(key), "forwarded {key} on {status}");
            }
            assert_eq!(headers["range"], "bytes=0-100");
            assert_eq!(headers["accept"], "video/*");
        }
    }

    #[tokio::test]
    async fn same_origin_relative_redirect_keeps_provider_credentials() {
        let server = serve(echo().merge(redirect("/echo".into(), 307))).await;
        let client = client();
        let headers: HashMap<String, String> = send_get(
            &client,
            request(&client, &format!("{}/start", server.url)),
            &server.url,
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(headers["x-test-token"], "synthetic-only");
        assert_eq!(headers["authorization"], "Bearer synthetic-only");
        assert_eq!(headers["cookie"], "test=synthetic-only");
    }

    #[tokio::test]
    async fn cross_origin_playlist_targets_do_not_receive_original_headers() {
        let target = serve(echo()).await;
        let client = client();
        let headers: HashMap<String, String> = send_get(
            &client,
            request(&client, &format!("{}/echo", target.url)),
            "http://example.com/playlist",
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert!(!headers.contains_key("x-test-token"));
    }

    #[tokio::test]
    async fn credentials_are_not_restored_after_returning_to_original_origin() {
        let original = serve(echo()).await;
        let away = serve(redirect(format!("{}/echo", original.url), 302)).await;
        let client = client();
        let headers: HashMap<String, String> = send_get(
            &client,
            request(&client, &format!("{}/start", away.url)),
            &original.url,
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert!(!headers.contains_key("x-test-token"));
    }

    #[tokio::test]
    async fn redirect_loops_are_bounded() {
        let server = serve(redirect("/start".into(), 302)).await;
        let client = client();
        assert_eq!(
            send_get(
                &client,
                client.get(format!("{}/start", server.url)),
                &server.url
            )
            .await
            .unwrap_err(),
            "too many redirects"
        );
    }

    #[tokio::test]
    async fn playback_still_drops_addon_credentials_at_an_origin_change() {
        let target = serve(echo()).await;
        let source = serve(redirect(format!("{}/echo", target.url), 302)).await;
        let client = client();
        let headers: HashMap<String, String> = send_get_playback(
            &client,
            request(&client, &format!("{}/start", source.url)),
            &source.url,
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        for key in ["x-test-token", "authorization", "cookie", "referer"] {
            assert!(
                !headers.contains_key(key),
                "forwarded {key} across an origin"
            );
        }
        assert_eq!(headers["range"], "bytes=0-100");
    }

    #[tokio::test]
    async fn playback_redirect_loops_are_bounded() {
        let server = serve(redirect("/start".into(), 302)).await;
        let client = client();
        assert_eq!(
            send_get_playback(
                &client,
                client.get(format!("{}/start", server.url)),
                &server.url
            )
            .await
            .unwrap_err(),
            "too many redirects"
        );
    }

    #[tokio::test]
    async fn playback_applies_credentials_from_a_redirect_target() {
        // The real chain: AIOStreams' playback route redirects to an NzbDAV link
        // that carries its webdav user and password in the URL.
        let target = serve(echo()).await;
        let secured = target.url.replacen("http://", "http://webdav:p%40ss@", 1);
        let source = serve(redirect(format!("{secured}/echo"), 302)).await;
        let client = client();
        let headers: HashMap<String, String> = send_get_playback(
            &client,
            request(&client, &format!("{}/start", source.url)),
            &source.url,
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        // base64("webdav:p@ss")
        assert_eq!(headers["authorization"], "Basic d2ViZGF2OnBAc3M=");
        assert_eq!(headers["range"], "bytes=0-100");
    }

    #[tokio::test]
    async fn strict_fetch_still_refuses_credentials_in_a_redirect_target() {
        let target = serve(echo()).await;
        let secured = target.url.replacen("http://", "http://webdav:secret@", 1);
        let source = serve(redirect(format!("{secured}/echo"), 302)).await;
        let client = client();
        assert_eq!(
            send_get(
                &client,
                client.get(format!("{}/start", source.url)),
                &source.url
            )
            .await
            .unwrap_err(),
            "invalid redirect target"
        );
    }

    #[test]
    fn playback_accepts_the_lan_hop_the_strict_policy_refuses() {
        let secure = Url::parse("https://gateway.example/play").unwrap();
        // A provider gateway that hands playback to a LAN NzbDAV over plain HTTP.
        let lan = Url::parse("http://192.168.1.20:3000/content/episode.mkv").unwrap();
        assert_eq!(
            validate_hop(&secure, &lan, false),
            Err("HTTPS downgrade is not allowed")
        );
        assert!(validate_hop(&secure, &lan, true).is_ok());
        assert!(validate_hop(&secure, &Url::parse("ftp://host/file").unwrap(), true).is_err());
        // Credentials in a redirect target: refused for add-on data, accepted for
        // playback (they become an Authorization header, not part of the URL).
        let secured = Url::parse("http://webdav:secret@host/file").unwrap();
        assert_eq!(
            validate_hop(&secure, &secured, false),
            Err("invalid redirect target")
        );
        assert!(validate_hop(&secure, &secured, true).is_ok());
    }

    #[test]
    fn url_credentials_are_percent_decoded_before_basic_auth() {
        assert_eq!(percent_decode("p%40ss"), "p@ss");
        assert_eq!(percent_decode("a%2Bb%20c"), "a+b c");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("bad%2"), "bad%2");
        assert_eq!(percent_decode("bad%zz"), "bad%zz");
    }

    #[tokio::test]
    async fn public_fetch_refuses_internal_targets_before_requesting() {
        let server = serve(echo()).await;
        let client = client();
        let result = send_get_public(
            &client,
            request(&client, &format!("{}/echo", server.url)),
            &server.url,
        )
        .await;
        assert!(matches!(result, Err("blocked internal target")));
    }

    #[test]
    fn security_boundaries_include_port_scheme_and_url_credentials() {
        let https = Url::parse("https://example.com/").unwrap();
        for target in [
            "http://example.com/",
            "https://example.com:444/",
            "https://other.example.com/",
        ] {
            assert!(!same_origin(&https, &Url::parse(target).unwrap()));
        }
        assert!(same_origin(
            &https,
            &Url::parse("https://example.com:443/path").unwrap()
        ));
        for target in [
            "http://example.com/",
            "file:///tmp/test",
            "https://user:pass@example.com/",
        ] {
            assert!(validate_hop(&https, &Url::parse(target).unwrap(), false).is_err());
        }
        for name in [
            "X-Unknown-Secret",
            "X-Api-Key",
            "If-Range",
            "Origin",
            "Referer",
            "Cookie",
        ] {
            assert!(!safe_cross_origin_header(name));
        }
    }
}
