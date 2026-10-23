use reqwest::{header, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
#[cfg(desktop)]
use tauri::Manager;
#[path = "aiostreams_store.rs"]
mod stored;

#[cfg(desktop)]
fn stored_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate protected sign-in storage")?
        .join("aiostreams"))
}

#[cfg(desktop)]
#[tauri::command]
pub fn aiostreams_remember(
    app: tauri::AppHandle,
    session_id: String,
    remember: bool,
) -> Result<(), String> {
    let root = stored_root(&app)?;
    if !remember {
        return stored::remove(&root);
    }
    let session = sessions()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .get(&session_id)
        .cloned()
        .ok_or("Please sign in before remembering this instance")?;
    stored::write(&root, session.base.as_str(), &session.cookie)
}

#[cfg(desktop)]
#[tauri::command]
pub fn aiostreams_forget(app: tauri::AppHandle) -> Result<(), String> {
    stored::remove(&stored_root(&app)?)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn aiostreams_restore(app: tauri::AppHandle) -> Result<Option<Connection>, String> {
    restore_from(stored_root(&app)?).await
}

#[cfg(desktop)]
async fn restore_from(root: std::path::PathBuf) -> Result<Option<Connection>, String> {
    let Some(saved) = stored::read(&root)? else {
        return Ok(None);
    };
    let base = base_url(&saved.base)?;
    let response = client()?
        .get(
            base.join("api/v1/dashboard/usenet/library?limit=1")
                .map_err(|_| "Invalid saved instance URL")?,
        )
        .header(header::ACCEPT, "application/json")
        .header(header::COOKIE, &saved.cookie)
        .send()
        .await
        .map_err(|_| {
            "Could not reconnect to the saved AIOStreams instance. Check the connection and retry."
                .to_string()
        })?;
    if matches!(response.status().as_u16(), 401 | 403 | 300..=399) {
        stored::remove(&root)?;
        return Err(
            "Your saved AIOStreams sign-in expired or was revoked. Please sign in again.".into(),
        );
    }
    data(response).await?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut store = sessions()
        .lock()
        .map_err(|_| "Session storage is unavailable")?;
    if store.len() >= 8 {
        return Err("Disconnect an existing AIOStreams connection first".into());
    }
    store.insert(
        session_id.clone(),
        Session {
            base: base.clone(),
            cookie: saved.cookie,
        },
    );
    Ok(Some(Connection {
        session_id,
        base_url: base.to_string(),
    }))
}

#[cfg(desktop)]
fn pending_logins() -> &'static Mutex<HashMap<String, Url>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Url>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn aiostreams_browser_begin(
    app: tauri::AppHandle,
    base_url_input: String,
) -> Result<String, String> {
    let base = base_url(&base_url_input)?;
    let label = format!("aio-login-{}", uuid::Uuid::new_v4());
    let target = base
        .join("dashboard/usenet")
        .map_err(|_| "Invalid instance URL")?;
    let window_label = label.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            &window_label,
            tauri::WebviewUrl::External(target),
        )
        .title("AIOStreams — sign in, then return to Harbor")
        .inner_size(1050.0, 780.0)
        .incognito(true);
        crate::browser_args::match_main(&app, builder)
            .build()
            .map(|_| ())
            .map_err(|_| "Could not open the AIOStreams sign-in window".to_string())
    })
    .await
    .map_err(|_| "Sign-in window worker failed")??;
    pending_logins()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .insert(label.clone(), base);
    Ok(label)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn aiostreams_browser_finish(
    app: tauri::AppHandle,
    login_id: String,
) -> Result<Connection, String> {
    let base = pending_logins()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .get(&login_id)
        .cloned()
        .ok_or("Open a new sign-in window first")?;
    let window = app
        .get_webview_window(&login_id)
        .ok_or("The sign-in window was closed. Open it again to connect.")?;
    let cookie_url = base
        .join("api/v1/dashboard/usenet/library")
        .map_err(|_| "Invalid instance URL")?;
    let cookie_window = window.clone();
    let cookies =
        tauri::async_runtime::spawn_blocking(move || cookie_window.cookies_for_url(cookie_url))
            .await
            .map_err(|_| "Could not read the sign-in session")?
            .map_err(|_| "Could not read the sign-in session")?;
    let cookie = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.is_empty() {
        return Err("Finish signing in to ElfHosted and the AIOStreams dashboard in the sign-in window first".into());
    }
    let probe = client()?
        .get(
            base.join("api/v1/dashboard/usenet/library?limit=1")
                .map_err(|_| "Invalid instance URL")?,
        )
        .header(header::ACCEPT, "application/json")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .map_err(|_| "Could not verify the AIOStreams dashboard session".to_string())?;
    data(probe).await?;
    let session_id = uuid::Uuid::new_v4().to_string();
    {
        let mut store = sessions()
            .lock()
            .map_err(|_| "Session storage is unavailable")?;
        if store.len() >= 8 {
            return Err("Disconnect an existing AIOStreams connection first".into());
        }
        store.insert(
            session_id.clone(),
            Session {
                base: base.clone(),
                cookie,
            },
        );
    }
    pending_logins()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .remove(&login_id);
    let _ = window.close();
    Ok(Connection {
        session_id,
        base_url: base.to_string(),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn aiostreams_browser_cancel(
    app: tauri::AppHandle,
    login_id: String,
) -> Result<(), String> {
    if pending_logins()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .remove(&login_id)
        .is_some()
    {
        if let Some(window) = app.get_webview_window(&login_id) {
            let _ = window.close();
        }
    }
    Ok(())
}

#[derive(Clone)]
struct Playback {
    session_id: String,
    url: Url,
}

fn playbacks() -> &'static Mutex<HashMap<String, Playback>> {
    static PLAYBACKS: OnceLock<Mutex<HashMap<String, Playback>>> = OnceLock::new();
    PLAYBACKS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn playback_port() -> Result<u16, String> {
    static PORT: tokio::sync::OnceCell<u16> = tokio::sync::OnceCell::const_new();
    PORT.get_or_try_init(|| async {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "Could not start local AIOStreams playback")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Could not inspect local playback")?
            .port();
        let router = axum::Router::new().route(
            "/aiostreams/{id}",
            axum::routing::get(serve_playback).head(serve_playback),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok::<u16, String>(port)
    })
    .await
    .copied()
}

async fn serve_playback(
    axum::extract::Path(id): axum::extract::Path<String>,
    method: axum::http::Method,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::{body::Body, http::StatusCode, response::IntoResponse};
    let playback = playbacks()
        .lock()
        .ok()
        .and_then(|store| store.get(&id).cloned());
    let Some(playback) = playback else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let session = sessions()
        .lock()
        .ok()
        .and_then(|store| store.get(&playback.session_id).cloned());
    let Some(session) = session else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let client = match Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(120))
        .build()
    {
        Ok(client) => client,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    // Playback stays native: the hosting cookie never enters React, history, or mpv arguments.
    let mut request = client
        .request(method, playback.url)
        .header(header::COOKIE, session.cookie)
        .header(header::ACCEPT_ENCODING, "identity");
    for name in [header::RANGE, header::IF_RANGE] {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, value);
        }
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    if !response.status().is_success() && response.status() != StatusCode::RANGE_NOT_SATISFIABLE {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let mut builder = axum::http::Response::builder().status(response.status());
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = response.headers().get(&name) {
            builder = builder.header(name, value);
        }
    }
    builder
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

#[derive(Clone)]
struct Session {
    base: Url,
    cookie: String,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "Could not initialize the AIOStreams connection".into())
}

fn base_url(value: &str) -> Result<Url, String> {
    let mut base =
        Url::parse(value.trim()).map_err(|_| "Enter the instance base URL".to_string())?;
    let local = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(base.scheme() == "https" || (base.scheme() == "http" && local))
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("Use an HTTPS instance URL without credentials, a query, or a fragment".into());
    }
    if base.path().contains("/stremio/") || base.path().contains("/dashboard") {
        return Err("Enter the instance base URL, not a dashboard or addon URL".into());
    }
    base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
    Ok(base)
}

async fn data(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "AIOStreams login failed or expired. Please sign in again.".into(),
            403 => "AIOStreams requires an administrator dashboard login. Password login may be disabled.".into(),
            404 => "This AIOStreams instance does not expose the required API. Check its URL and version.".into(),
            429 => "AIOStreams is limiting requests. Wait a moment before retrying.".into(),
            300..=399 => "The instance redirected this request. Use its direct URL; an additional hosting login may be required.".into(),
            _ => format!("AIOStreams request failed ({})", status.as_u16()),
        });
    }
    // Dashboard errors may include NZB URLs and provider data: never forward raw bodies.
    let body: Value = response.json().await.map_err(|_| {
        "AIOStreams returned an unexpected response. Check the instance URL.".to_string()
    })?;
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("AIOStreams could not complete the request".into());
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    session_id: String,
    base_url: String,
}

