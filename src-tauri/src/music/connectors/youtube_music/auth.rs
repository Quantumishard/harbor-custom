//! The signed-in YouTube Music session, borrowed from the webview in `crate::ytmusic`.
//!
//! YouTube has no account API for YouTube Music. Like every other open-source client, this
//! uses the browser session instead: read the webview's cookie store, sign InnerTube requests
//! with `SAPISIDHASH`, and hand the same cookies to yt-dlp. The anonymous connector stays the
//! default, so a session is an optional upgrade rather than a requirement.

use super::innertube::{
    music_context, now_seconds, read_response, DESKTOP_AGENT, MUSIC_API, MUSIC_ORIGIN,
    REQUEST_TIMEOUT,
};
use crate::ytmusic::AccountCookie;
use reqwest::header::{AUTHORIZATION, COOKIE, ORIGIN, USER_AGENT};
use sha1::{Digest, Sha1};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use tauri::Manager;

/// The Google session cookie family. `__Secure-3PAPISID` is what YouTube's own web client
/// signs with; the 1P and legacy spellings are fallbacks for older sessions. `APISID` is not
/// listed: it belongs to the older `APISIDHASH` scheme and never validates here.
const SAPISID_NAMES: [&str; 3] = ["__Secure-3PAPISID", "SAPISID", "__Secure-1PAPISID"];

pub struct Session {
    pub cookies: Vec<AccountCookie>,
    pub cookie_header: String,
    pub account: Option<String>,
    /// The cookie name the hash was accepted with; not every session carries the same family.
    pub credential: String,
    /// Visitor data belonging to this session, so signed requests look like the same client.
    pub visitor: Option<String>,
}

static SESSION: RwLock<Option<Arc<Session>>> = RwLock::new(None);

pub fn current() -> Option<Arc<Session>> {
    SESSION.read().ok()?.clone()
}

pub fn set(session: Session) {
    if let Ok(mut slot) = SESSION.write() {
        *slot = Some(Arc::new(session));
    }
}

pub fn clear() {
    if let Ok(mut slot) = SESSION.write() {
        *slot = None;
    }
}

/// Reuse the tab the listener already signed into, without asking a second time. Silent: a
/// closed window or a signed-out session just leaves the connector anonymous. Returns whether a
/// session was adopted just now, so callers holding rows built from the anonymous view can drop
/// them. `force` lets an explicit Connections check look again immediately.
// shortcut: the session lives in memory and can only be re-read while a YouTube Music window
// is open, so a restart needs the opt-in marker plus that window; persist a token store if
// listeners report repeated reconnects.
pub async fn ensure(app: &tauri::AppHandle, force: bool) -> bool {
    if current().is_some() || !opted_in(app) {
        return false;
    }
    // Home mounts would otherwise re-probe a signed-out tab on every navigation.
    let now = now_seconds();
    if !force && now.saturating_sub(LAST_FAILED_AT.load(Ordering::Relaxed)) < RETRY_COOLDOWN {
        return false;
    }
    match session_from(app).await {
        Ok(session) => {
            set(session);
            true
        }
        Err(_) => {
            LAST_FAILED_AT.store(now, Ordering::Relaxed);
            false
        }
    }
}

/// Seconds to wait before an automatic check retries a tab that was not signed in.
const RETRY_COOLDOWN: u64 = 60;
static LAST_FAILED_AT: AtomicU64 = AtomicU64::new(0);

/// The listener connected an account at least once. Without this marker a signed-in YouTube
/// Music tab is just a tab, and Harbor keeps browsing anonymously.
fn marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join("ytmusic-session-enabled"))
}

fn opted_in(app: &tauri::AppHandle) -> bool {
    marker(app).is_some_and(|path| path.exists())
}

pub fn record_opt_in(app: &tauri::AppHandle) {
    if let Some(path) = marker(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, "1");
    }
}

pub fn forget(app: &tauri::AppHandle) {
    if let Some(path) = marker(app) {
        let _ = std::fs::remove_file(path);
    }
}

