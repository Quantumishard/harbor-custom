use super::{aiostreams_library, client, data, sessions, LibraryRequest, Session};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use reqwest::{header, multipart, Url};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

fn jobs() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static JOBS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct Selection {
    hash: String,
    filename: String,
    ext: String,
    username: String,
    password: String,
}

fn decode(value: &str) -> String {
    url::form_urlencoded::parse(format!("v={}", value.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

fn easynews_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|h| h == "easynews.com" || h.ends_with(".easynews.com"))
}

fn selection(raw: &str) -> Result<Selection, String> {
    let mut url = Url::parse(raw).map_err(|_| "Invalid Easynews selection")?;
    if !["http", "https"].contains(&url.scheme())
        || url.port().is_some()
        || url.username().is_empty()
    {
        return Err("Select an original Easynews HTTP result".into());
    }
    let username = decode(url.username());
    let password = decode(url.password().unwrap_or_default());
    url.set_username("")
        .map_err(|_| "Invalid Easynews selection")?;
    url.set_password(None)
        .map_err(|_| "Invalid Easynews selection")?;
    url.set_scheme("https")
        .map_err(|_| "Invalid Easynews selection")?;
    if !easynews_url(&url) {
        return Err("Select an original Easynews HTTP result".into());
    }
    let parts: Vec<_> = url
        .path_segments()
        .ok_or("Invalid Easynews selection")?
        .collect();
    if parts.len() < 2 {
        return Err("Invalid Easynews selection".into());
    }
    let hashed = decode(parts[parts.len() - 2]);
    let (hash, ext) = hashed
        .rsplit_once('.')
        .ok_or("Invalid Easynews selection")?;
    let filename = decode(parts[parts.len() - 1]);
    if !(32..=64).contains(&hash.len())
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || ext.is_empty()
        || !ext.bytes().all(|b| b.is_ascii_alphanumeric())
        || !filename
            .to_lowercase()
            .ends_with(&format!(".{}", ext.to_lowercase()))
    {
        return Err("Invalid Easynews selection".into());
    }
    Ok(Selection {
        hash: hash.into(),
        filename: filename[..filename.len() - ext.len() - 1].into(),
        ext: ext.into(),
        username,
        password,
    })
}

fn valid_nzb(bytes: &[u8]) -> bool {
    let mut reader = quick_xml::Reader::from_reader(bytes);
    let mut root = false;
    let mut segment = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                if e.local_name().as_ref() == b"nzb" {
                    root = true;
                }
                if e.local_name().as_ref() == b"segment" {
                    segment = true;
                }
            }
            Ok(quick_xml::events::Event::Eof) => return root && segment,
            Err(_) => return false,
            _ => {}
        }
    }
}

async fn retrieve(selected: &Selection, sig: Option<String>) -> Result<Vec<u8>, String> {
    let client = client()?;
    let initial = Url::parse("https://members.easynews.com/2.0/api/dl-nzb").unwrap();
    let mut url = initial.clone();
    let mut post = true;
    let sig = sig.filter(|s| !s.is_empty() && s.len() <= 1024);
    let key = sig
        .map(|s| format!("0&sig={s}"))
        .unwrap_or_else(|| "0".into());
    let form = [
        ("autoNZB".to_string(), "1".to_string()),
        (
            key,
            format!(
                "{}|{}:{}",
                selected.hash,
                STANDARD_NO_PAD.encode(&selected.filename),
                STANDARD_NO_PAD.encode(&selected.ext)
            ),
        ),
    ];
    for _ in 0..5 {
        let mut request = if post {
            client.post(url.clone()).form(&form)
        } else {
            client.get(url.clone())
        };
        if url.origin() == initial.origin() {
            request = request.basic_auth(&selected.username, Some(&selected.password));
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Could not retrieve the Easynews NZB")?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| url.join(s).ok())
                .ok_or("Easynews returned an invalid NZB redirect")?;
            if !easynews_url(&next) {
                return Err("Easynews redirected outside its secure servers".into());
            }
            match response.status().as_u16() {
                301..=303 => post = false,
                307 | 308 if !post || next.origin() == url.origin() => {}
                _ => return Err("Unsupported Easynews NZB redirect".into()),
            }
            url = next;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "Easynews NZB retrieval failed ({})",
                response.status().as_u16()
            ));
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Easynews NZB download failed")?
        {
            bytes.extend_from_slice(&chunk);
        }
        if !valid_nzb(&bytes) {
            return Err("Easynews returned an empty or invalid NZB".into());
        }
        return Ok(bytes);
    }
    Err("Too many Easynews NZB redirects".into())
}

fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || matches!(c, '.' | '_' | '-'))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn choose_file<'a>(files: &'a [Value], filename: &str) -> Result<Option<&'a Value>, String> {
    let playable: Vec<_> = files
        .iter()
        .filter(|f| {
            f["streamable"].as_bool() == Some(true)
                && (f["path"].as_str().is_some() || f["index"].as_u64().is_some())
        })
        .collect();
    let matches: Vec<_> = playable
        .iter()
        .copied()
        .filter(|f| {
            f["name"]
                .as_str()
                .is_some_and(|s| normalize(s) == normalize(filename))
        })
        .collect();
    if matches.len() == 1 {
        return Ok(Some(matches[0]));
    }
    if playable.len() == 1 {
        return Ok(Some(playable[0]));
    }
    if playable.len() > 1 {
        return Err(
            "Several videos were imported. Choose the file under Library → AIOStreams.".into(),
        );
    }
    Ok(None)
}

async fn import_nzb(
    session_id: String,
    session: &Session,
    bytes: Vec<u8>,
    filename: &str,
) -> Result<Value, String> {
    let part = multipart::Part::bytes(bytes)
        .file_name("easynews.nzb")
        .mime_str("application/x-nzb")
        .map_err(|_| "Could not prepare the NZB upload")?;
    let response = client()?
        .post(
            session
                .base
                .join("api/v1/dashboard/usenet/library/upload")
                .map_err(|_| "Invalid instance URL")?,
        )
        .header(header::COOKIE, &session.cookie)
        .multipart(
            multipart::Form::new()
                .part("file", part)
                .text("name", filename.to_string()),
        )
        .send()
        .await
        .map_err(|_| "Could not upload the NZB to AIOStreams")?;
    let entry = data(response).await?;
    let hash = entry["nzbHash"]
        .as_str()
        .filter(|h| h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("AIOStreams did not return a valid import ID")?;
    if entry["status"] == "failed" {
        return Err("AIOStreams could not inspect this NZB".into());
    }
    loop {
        let listing = aiostreams_library(
            session_id.clone(),
            LibraryRequest::Files { hash: hash.into() },
        )
        .await?;
        if listing["status"] == "failed" {
            return Err("AIOStreams could not inspect this NZB".into());
        }
        let files = listing["files"]
            .as_array()
            .ok_or("AIOStreams returned an unsupported file list")?;
        if let Some(file) = choose_file(files, filename)? {
            let selector = file["path"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| file["index"].as_u64().map(|n| n.to_string()))
                .ok_or("This file has no playback selector")?;
            return aiostreams_library(
                session_id,
                LibraryRequest::Play {
                    hash: hash.into(),
                    selector,
                },
            )
            .await;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

pub async fn play(
    session_id: String,
    request_id: String,
    source_url: String,
    sig: Option<String>,
) -> Result<Value, String> {
    let selected = selection(&source_url)?;
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("Invalid playback request".into());
    }
    let session = sessions()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .get(&session_id)
        .cloned()
        .ok_or("Sign in under Library → AIOStreams first")?;
    let token = CancellationToken::new();
    {
        let mut jobs = jobs().lock().map_err(|_| "Import storage is unavailable")?;
        if jobs.len() >= 4 || jobs.contains_key(&request_id) {
            return Err("Another NZB import is still running".into());
        }
        jobs.insert(request_id.clone(), token.clone());
    }
    let result = tokio::select! {
        _ = token.cancelled() => Err("NZB import cancelled. An upload already accepted by AIOStreams may remain in its library.".into()),
        result = tokio::time::timeout(Duration::from_secs(90), async {
            let bytes = retrieve(&selected, sig).await?;
            import_nzb(session_id, &session, bytes, &format!("{}.{}", selected.filename, selected.ext)).await
        }) => result.unwrap_or_else(|_| Err("NZB inspection timed out. Check Library → AIOStreams, or try HTTP.".into())),
    };
    if let Ok(mut jobs) = jobs().lock() {
        jobs.remove(&request_id);
    }
    result
}

pub fn cancel(request_id: String) {
    if let Ok(jobs) = jobs().lock() {
        if let Some(token) = jobs.get(&request_id) {
            token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_import_inspection_and_range_playback_use_existing_relay() {
        // The process-global relay must not outlive a per-test Tokio runtime.
        // Run this additional relay scenario in its own test process.
        if std::env::var_os("HARBOR_EASYNEWS_TEST_CHILD").is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "aiostreams::easynews::tests::authenticated_import_inspection_and_range_playback_use_existing_relay", "--nocapture"])
                .env("HARBOR_EASYNEWS_TEST_CHILD", "1")
                .status().unwrap();
            assert!(status.success());
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
        use axum::{
            body::Bytes,
            http::HeaderMap,
            routing::{get, post},
            Json, Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let playback_url = format!("{base}api/v1/usenet/stream/fixture");
        let hash = "a".repeat(40);
        let app = Router::new()
            .route("/api/v1/dashboard/usenet/library/upload", post(|headers: HeaderMap, body: Bytes| async move {
                assert_eq!(headers["cookie"], "host=fixture; aiostreams.session=fixture");
                assert!(headers.get("authorization").is_none());
                let body = String::from_utf8_lossy(&body);
                assert!(body.contains("filename=\"easynews.nzb\""));
                assert!(body.contains("Concert.mkv"));
                assert!(body.contains("<segment"));
                Json(serde_json::json!({"success":true,"data":{"nzbHash":"a".repeat(40)}}))
            }))
            .route(&format!("/api/v1/dashboard/usenet/library/{hash}/files"), get(|headers: HeaderMap| async move {
                assert_eq!(headers["cookie"], "host=fixture; aiostreams.session=fixture");
                Json(serde_json::json!({"success":true,"data":{"files":[{"name":"Concert.mkv","streamable":true,"index":0}]}}))
            }))
            .route(&format!("/api/v1/dashboard/usenet/library/{hash}/play/0"), get(move || async move {
                Json(serde_json::json!({"success":true,"data":{"url":playback_url,"filename":"Concert.mkv"}}))
            }))
            .route("/api/v1/usenet/stream/fixture", get(|headers: HeaderMap| async move {
                assert_eq!(headers["cookie"], "host=fixture; aiostreams.session=fixture");
                assert_eq!(headers["range"], "bytes=2-4");
                assert!(headers.get("authorization").is_none());
                (axum::http::StatusCode::PARTIAL_CONTENT, [("content-range", "bytes 2-4/6")], "cde")
            }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let session = Session {
            base: Url::parse(&base).unwrap(),
            cookie: "host=fixture; aiostreams.session=fixture".into(),
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        sessions()
            .lock()
            .unwrap()
            .insert(session_id.clone(), session.clone());
        let result = import_nzb(
            session_id.clone(),
            &session,
            b"<nzb><segment>id</segment></nzb>".to_vec(),
            "Concert.mkv",
        )
        .await
        .unwrap();
        assert!(result["url"].as_str().unwrap().contains("/aiostreams/"));
        let response = client()
            .unwrap()
            .get(result["url"].as_str().unwrap())
            .header("range", "bytes=2-4")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(response.text().await.unwrap(), "cde");
        super::super::aiostreams_disconnect(session_id).unwrap();
        server.abort();
        });
    }

    #[test]
    fn selection_decodes_credentials_and_checks_hosts() {
        let url = format!("https://user%2Bname:p%40ss@members.easynews.com/dl/auto/auto/{}.mkv/Concert%20Live.mkv#harbor-easynews-nzb", "a".repeat(40));
        let result = selection(&url).unwrap();
        assert_eq!(result.username, "user+name");
        assert_eq!(result.password, "p@ss");
        assert_eq!(result.filename, "Concert Live");
        assert!(
            selection(&url.replace("members.easynews.com", "easynews.com.evil.example")).is_err()
        );
        assert!(selection(&url.replace("https:", "file:")).is_err());
    }

    #[test]
    fn validates_nzb_and_refuses_ambiguous_files() {
        assert!(valid_nzb(b"<nzb><file><segments><segment bytes=\"10\" number=\"1\">id</segment></segments></file></nzb>"));
        assert!(!valid_nzb(b"<html>sign in</html>"));
        let files = serde_json::json!([
            {"name":"Concert_Live.mkv", "streamable":true, "index":0},
            {"name":"Other.mkv", "streamable":true, "index":1}
        ]);
        assert_eq!(
            choose_file(files.as_array().unwrap(), "concert live.mkv")
                .unwrap()
                .unwrap()["index"],
            0
        );
        assert!(choose_file(files.as_array().unwrap(), "missing.mkv").is_err());
        assert!(!easynews_url(
            &Url::parse("http://members.easynews.com/nzb").unwrap()
        ));
        assert!(!easynews_url(
            &Url::parse("https://user:pass@members.easynews.com/nzb").unwrap()
        ));
    }
}