#[tauri::command]
pub async fn aiostreams_connect(
    base_url_input: String,
    username: String,
    password: String,
) -> Result<Connection, String> {
    let base = base_url(&base_url_input)?;
    let response = client()?
        .post(
            base.join("api/v1/auth/login")
                .map_err(|_| "Invalid base URL")?,
        )
        .header(header::ACCEPT, "application/json")
        .json(&json!({"username": username, "password": password}))
        .send()
        .await
        .map_err(|_| {
            "Could not reach AIOStreams. Check the URL, network, and certificate.".to_string()
        })?;
    let cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .find(|v| v.starts_with("aiostreams.session="))
        .map(str::to_string);
    let user = data(response).await?;
    let admin = user.get("isAdmin").and_then(Value::as_bool) == Some(true)
        || user
            .get("permissions")
            .and_then(Value::as_array)
            .is_some_and(|p| p.iter().any(|v| v == "admin"));
    if !admin {
        return Err("This login does not have AIOStreams dashboard administrator access".into());
    }
    let cookie = cookie
        .filter(|c| c.len() > "aiostreams.session=".len())
        .ok_or("AIOStreams did not return a dashboard session. Check instance compatibility.")?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut store = sessions()
        .lock()
        .map_err(|_| "Session storage is unavailable")?;
    if store.len() >= 8 {
        return Err(
            "Too many active AIOStreams connections. Disconnect an existing connection first."
                .into(),
        );
    }
    store.insert(
        session_id.clone(),
        Session {
            base: base.clone(),
            cookie,
        },
    );
    Ok(Connection {
        session_id,
        base_url: base.to_string(),
    })
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum LibraryRequest {
    List {
        offset: u32,
        query: String,
        status: String,
        sort: String,
        direction: String,
    },
    Files {
        hash: String,
    },
    Play {
        hash: String,
        selector: String,
    },
}

fn endpoint(session: &Session, request: &LibraryRequest) -> Result<Url, String> {
    let mut url = session
        .base
        .join("api/v1/dashboard/usenet/library")
        .map_err(|_| "Invalid base URL")?;
    match request {
        LibraryRequest::List {
            offset,
            query,
            status,
            sort,
            direction,
        } => {
            if ![
                "all",
                "available",
                "degraded",
                "failed",
                "queued",
                "inspecting",
            ]
            .contains(&status.as_str())
                || !["added", "activity", "name", "size"].contains(&sort.as_str())
                || !["asc", "desc"].contains(&direction.as_str())
            {
                return Err("Invalid library filter".into());
            }
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("limit", "50")
                .append_pair("offset", &offset.to_string())
                .append_pair("status", "all")
                .append_pair("q", query)
                .append_pair("sort", sort)
                .append_pair("dir", direction);
            if status != "all" {
                pairs.append_pair("statuses", status);
            }
        }
        LibraryRequest::Files { hash } | LibraryRequest::Play { hash, .. } => {
            if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalid library entry".into());
            }
            let mut segments = url.path_segments_mut().map_err(|_| "Invalid base URL")?;
            segments.push(hash);
            match request {
                LibraryRequest::Play { selector, .. } => {
                    if selector.is_empty() || selector == "." || selector == ".." {
                        return Err("Select a playable file".into());
                    }
                    segments.push("play").push(selector);
                }
                _ => {
                    segments.push("files");
                }
            }
        }
    }
    Ok(url)
}