pub async fn session_from(app: &tauri::AppHandle) -> Result<Session, String> {
    let cookies = crate::ytmusic::account_cookies(app).await?;
    let cookie_header = cookie_header(&cookies);
    let page = session_page(&cookie_header).await;
    // Which spelling Google answers to depends on the session, so try the valid ones in order
    // and keep the one that produced an account. A wrong hash simply answers as signed out.
    let mut tried = Vec::new();
    for name in SAPISID_NAMES {
        if cookie_value(&cookie_header, name).is_none() {
            continue;
        }
        match account_name(&cookie_header, name, page.visitor.as_deref()).await {
            Ok(Some(account)) => {
                return Ok(Session {
                    cookies,
                    cookie_header,
                    account: Some(account),
                    credential: name.to_string(),
                    visitor: page.visitor,
                });
            }
            // A rejected hash and a failed check look the same from here; the page check below
            // still decides whether the cookies themselves are a live session.
            Ok(None) | Err(_) => tried.push(name),
        }
    }
    // The page is loaded with the same cookies the browser would use, so `LOGGED_IN` proves
    // the session even when account_menu declines to name the account.
    if page.logged_in {
        let credential = SAPISID_NAMES
            .iter()
            .find(|name| cookie_value(&cookie_header, name).is_some())
            .ok_or_else(|| "YouTube Music did not hand over a sign-in cookie".to_string())?;
        return Ok(Session {
            cookies,
            cookie_header,
            account: None,
            credential: (*credential).to_string(),
            visitor: page.visitor,
        });
    }
    if tried.is_empty() {
        Err(
            "No signed-in YouTube Music session yet. Sign in in the YouTube Music window, then try again."
                .to_string(),
        )
    } else {
        Err(format!(
            "YouTube Music did not recognise this session (tried: {})",
            tried.join(", ")
        ))
    }
}

#[derive(Default)]
struct SessionPage {
    visitor: Option<String>,
    logged_in: bool,
}

/// The page the signed-in browser itself would load: it carries the visitor id that pairs with
/// these cookies, and says plainly whether the session is live.
async fn session_page(header: &str) -> SessionPage {
    let Ok(response) = reqwest::Client::new()
        .get(MUSIC_ORIGIN)
        .timeout(REQUEST_TIMEOUT)
        .header(USER_AGENT, DESKTOP_AGENT)
        .header(COOKIE, header)
        .send()
        .await
    else {
        return SessionPage::default();
    };
    match response.text().await {
        Ok(page) => parse_page(&page),
        Err(_) => SessionPage::default(),
    }
}

fn parse_page(page: &str) -> SessionPage {
    SessionPage {
        visitor: parse_field(page, "\"VISITOR_DATA\":\"").filter(|value| !value.is_empty()),
        logged_in: page.contains("\"LOGGED_IN\":true"),
    }
}

fn parse_field(page: &str, key: &str) -> Option<String> {
    let start = page.find(key)? + key.len();
    let end = page[start..].find('"')? + start;
    Some(page[start..end].to_string())
}

fn cookie_header(cookies: &[AccountCookie]) -> String {
    // A name can exist on both `.youtube.com` and `.google.com`; YouTube's own copy is the
    // one its web client signs with, so it wins.
    let mut seen: std::collections::HashMap<&str, (&str, bool)> = std::collections::HashMap::new();
    for cookie in cookies {
        if cookie.value.is_empty() {
            continue;
        }
        let preferred = cookie.domain.contains("youtube.com");
        let replace = match seen.get(cookie.name.as_str()) {
            None => true,
            Some((_, current)) => preferred && !*current,
        };
        if replace {
            seen.insert(cookie.name.as_str(), (cookie.value.as_str(), preferred));
        }
    }
    let mut parts = seen
        .into_iter()
        .map(|(name, (value, _))| format!("{name}={value}"))
        .collect::<Vec<_>>();
    // The consent cookie keeps the request valid for listeners whose store never recorded it.
    if !parts.iter().any(|part| part.starts_with("SOCS=")) {
        parts.push("SOCS=CAI".to_string());
    }
    parts.sort();
    parts.join("; ")
}

fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    for part in header.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        if key.eq_ignore_ascii_case(name) && !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// `SAPISIDHASH <seconds>_<sha1("<seconds> <SAPISID> <origin>")>`, the scheme every
/// signed-in YouTube client sends.
pub fn authorization(header: &str, origin: &str, now: u64, credential: &str) -> Option<String> {
    let sapisid = cookie_value(header, credential)?;
    let mut hasher = Sha1::new();
    hasher.update(format!("{now} {sapisid} {origin}").as_bytes());
    Some(format!(
        "SAPISIDHASH {now}_{}",
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

async fn account_name(
    header: &str,
    credential: &str,
    visitor: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(authorization) = authorization(header, MUSIC_ORIGIN, now_seconds(), credential) else {
        return Ok(None);
    };
    let mut request = reqwest::Client::new()
        .post(format!(
            "{MUSIC_API}/account/account_menu?alt=json{}",
            super::innertube::key_param(true)
        ))
        .timeout(REQUEST_TIMEOUT)
        .header(USER_AGENT, DESKTOP_AGENT)
        .header(ORIGIN, MUSIC_ORIGIN)
        .header(COOKIE, header)
        .header(AUTHORIZATION, authorization)
        .header("X-Goog-AuthUser", "0")
        .header("X-Origin", MUSIC_ORIGIN)
        .json(&serde_json::json!({ "context": music_context() }));
    if let Some(visitor) = visitor {
        request = request.header("X-Goog-Visitor-Id", visitor);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("YouTube Music sign-in check failed: {error}"))?;
    let value = read_response(response).await?;
    Ok(find_string(&value, "accountName").or_else(|| find_string(&value, "email")))
}

fn find_string(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(text)) = map.get(key) {
                let text = text.trim();
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
            map.values().find_map(|child| find_string(child, key))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|child| find_string(child, key)),
        _ => None,
    }
}

/// A Netscape cookie file for yt-dlp. Written to a temporary file so the session never sits on
/// disk a moment longer than the extraction that needs it.
pub fn netscape(cookies: &[AccountCookie]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for cookie in cookies {
        let domain = if cookie.domain.starts_with('.') {
            cookie.domain.clone()
        } else {
            format!(".{}", cookie.domain)
        };
        out.push_str(&format!(
            "{domain}\tTRUE\t{}\t{}\t0\t{}\t{}\n",
            cookie.path,
            if cookie.secure { "TRUE" } else { "FALSE" },
            cookie.name,
            cookie.value
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, value: &str) -> AccountCookie {
        AccountCookie {
            domain: ".youtube.com".to_string(),
            path: "/".to_string(),
            secure: true,
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn sapisidhash_matches_youtubes_scheme() {
        assert_eq!(
            authorization(
                "__Secure-3PAPISID=SAPISIDVALUE; SID=other",
                "https://music.youtube.com",
                1_700_000_000,
                "__Secure-3PAPISID"
            )
            .as_deref(),
            Some("SAPISIDHASH 1700000000_7ef7126262ab644136fc1ceef792ef2dac969ed5")
        );
        assert!(authorization("SAPISID=abc", "https://music.youtube.com", 1, "SAPISID").is_some());
        assert!(authorization("SID=abc", "https://music.youtube.com", 1, "SAPISID").is_none());
    }

    #[test]
    fn the_cookie_header_dedupes_and_keeps_consent() {
        let header = cookie_header(&[cookie("SID", "one"), cookie("SID", "two")]);
        assert_eq!(header, "SID=one; SOCS=CAI");
        assert_eq!(
            cookie_header(&[cookie("SOCS", "CAI"), cookie("SAPISID", "abc")]),
            "SAPISID=abc; SOCS=CAI"
        );
        // The YouTube-domain copy of a name beats a Google-domain duplicate.
        let mut google = cookie("SAPISID", "google");
        google.domain = ".google.com".to_string();
        assert_eq!(
            cookie_header(&[google, cookie("SAPISID", "youtube")]),
            "SAPISID=youtube; SOCS=CAI"
        );
    }

    #[test]
    fn cookies_are_read_by_exact_name_not_by_prefix_or_position() {
        // The header is sorted, so `APISID` sits first. A prefix match would pick it over the
        // real credential, and Google would answer as if signed out.
        let header = "APISID=low; SAPISID=older; __Secure-1PAPISID=one; __Secure-3PAPISID=newest";
        assert_eq!(cookie_value(header, "APISID"), Some("low"));
        assert_eq!(cookie_value(header, "SAPISID"), Some("older"));
        assert_eq!(cookie_value(header, "__Secure-3PAPISID"), Some("newest"));
        assert_eq!(cookie_value(header, "PID"), None);
        assert_eq!(cookie_value(header, "__Secure-3PSID"), None);
    }

    #[test]
    fn the_page_reports_visitor_data_and_a_live_session() {
        let page =
            r#"ytcfg.set({"VISITOR_DATA":"CgsxMjM0NTY3ODk","LOGGED_IN":true,"SESSION_INDEX":0});"#;
        let parsed = parse_page(page);
        assert_eq!(parsed.visitor.as_deref(), Some("CgsxMjM0NTY3ODk"));
        assert!(parsed.logged_in);
        assert!(!parse_page(r#"{"LOGGED_IN":false}"#).logged_in);
        assert_eq!(parse_page("no config here").visitor, None);
        assert_eq!(parse_page(r#""VISITOR_DATA":"""#).visitor, None);
    }

    #[test]
    fn a_netscape_line_matches_yt_dlp() {
        let file = netscape(&[
            cookie("SAPISID", "abc"),
            AccountCookie {
                domain: "music.youtube.com".to_string(),
                path: "/".to_string(),
                secure: false,
                name: "PREF".to_string(),
                value: "x".to_string(),
            },
        ]);
        assert!(file.starts_with("# Netscape HTTP Cookie File\n"));
        assert!(file.contains(".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tabc\n"));
        assert!(file.contains(".music.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tx\n"));
    }

    #[test]
    fn account_names_are_found_at_any_depth() {
        let value = serde_json::json!({"actions": [{"menu": {"accountName": "  Kerem  "}}]});
        assert_eq!(find_string(&value, "accountName").as_deref(), Some("Kerem"));
        assert!(find_string(&serde_json::json!({"actions": []}), "accountName").is_none());
    }
}