#[tauri::command]
pub async fn aiostreams_library(
    session_id: String,
    request: LibraryRequest,
) -> Result<Value, String> {
    let session = sessions()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .get(&session_id)
        .cloned()
        .ok_or("Please sign in to AIOStreams again")?;
    let response = client()?
        .get(endpoint(&session, &request)?)
        .header(header::ACCEPT, "application/json")
        .header(header::COOKIE, &session.cookie)
        .send()
        .await
        .map_err(|_| "Could not reach the AIOStreams library".to_string())?;
    let mut result = data(response).await?;
    if matches!(request, LibraryRequest::Play { .. }) {
        let value = result
            .get("url")
            .and_then(Value::as_str)
            .ok_or("AIOStreams did not return a playback URL")?;
        let url = session
            .base
            .join(value)
            .map_err(|_| "Invalid playback URL")?;
        if url.origin() != session.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || !url
                .path()
                .starts_with(&format!("{}api/v1/usenet/stream/", session.base.path()))
        {
            return Err("AIOStreams returned a playback URL outside this instance".into());
        }
        let port = playback_port().await?;
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut store = playbacks()
                .lock()
                .map_err(|_| "Playback storage is unavailable")?;
            // A single library session needs only its most recently selected file.
            store.retain(|_, playback| playback.session_id != session_id);
            store.insert(
                id.clone(),
                Playback {
                    session_id: session_id.clone(),
                    url,
                },
            );
        }
        result["url"] = Value::String(format!("http://127.0.0.1:{port}/aiostreams/{id}"));
    }
    Ok(result)
}

#[tauri::command]
pub fn aiostreams_disconnect(session_id: String) -> Result<(), String> {
    playbacks()
        .lock()
        .map_err(|_| "Playback storage is unavailable")?
        .retain(|_, playback| playback.session_id != session_id);
    sessions()
        .lock()
        .map_err(|_| "Session storage is unavailable")?
        .remove(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    async fn protected_session_restores_without_password_and_expires_cleanly() {
        use axum::{
            extract::State,
            http::{HeaderMap, StatusCode},
            response::IntoResponse,
            routing::get,
            Json, Router,
        };
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let active = Arc::new(AtomicBool::new(true));
        async fn library(
            State(active): State<Arc<AtomicBool>>,
            headers: HeaderMap,
        ) -> axum::response::Response {
            assert_eq!(headers.get("cookie").unwrap(), "host=protected-fixture");
            if !active.load(Ordering::SeqCst) {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            Json(json!({"success":true,"data":{"entries":[],"total":0}})).into_response()
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let base = format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        );
        let router = Router::new()
            .route("/api/v1/dashboard/usenet/library", get(library))
            .with_state(active.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let root =
            std::env::temp_dir().join(format!("harbor-aio-restore-{}", uuid::Uuid::new_v4()));
        stored::write(&root, &base, "host=protected-fixture").unwrap();
        let restored = restore_from(root.clone()).await.unwrap().unwrap();
        assert_eq!(restored.base_url, base);
        aiostreams_disconnect(restored.session_id).unwrap();
        active.store(false, Ordering::SeqCst);
        assert!(restore_from(root.clone())
            .await
            .err()
            .unwrap()
            .contains("expired"));
        assert!(stored::read(&root).unwrap().is_none());
        std::fs::remove_dir(root).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn native_library_and_range_playback_keep_hosting_cookies_private() {
        use axum::{
            extract::{Path, State},
            http::{HeaderMap, StatusCode},
            response::IntoResponse,
            routing::{get, post},
            Json, Router,
        };
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let base = format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        );
        async fn login() -> impl IntoResponse {
            (
                [("set-cookie", "aiostreams.session=fixture; HttpOnly; Path=/")],
                Json(json!({"success":true,"data":{"isAdmin":true}})),
            )
        }
        async fn list(headers: HeaderMap) -> impl IntoResponse {
            assert_eq!(headers.get("cookie").unwrap(), "aiostreams.session=fixture");
            Json(json!({"success":true,"data":{"entries":[],"total":0}}))
        }
        async fn mint(
            State(base): State<String>,
            Path((_hash, _selector)): Path<(String, String)>,
        ) -> impl IntoResponse {
            Json(
                json!({"success":true,"data":{"url":format!("{base}api/v1/usenet/stream/fixture"),"filename":"episode.mkv"}}),
            )
        }
        async fn bytes(headers: HeaderMap) -> impl IntoResponse {
            assert_eq!(headers.get("cookie").unwrap(), "aiostreams.session=fixture");
            assert_eq!(headers.get("range").unwrap(), "bytes=2-4");
            assert!(headers.get("authorization").is_none());
            (
                StatusCode::PARTIAL_CONTENT,
                [
                    ("content-range", "bytes 2-4/6"),
                    ("accept-ranges", "bytes"),
                    ("content-type", "video/x-matroska"),
                ],
                "cde",
            )
        }
        let router = Router::new()
            .route("/api/v1/auth/login", post(login))
            .route("/api/v1/dashboard/usenet/library", get(list))
            .route(
                "/api/v1/dashboard/usenet/library/{hash}/play/{selector}",
                get(mint),
            )
            .route("/api/v1/usenet/stream/fixture", get(bytes))
            .with_state(base.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let connection = aiostreams_connect(base, "fixture".into(), "fixture".into())
            .await
            .unwrap();
        let page = aiostreams_library(
            connection.session_id.clone(),
            LibraryRequest::List {
                offset: 0,
                query: String::new(),
                status: "all".into(),
                sort: "added".into(),
                direction: "desc".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(page["total"], 0);
        let minted = aiostreams_library(
            connection.session_id.clone(),
            LibraryRequest::Play {
                hash: "a".repeat(40),
                selector: "0".into(),
            },
        )
        .await
        .unwrap();
        let local = minted["url"].as_str().unwrap();
        assert!(local.starts_with("http://127.0.0.1:"));
        assert!(!local.contains("fixture"));
        let response = Client::new()
            .get(local)
            .header("range", "bytes=2-4")
            .header("cookie", "untrusted=ignored")
            .header("authorization", "untrusted")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 2-4/6");
        assert!(response.headers().get("set-cookie").is_none());
        assert_eq!(response.text().await.unwrap(), "cde");
        aiostreams_disconnect(connection.session_id).unwrap();
        assert_eq!(
            Client::new().get(local).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        server.abort();
    }

    #[test]
    fn validates_instance_and_preserves_prefix() {
        assert_eq!(
            base_url("https://example.com/aio").unwrap().as_str(),
            "https://example.com/aio/"
        );
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/?token=secret",
            "https://example.com/stremio/secret/manifest.json",
        ] {
            assert!(base_url(url).is_err());
        }
        assert!(base_url("http://127.0.0.1:3000").is_ok());
    }

    #[test]
    fn builds_encoded_file_and_filtered_page_requests() {
        let session = Session {
            base: base_url("https://example.com").unwrap(),
            cookie: "fixture".into(),
        };
        let url = endpoint(
            &session,
            &LibraryRequest::Play {
                hash: "a".repeat(40),
                selector: "folder/episode #1.mkv".into(),
            },
        )
        .unwrap();
        assert!(url.as_str().ends_with("/play/folder%2Fepisode%20%231.mkv"));
        let url = endpoint(
            &session,
            &LibraryRequest::List {
                offset: 50,
                query: "a & b".into(),
                status: "degraded".into(),
                sort: "added".into(),
                direction: "desc".into(),
            },
        )
        .unwrap();
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("offset").unwrap(), "50");
        assert_eq!(pairs.get("statuses").unwrap(), "degraded");
        assert_eq!(pairs.get("q").unwrap(), "a & b");
        assert!(endpoint(
            &session,
            &LibraryRequest::Files {
                hash: "../providers".into()
            }
        )
        .is_err());
    }
}
