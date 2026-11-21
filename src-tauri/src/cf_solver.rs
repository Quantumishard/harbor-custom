use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const SOLVER_LABEL: &str = "harbor-cf-solver";
const IMAGE_SOLVER_LABEL: &str = "harbor-image-solver";
const CF_TTL: Duration = Duration::from_secs(20 * 60);
const SOLVER_RETRY_COOLDOWN: Duration = Duration::from_secs(30);

static PENDING: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

fn request_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

struct CfEntry {
    cookie: String,
    ua: String,
    at: Instant,
}

// Cloudflare sometimes accepts the embedded browser without issuing a
// transferable cf_clearance cookie. This grants only same-origin browser
// fetching, never permission to replay a fabricated cookie in reqwest.
struct BrowserSession {
    at: Instant,
}

// Remember hosts whose verified clearance did not work with reqwest. This
// preference is temporary, and is only usable while the WebView is on that
// host. A failed browser read gets a short cooldown to prevent request storms.
const BROWSER_PREFERENCE_TTL: Duration = Duration::from_secs(5 * 60);
const BROWSER_FAILURE_COOLDOWN: Duration = Duration::from_secs(20);

fn native_rechallenges() -> &'static Mutex<HashMap<String, Instant>> {
    static S: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn failed_browser_reads() -> &'static Mutex<HashMap<String, Instant>> {
    static S: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cf_prefer_browser(host: &str) -> bool {
    let mut hosts = native_rechallenges().lock().unwrap();
    hosts.retain(|_, at| at.elapsed() < BROWSER_PREFERENCE_TTL);
    hosts.contains_key(host)
}

pub fn cf_note_native_rechallenge(host: &str) {
    native_rechallenges()
        .lock()
        .unwrap()
        .insert(host.to_string(), Instant::now());
}

pub fn cf_browser_cooling_down(host: &str) -> bool {
    let mut hosts = failed_browser_reads().lock().unwrap();
    hosts.retain(|_, at| at.elapsed() < BROWSER_FAILURE_COOLDOWN);
    hosts.contains_key(host)
}

pub fn cf_note_browser_failure(host: &str) {
    failed_browser_reads()
        .lock()
        .unwrap()
        .insert(host.to_string(), Instant::now());
}

pub fn cf_clear_browser_failure(host: &str) {
    failed_browser_reads().lock().unwrap().remove(host);
}

pub fn cf_security_page_reason(body: &str) -> Option<&'static str> {
    if crate::source_challenge::is_dle_guard_page(body) {
        return Some("DLE Guard verification");
    }
    // Security-page signatures belong near the document start. Limit scanning
    // to avoid misclassifying ordinary articles *mentioning* these challenges.
    let prefix = &body[..body
        .char_indices()
        .nth(24_000)
        .map_or(body.len(), |(i, _)| i)];
    let lower = prefix.to_ascii_lowercase();
    if (lower.contains("protected by anubis") && lower.contains("access denied"))
        || (lower.contains("oh noes!") && lower.contains("access denied: error code"))
        || (lower.contains("anubis") && lower.contains("access denied: error code"))
    {
        return Some("Anubis access denied");
    }
    if (lower.contains("protected by anubis") || lower.contains("/.within.website/x/cmd/anubis/"))
        && (lower.contains("making sure you're not a bot")
            || lower.contains("proof-of-work")
            || lower.contains("proof of work"))
    {
        return Some("Anubis verification");
    }
    if lower.contains("cf_chl_opt")
        || (lower.contains("/cdn-cgi/challenge-platform/")
            && (lower.contains("<title>just a moment")
                || lower.contains("<title>attention required")))
        || lower.contains("sorry, you have been blocked")
        || lower.contains("error code: 1020")
    {
        return Some("Cloudflare challenge or access denied");
    }
    None
}

fn window_is_on_host(url: &Url, host: &str) -> bool {
    url.scheme() == "https" && url.host_str() == Some(host)
}

pub fn cf_browser_ready_for(app: &AppHandle, host: &str) -> bool {
    cf_browser_ready(host)
        && app
            .get_webview_window(SOLVER_LABEL)
            .and_then(|window| window.url().ok())
            .is_some_and(|url| window_is_on_host(&url, host))
}

// While a verified image window navigates back to the source to preserve
// Referer, its current URL is not on the image host. Only image fetches may
// use this readiness state, and the returned image is independently verified.
fn image_session_owner() -> &'static Mutex<Option<String>> {
    static OWNER: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    OWNER.get_or_init(|| Mutex::new(None))
}

pub fn cf_image_browser_ready_for(app: &AppHandle, host: &str) -> bool {
    cf_browser_ready(host)
        && image_session_owner().lock().unwrap().as_deref() == Some(host)
        && app.get_webview_window(IMAGE_SOLVER_LABEL).is_some()
}

fn browser_sessions() -> &'static Mutex<HashMap<String, BrowserSession>> {
    static S: OnceLock<Mutex<HashMap<String, BrowserSession>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cf_browser_ready(host: &str) -> bool {
    browser_sessions()
        .lock()
        .unwrap()
        .get(host)
        .is_some_and(|session| session.at.elapsed() < CF_TTL)
}

fn cf_browser_mark_ready(host: &str) {
    browser_sessions()
        .lock()
        .unwrap()
        .insert(host.to_string(), BrowserSession { at: Instant::now() });
    cf_clear_browser_failure(host);
}

fn cf_cache() -> &'static Mutex<HashMap<String, CfEntry>> {
    static C: OnceLock<Mutex<HashMap<String, CfEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn solver_cooldown() -> &'static Mutex<HashMap<String, Instant>> {
    static C: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn solver_cooldown_active(host: &str) -> bool {
    let mut active = solver_cooldown().lock().unwrap();
    active.retain(|_, time| time.elapsed() < SOLVER_RETRY_COOLDOWN);
    active.contains_key(host)
}

fn note_solver_cooldown(host: &str) {
    solver_cooldown()
        .lock()
        .unwrap()
        .insert(host.to_owned(), Instant::now());
}

fn clear_solver_cooldown(host: &str) {
    solver_cooldown().lock().unwrap().remove(host);
}

// Bot-management cookies alone are not clearance. DLE Guard uses its own
// trust cookie independently of Cloudflare.
fn is_clearance_cookie(name: &str) -> bool {
    name == "cf_clearance" || name == "__guard_trust"
}

pub fn cf_cached(host: &str) -> Option<(String, String)> {
    let cache = cf_cache().lock().unwrap();
    let entry = cache.get(host)?;
    if entry.at.elapsed() > CF_TTL {
        return None;
    }
    Some((entry.cookie.clone(), entry.ua.clone()))
}

pub fn cf_invalidate(host: &str) {
    cf_cache().lock().unwrap().remove(host);
}

fn solver_starts_visible(label: &str) -> bool {
    label != IMAGE_SOLVER_LABEL
}

/// Must already be on the main thread. Topmost is set before the window is shown
/// because Windows refuses SetForegroundWindow to a process that does not own the
/// current foreground window, which left the check sitting behind Harbor.
fn raise_window(w: &tauri::WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.set_always_on_top(true);
    let _ = w.show();
    let _ = w.set_focus();
}

struct SolverDismiss(AppHandle, bool, &'static str);

impl Drop for SolverDismiss {
    fn drop(&mut self) {
        if !self.1 {
            return;
        }
        if let Some(w) = self.0.get_webview_window(self.2) {
            let _ = w.set_always_on_top(false);
            let _ = w.hide();
        }
    }
}

fn harvest(app: &AppHandle, label: &str, url: &str, ua: &str, require_guard: bool) -> bool {
    let Some(win) = app.get_webview_window(label) else {
        return false;
    };
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str().map(|s| s.to_string()) else {
        return false;
    };
    if ua.is_empty() {
        return false;
    }
    let cookies = match win.cookies_for_url(parsed) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[cf] cookie read failed: {e}");
            return false;
        }
    };
    let mut parts: Vec<String> = Vec::new();
    let mut has_clearance = false;
    let mut has_guard = false;
    for c in cookies {
        let name = c.name();
        has_guard |= name == "__guard_trust" && !c.value().is_empty();
        if is_clearance_cookie(name) && !c.value().is_empty() {
            has_clearance = true;
        }
        parts.push(format!("{}={}", name, c.value()));
    }
    if !has_clearance || (require_guard && !has_guard) {
        return false;
    }
    let cookie = parts.join("; ");
    cf_cache().lock().unwrap().insert(
        host.clone(),
        CfEntry {
            cookie,
            ua: ua.to_string(),
            at: Instant::now(),
        },
    );
    eprintln!("[cf] harvested clearance for {}", host);
    true
}

// Native WebView evaluation avoids exposing Harbor IPC to arbitrary Cloudflare
// pages. Do not grant remote HTTP(S) origins Tauri command permissions.
const PROBE_SCRIPT: &str = r#"(() => {
  const title = (document.title || '').toLowerCase();
  const present = (selector) => {
    const el = document.querySelector(selector);
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  };
  const sample = (document.body?.innerText || '').slice(0, 1800).toLowerCase();
  const markup = (document.documentElement?.outerHTML || '').slice(0, 16000).toLowerCase();
  const anubis = (markup.includes('protected by anubis') ||
                  markup.includes('/.within.website/x/cmd/anubis/'));
  const denied = (anubis && sample.includes('access denied')) ||
    (title.includes('oh noes') && sample.includes('access denied')) ||
    (sample.includes('sorry, you have been blocked') &&
     title.includes('access denied')) ||
    (title.includes('error 403 (forbidden)') && sample.includes('permission to access'));
  const securityPage =
    denied || (anubis && (sample.includes('making sure you') ||
                          sample.includes('proof of work')));
  const navigationStatus = performance.getEntriesByType('navigation')[0]?.responseStatus || 0;
  const challenged =
    (navigationStatus >= 400 && navigationStatus !== 401) ||
    (markup.includes('pow_nonce') && (markup.includes('/_c') || markup.includes('/_v'))) ||
    securityPage ||
    title.includes('just a moment') || title.includes('attention required') ||
    title.includes('access denied') || title.includes('403 forbidden') ||
    sample.includes('sorry, you have been blocked') ||
    sample.includes('you are being rate limited') || sample.includes('error code: 1020') ||
    sample.includes('error 1015') ||
    present('#challenge-form, #challenge-running, #cf-challenge-running, #cf-please-wait') ||
    (present('.cf-turnstile') && !!document.querySelector('#challenge-form, #challenge-running'));
  // An empty/placeholder document is not evidence of a successful challenge.
  const usable = !!(document.body && (document.documentElement?.outerHTML.length >= 200 ||
    (document.contentType?.startsWith('image/') &&
     !!document.querySelector('img')?.naturalWidth)));
  return {
    host: location.hostname || '',
    protocol: location.protocol || '',
    ready: document.readyState || '',
    challenged: !!challenged,
    denied: !!denied,
    usable,
    authentication_required: (performance.getEntriesByType('navigation')[0]?.responseStatus === 401),
    user_agent: navigator.userAgent || ''
  };
})()"#;

#[derive(Clone, Debug, Deserialize)]
struct PageProbe {
    host: String,
    protocol: String,
    ready: String,
    challenged: bool,
    denied: bool,
    usable: bool,
    authentication_required: bool,
    user_agent: String,
}

fn probe_is_ready(probe: &PageProbe, target: &Url) -> bool {
    probe
        .host
        .eq_ignore_ascii_case(target.host_str().unwrap_or(""))
        && probe.protocol == target.scheme().to_string() + ":"
        && probe.ready == "complete"
        && !probe.challenged
        && !probe.authentication_required
        && probe.usable
        && !probe.user_agent.is_empty()
}

async fn probe_page(window: &WebviewWindow) -> Result<Option<PageProbe>, String> {
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    window
        .eval_with_callback(PROBE_SCRIPT, move |value| {
            if let Ok(mut sender) = sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(value);
                }
            }
        })
        .map_err(|error| format!("probe injection: {error}"))?;
    let raw = match tokio::time::timeout(Duration::from_secs(3), receiver).await {
        Ok(Ok(raw)) => raw,
        _ => return Ok(None),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| format!("probe decode: {error}"))
}

/// Only ordinary, same-origin text requests can use the already verified WebView.
/// This avoids Cloudflare browser-fingerprint mismatches without exposing native IPC.
pub struct BrowserTextResponse {
    pub status: u16,
    pub body: String,
    pub content_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum BrowserRead {
    Ready {
        status: u16,
        body: String,
        content_type: String,
    },
    Error {
        reason: String,
    },
}

const MAX_BROWSER_TEXT_BYTES: usize = 2 * 1024 * 1024;

fn browser_request_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

// If a same-origin JavaScript fetch is challenged again, a top-level browser
// navigation may still work with its WebView2 fingerprint. Return the actual
// document only after its address and page probe are both verified.
async fn browser_navigation_fetch(
    window: &WebviewWindow,
    target: &Url,
) -> Result<Option<BrowserTextResponse>, String> {
    let current = window
        .url()
        .map_err(|error| format!("browser window address: {error}"))?;
    if target.scheme() != "https" || current.origin() != target.origin() {
        return Ok(None);
    }
    // A verified document can work even when fetch/reloading is rejected.
    // Keep it intact when it is already the exact requested resource.
    if current != *target {
        window
            .navigate(target.clone())
            .map_err(|error| format!("browser navigate: {error}"))?;
    } else {
    }
    let read = format!(
        r#"(() => {{
          if (location.href !== {} || document.readyState !== 'complete') return null;
          const title = (document.title || '').toLowerCase();
          const text = (document.body?.innerText || '').slice(0, 1200).toLowerCase();
          const navigationStatus = performance.getEntriesByType('navigation')[0]?.responseStatus || 0;
          if (title.includes('401 unauthorized') || title === 'unauthorized' ||
              title === 'authentication required')
            return {{state:'error',reason:'navigation-unauthorized-title'}};
          if (navigationStatus >= 400)
            return {{state:'error',reason:'navigation-http-' + navigationStatus}};
          if (title.includes('just a moment') || title.includes('attention required') ||
              title.includes('access denied') || text.includes('sorry, you have been blocked') ||
              text.includes('error code: 1020') || text.includes('error 1015') ||
              document.querySelector('#challenge-form, #challenge-running, #cf-please-wait'))
            return null;
          const html = document.documentElement?.outerHTML || '';
          if (html.length < 200 || html.length > {}) return null;
          return {{state:'ready',status:200,content_type:'text/html; charset=utf-8',body:html}};
        }})()"#,
        serde_json::to_string(target.as_str()).map_err(|error| error.to_string())?,
        MAX_BROWSER_TEXT_BYTES
    );
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let current = match window.url() {
            Ok(url) => url,
            Err(_) => break,
        };
        if current.origin() != target.origin() {
            break;
        }
        if current != *target {
            continue;
        }
        let Some(probe) = probe_page(window).await? else {
            continue;
        };
        if !probe_is_ready(&probe, target) {
            continue;
        }
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        window
            .eval_with_callback(&read, move |json| {
                if let Ok(mut sender) = tx.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(json);
                    }
                }
            })
            .map_err(|error| format!("browser document: {error}"))?;
        let raw = match tokio::time::timeout(Duration::from_secs(3), rx).await {
            Ok(Ok(body)) => body,
            _ => continue,
        };
        let result = serde_json::from_str::<Option<BrowserRead>>(&raw);
        if let Ok(Some(BrowserRead::Error { .. })) = &result {

            return Ok(None);
        }
        if let Ok(Some(BrowserRead::Ready {
            status,
            body,
            content_type,
        })) = result
        {
            if status == 200 && body.len() <= MAX_BROWSER_TEXT_BYTES {
                if let Some(reason) = cf_security_page_reason(&body) {
                    eprintln!("[cf] navigation produced another protection page: {reason}");
                    return Ok(None);
                }
                eprintln!(
                    "[cf] browser navigation returned verified HTML ({} bytes)",
                    body.len()
                );
                return Ok(Some(BrowserTextResponse {
                    status,
                    body,
                    content_type: Some(content_type),
                }));
            }
        }
    }
    Ok(None)
}

pub async fn cf_browser_fetch(
    app: &AppHandle,
    args: &crate::http_fetch::HarborFetchArgs,
    _request_id: uuid::Uuid,
) -> Result<Option<BrowserTextResponse>, String> {
    let Some(request) = crate::http_fetch::browser_request(args) else {
        return Ok(None);
    };
    let url = args.url.as_str();
    let target = Url::parse(url).map_err(|error| format!("url: {error}"))?;
    if target.scheme() != "https" || target.username() != "" || target.password().is_some() {
        return Ok(None);
    }
    let host = target.host_str().ok_or("browser fallback has no host")?;
    if cf_cached(host).is_none() && !cf_browser_ready_for(app, host) {
        return Ok(None);
    }
    let _browser_guard = browser_request_lock().lock().await;
    // Requests queued before a failed recovery must observe its cooldown too.
    if cf_browser_cooling_down(host) {
        return Err("source browser request is cooling down after a failed verification".into());
    }
    let Some(window) = app.get_webview_window(SOLVER_LABEL) else {
        return Ok(None);
    };
    let current = window
        .url()
        .map_err(|error| format!("browser window address: {error}"))?;
    if current.origin() != target.origin() {
        return Ok(None);
    }
    let Some(probe) = probe_page(&window).await? else {
        return Ok(None);
    };
    if !probe_is_ready(&probe, &target) {
        return Ok(None);
    }

    // Use a fresh per-request key: multiple requests can share the same hidden WebView.
    static REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = REQUEST_ID
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        .to_string();
    let script = format!(
        r#"
      (() => {{
        const key = {};
        const address = {};
        const cap = {};
        const request = {};
        const allowNavigation = {};
        const results = window.__harborCfBrowserResults ||= Object.create(null);
        results[key] = null;
        (async () => {{
          let controller = new AbortController();
          let timer = setTimeout(() => controller.abort(), 15000);
          try {{
            if (new URL(address).origin !== location.origin) throw Error('origin');
            const response = await fetch(address, {{
              ...request,
              credentials: 'include',
              redirect: 'error',
              cache: 'no-store',
              signal: controller.signal
            }});
            if (response.headers.get('cf-mitigated') === 'challenge')
              throw Error('challenged');
            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            if (response.status === 204) {{
              results[key] = {{state: 'ready', status: 204, content_type: contentType, body: ''}};
              return;
            }}
            if (!(/text\/|json|xml|javascript/.test(contentType)))
              throw Error('non-text');
            if (Number(response.headers.get('content-length') || 0) > cap)
              throw Error('too-large');
            if (!response.body) throw Error('empty');
            let reader = response.body.getReader();
            let decoder = new TextDecoder();
            let body = '', bytes = 0;
            try {{
              while (true) {{
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > cap) throw Error('too-large');
                body += decoder.decode(chunk.value, {{ stream: true }});
              }}
              body += decoder.decode();
            }} finally {{ reader.cancel().catch(() => {{}}); reader.releaseLock(); }}
            const start = body.slice(0, 48000).toLowerCase();
            if (contentType.includes('html') &&
                (/<title[^>]*>\s*(just a moment|attention required)|cf_chl_opt/i.test(start) ||
                 ((start.includes('protected by anubis') ||
                   start.includes('/.within.website/x/cmd/anubis/')) &&
                  (start.includes('access denied') || start.includes('making sure you') ||
                   start.includes('proof of work'))) ||
                 (start.includes('oh noes!') && start.includes('access denied: error code'))))
              throw Error('protected-page');
            results[key] = {{state: 'ready', status: response.status, content_type: contentType, body}};
          }} catch (error) {{
            // A completed interstitial can provide the requested HTML document even
            // if its JS-fetches are challenged again. Only use the exact loaded URL.
            const title = (document.title || '').toLowerCase();
            const html = document.documentElement?.outerHTML || '';
            const start = html.slice(0, 48000).toLowerCase();
            const protectedPage = title.includes('just a moment') ||
              title.includes('attention required') || title.includes('access denied') ||
              (start.includes('oh noes!') && start.includes('access denied')) ||
              start.includes('cf_chl_opt') ||
              ((start.includes('protected by anubis') ||
                start.includes('/.within.website/x/cmd/anubis/')) &&
               (start.includes('access denied') || start.includes('making sure you') ||
                start.includes('proof of work')));
            const pageReady = document.readyState === 'complete' && !protectedPage &&
              (performance.getEntriesByType('navigation')[0]?.responseStatus || 0) < 400 &&
              !title.includes('401 unauthorized') && title !== 'unauthorized' &&
              title !== 'authentication required' &&
              !document.querySelector('#challenge-form, #challenge-running, #cf-please-wait');
            if (allowNavigation && pageReady && location.href === address && html.length > 200 && html.length <= cap)
              results[key] = {{state: 'ready', status: 200, content_type: 'text/html; charset=utf-8', body: html}};
            else results[key] = {{state: 'error', reason: String(error?.message || 'browser fetch failed').slice(0, 48)}};
          }} finally {{ clearTimeout(timer); }}
        }})();
      }})()
    "#,
        serde_json::to_string(&id).map_err(|e| e.to_string())?,
        serde_json::to_string(url).map_err(|e| e.to_string())?,
        MAX_BROWSER_TEXT_BYTES,
        serde_json::to_string(&request).map_err(|error| error.to_string())?,
        request.allows_navigation()
    );
    window
        .eval(&script)
        .map_err(|error| format!("browser request: {error}"))?;

    let read_script = format!(
        "(() => {{ const map = window.__harborCfBrowserResults; const key = {}; if (!map || !map[key]) return null; const value = map[key]; delete map[key]; return value; }})()",
        serde_json::to_string(&id).map_err(|e| e.to_string())?
    );
    let deadline = Instant::now();
    while deadline.elapsed() < Duration::from_secs(19) {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sender, receiver) = oneshot::channel();
        let sender = Mutex::new(Some(sender));
        if window
            .eval_with_callback(&read_script, move |value| {
                if let Ok(mut sender) = sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(value);
                    }
                }
            })
            .is_err()
        {
            return Ok(None);
        }
        let raw = match tokio::time::timeout(Duration::from_secs(2), receiver).await {
            Ok(Ok(value)) => value,
            _ => continue,
        };
        match serde_json::from_str::<Option<BrowserRead>>(&raw) {
            Ok(Some(BrowserRead::Ready {
                status,
                body,
                content_type,
            })) if (200..600).contains(&status) && body.len() <= MAX_BROWSER_TEXT_BYTES => {
                // HTML fetches may be denied even when top-level browsing works.
                // Preserve the original error if navigation cannot verify content;
                // API requests must never be replaced with a document response.
                if request.recovers_html_status(status, &content_type) {
                    if let Ok(Some(document)) = browser_navigation_fetch(&window, &target).await {
                        return Ok(Some(document));
                    }
                }
                if content_type.contains("html") {
                    if let Some(reason) = cf_security_page_reason(&body) {
                        eprintln!("[cf] browser fetch produced another protection page: {reason}");
                        return Ok(None);
                    }
                }

                if matches!(status, 401 | 403) {
                    cf_note_browser_failure(host);
                }
                return Ok(Some(BrowserTextResponse {
                    status,
                    body,
                    content_type: Some(content_type),
                }));
            }
            Ok(Some(BrowserRead::Error { reason })) => {
                eprintln!("[cf] browser fetch unavailable: {reason}");
                // Only HTML-compatible requests can be fulfilled by browsing to
                // the destination. Never turn a JSON/API request into HTML.
                if request.allows_navigation()
                    && (reason == "challenged" || reason == "protected-page" || reason == "empty")
                {
                    return browser_navigation_fetch(&window, &target).await;
                }
                return Ok(None);
            }
            Ok(Some(_)) => return Ok(None),
            _ => {}
        }
    }
    eprintln!("[cf] browser fallback timed out");
    Ok(None)
}

// Only chapter images explicitly opted into recovery can be read through the
// verified same-origin WebView. Remote pages never receive Harbor IPC rights.
// Image documents on signed CDNs often allow a top-level navigation from the
// source site while rejecting a JS fetch from the image host itself. Keep the
// verification and per-page navigation in a dedicated WebView, never in Harbor's
// privileged app window or the unrelated text-source solver.
const IMAGE_READ_TTL: Duration = Duration::from_secs(75);
const MAX_CACHED_IMAGE_BYTES: usize = 48 * 1024 * 1024;
const MAX_IMAGE_CACHE_ENTRIES: usize = 8;

fn image_request_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

struct CachedBrowserImage {
    at: Instant,
    content_type: String,
    body: String,
    bytes: usize,
}

fn browser_image_cache() -> &'static Mutex<HashMap<String, CachedBrowserImage>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedBrowserImage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn image_response(url: &str, content_type: String, body: String) -> crate::http_fetch::HarborFetchResponse {
    crate::http_fetch::HarborFetchResponse {
        status: 200,
        ok: true,
        body,
        asset_path: None,
        content_type: Some(content_type.clone()),
        headers: HashMap::from([("content-type".to_string(), content_type)]),
        url: Some(url.to_string()),
    }
}

fn cached_browser_image(url: &str, cap: u64) -> Option<crate::http_fetch::HarborFetchResponse> {
    let mut cache = browser_image_cache().lock().unwrap();
    cache.retain(|_, entry| entry.at.elapsed() <= IMAGE_READ_TTL);
    let entry = cache.get(url)?;
    // Preserve the native image size contract even on cached Base64 responses.
    if entry.bytes as u64 > cap {
        return None;
    }
    Some(image_response(url, entry.content_type.clone(), entry.body.clone()))
}

fn cache_browser_image(response: &crate::http_fetch::HarborFetchResponse) {
    if response.body.len() > MAX_CACHED_IMAGE_BYTES / 4 {
        return;
    }
    let Some(url) = response.url.as_deref() else { return };
    let mut cache = browser_image_cache().lock().unwrap();
    cache.retain(|_, entry| entry.at.elapsed() <= IMAGE_READ_TTL);
    let padding = response.body.as_bytes().iter().rev().take_while(|byte| **byte == b'=').count();
    let bytes = (response.body.len() / 4) * 3 - padding;
    cache.insert(url.to_owned(), CachedBrowserImage {
        at: Instant::now(),
        content_type: response.content_type.clone().unwrap_or_else(|| "image/png".into()),
        body: response.body.clone(),
        bytes,
    });
    // Bound memory usage, even if the user rapidly switches manga chapters.
    while cache.len() > MAX_IMAGE_CACHE_ENTRIES
        || cache.values().map(|entry| entry.body.len()).sum::<usize>() > MAX_CACHED_IMAGE_BYTES
    {
        let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.at).map(|(key, _)| key.clone()) else { break };
        cache.remove(&oldest);
    }
}

async fn read_navigated_image(
    window: &WebviewWindow,
    target: &Url,
    cap: u64,
    _request_id: uuid::Uuid,
) -> Result<Option<crate::http_fetch::HarborFetchResponse>, String> {
    if window.url().ok().is_none_or(|address| address != *target) {
        return Ok(None);
    }
    // Read only the exact image document already navigated to. Capturing its
    // pixels avoids CORS and never allows remote pages to invoke Harbor IPC.
    let script = r#"(() => {
      const address = __ADDRESS__;
      const cap = __CAP__;
      try {
        if (location.href !== address || !document.contentType?.startsWith('image/'))
          return null;
        const img = document.querySelector('img');
        if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight ||
            img.naturalWidth * img.naturalHeight > 16000000)
          return null;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0);
        const data = canvas.toDataURL('image/png').split(',')[1];
        if (!data || data.length > Math.ceil(cap / 3) * 4 + 8)
          return null;
        return { state: 'ready', status: 200, content_type: 'image/png', body: data };
      } catch (_) { return null; }
    })()"#
        .replace("__ADDRESS__", &serde_json::to_string(target.as_str()).map_err(|e| e.to_string())?)
        .replace("__CAP__", &cap.to_string());
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    window.eval_with_callback(&script, move |raw| {
        if let Ok(mut sender) = sender.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(raw);
            }
        }
    }).map_err(|error| format!("image read: {error}"))?;
    let raw = match tokio::time::timeout(Duration::from_secs(8), receiver).await {
        Ok(Ok(raw)) => raw,
        _ => return Ok(None),
    };
    let Ok(Some(BrowserRead::Ready { status: 200, body, content_type })) =
        serde_json::from_str::<Option<BrowserRead>>(&raw)
    else { return Ok(None) };
    if content_type != "image/png" || body.len() > ((cap as usize + 2) / 3) * 4 + 8 {
        return Ok(None);
    }
    let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, body.as_bytes())
    else { return Ok(None) };
    if bytes.is_empty() || bytes.len() as u64 > cap
        || image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png)
    {
        return Ok(None);
    }
    Ok(Some(image_response(target.as_str(), content_type, body)))
}

async fn navigate_image_from_source(
    window: &WebviewWindow,
    target: &Url,
    source: &Url,
    _request_id: uuid::Uuid,
) -> Result<bool, String> {
    // Returning to the original page is necessary for a valid Referer:
    // document-to-document navigation on the image CDN is not equivalent.
    window.navigate(source.clone()).map_err(|error| format!("image referrer navigation: {error}"))?;
    let start = Instant::now();
    let mut source_ready = false;
    while start.elapsed() < Duration::from_secs(12) {
        tokio::time::sleep(Duration::from_millis(250)).await;
        match probe_page(window).await {
            Ok(Some(probe)) if probe_is_ready(&probe, source)
                && window.url().ok().is_some_and(|address| address.origin() == source.origin()) =>
            {
                source_ready = true;
                break;
            }
            Ok(Some(probe)) if probe.denied => break,
            _ => {}
        }
    }
    if !source_ready {
        return Ok(false);
    }
    let address = serde_json::to_string(target.as_str()).map_err(|error| error.to_string())?;
    let script = format!(
        "(() => {{ const link = document.createElement('a'); link.href = {address}; link.referrerPolicy = 'no-referrer-when-downgrade'; document.body.appendChild(link); link.click(); }})()"
    );
    window.eval(&script).map_err(|error| format!("image browser link: {error}"))?;

    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(14) {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if window.url().ok().is_some_and(|address| address == *target) {
            match probe_page(window).await {
                Ok(Some(probe)) if probe_is_ready(&probe, target) => return Ok(true),
                Ok(Some(probe)) if probe.denied => break,
                _ => {}
            }
        }
    }
    Ok(false)
}

pub async fn cf_browser_fetch_image(
    app: &AppHandle,
    args: &crate::http_fetch::HarborFetchArgs,
    request_id: uuid::Uuid,
) -> Result<Option<crate::http_fetch::HarborFetchResponse>, String> {
    let target = Url::parse(&args.url).map_err(|error| format!("image url: {error}"))?;
    let host = target.host_str().ok_or("image URL has no host")?;
    let cap = args.max_response_bytes.unwrap_or(0);
    if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some()
        || args.allow_image_challenge != Some(true) || cap == 0 || cap > 32 * 1024 * 1024
        || args.response_type.as_deref() != Some("base64")
        || !args.method.as_deref().unwrap_or("GET").eq_ignore_ascii_case("GET")
        || args.body.is_some() || args.body_base64.is_some()
        || args.credential_handle.is_some() || args.allow_local_network == Some(true)
        || args.public_network_only == Some(true) || args.follow_redirects == Some(false)
    {
        return Ok(None);
    }
    let referrer = args.headers.as_ref()
        .and_then(|headers| headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("referer")))
        .and_then(|(_, value)| Url::parse(value).ok());
    let Some(source) = referrer else { return Ok(None) };
    if source.scheme() != "https" || !source.username().is_empty() || source.password().is_some() {
        return Ok(None);
    }
    if let Some(response) = cached_browser_image(target.as_str(), cap) {
        return Ok(Some(response));
    }
    if !cf_image_browser_ready_for(app, host) {
        return Ok(None);
    }
    // The image WebView can be temporarily navigating through the source
    // domain, so host-readiness must not depend on its current URL.
    let _guard = image_request_lock().lock().await;
    if let Some(response) = cached_browser_image(target.as_str(), cap) {
        return Ok(Some(response));
    }
    if !cf_image_browser_ready_for(app, host) {
        return Ok(None);
    }
    let Some(window) = app.get_webview_window(IMAGE_SOLVER_LABEL) else { return Ok(None) };
    let current = window.url().map_err(|error| format!("image window address: {error}"))?;
    // Only a source page belonging to this request may be used to navigate.
    if current.origin() != target.origin() && current.origin() != source.origin() {
        return Ok(None);
    }
    if let Some(response) = read_navigated_image(&window, &target, cap, request_id).await? {
        cache_browser_image(&response);
        return Ok(Some(response));
    }
    // This follows a caller-supplied referrer, not a server redirect. Validate
    // its public destination before navigating the separate WebView.
    if crate::http_fetch::public_http_client(&source).await.is_err() {
        return Ok(None);
    }
    // The previously verified image URL is not proof that other signed image
    // paths will accept a same-origin fetch. Re-enter from the source for each.
    if !navigate_image_from_source(&window, &target, &source, request_id).await? {
        return Ok(None);
    }
    let response = read_navigated_image(&window, &target, cap, request_id).await?;
    if let Some(response) = response.as_ref() {
        cache_browser_image(response);
    }
    Ok(response)
}

fn open_solver(app: &AppHandle, url: &str, label: &'static str) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(label) {
        eprintln!("[cf] reusing solver window");
        let target = Url::parse(url).map_err(|error| format!("url: {error}"))?;
        // Hide an earlier interactive image window before navigating to the
        // next chapter host; do not flash its old contents over the reader.
        if !solver_starts_visible(label) {
            let w = existing.clone();
            let _ = app.run_on_main_thread(move || { let _ = w.hide(); });
        }
        // Native navigation still works if the challenge page has disabled scripts.
        existing
            .navigate(target)
            .map_err(|error| format!("solver navigation: {error}"))?;
        if solver_starts_visible(label) {
            let w = existing.clone();
            let _ = app.run_on_main_thread(move || raise_window(&w));
        }
        return Ok(());
    }

    let parsed = Url::parse(url).map_err(|e| format!("url: {e}"))?;
    let app_main = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let builder =
            WebviewWindowBuilder::new(&app_main, label, WebviewUrl::External(parsed))
                .title("Harbor · checking source")
                .incognito(false)
                .inner_size(480.0, 640.0)
                .center()
                .resizable(true)
                .decorations(true)
                .shadow(true)
                .visible(solver_starts_visible(label))
                .focused(solver_starts_visible(label))
                .on_page_load(|_, payload| {
                    let phase =
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            "finished"
                        } else {
                            "started"
                        };
                    eprintln!("[cf] WebView navigation {phase}");
                });
        let built = crate::browser_args::match_main(&app_main, builder).build();
        match built {
            Ok(window) => {
                window.on_window_event(|event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    ) {
                        eprintln!("[cf] solver window closed");
                        // cf_fetch owns the active hostname and applies its own
                        // cooldown on close. Do not cool down an unrelated host.
                        if let Some(tx) = PENDING.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                    }
                });
                if solver_starts_visible(label) {
                    raise_window(&window);
                }
                let _ = tx.send(Ok(()));
            }
            Err(e) => {
                eprintln!("[cf] build FAILED: {e}");
                let _ = tx.send(Err(format!("build: {e}")));
            }
        }
    })
    .map_err(|e| format!("main thread: {e}"))?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|e| format!("build wait: {e}"))?
}

pub async fn cf_fetch(app: AppHandle, url: String) -> Result<(), String> {
    cf_fetch_session(app, url, false).await
}

pub async fn cf_fetch_session(
    app: AppHandle,
    url: String,
    require_guard: bool,
) -> Result<(), String> {
    source_session(app, url, require_guard, false, None).await
}

pub async fn cf_fetch_image_session(
    app: AppHandle,
    url: String,
    referrer: String,
    require_guard: bool,
) -> Result<(), String> {
    let origin = reqwest::Url::parse(&referrer).map_err(|_| "invalid image source referrer")?;
    if origin.scheme() != "https" || !origin.username().is_empty() || origin.password().is_some() {
        return Err("image source referrer must be a public HTTPS URL".into());
    }
    // A plugin must not cause verification to navigate into local-network addresses.
    let _ = crate::http_fetch::public_http_client(&origin).await?;
    source_session(app, url, require_guard, false, Some(referrer)).await
}

pub async fn cf_login_session(app: AppHandle, url: String) -> Result<(), String> {
    source_session(app, url, false, true, None).await
}

async fn source_session(
    app: AppHandle,
    url: String,
    require_guard: bool,
    login: bool,
    image_referrer: Option<String>,
) -> Result<(), String> {
    let _guard = request_lock().lock().await;
    // A single WebView is shared by every verified source. A challenge
    // navigation must not interrupt a pending same-origin browser fetch.
    let _browser_guard = browser_request_lock().lock().await;
    // The image WebView has its own navigation lock. Do not interrupt an
    // in-flight page extraction when a second image host needs verification.
    let _image_guard = if image_referrer.is_some() {
        Some(image_request_lock().lock().await)
    } else {
        None
    };
    let host = Url::parse(&url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_string()));
    if let Some(host) = host.as_deref().filter(|_| !login) {
        if cf_cached(host).is_some_and(|(cookie, _)| {
            !require_guard
                || cookie
                    .split(';')
                    .any(|pair| pair.trim().starts_with("__guard_trust="))
        }) {
            eprintln!("[cf] clearance already cached for {host}");
            return Ok(());
        }
        if !require_guard
            && (cf_browser_ready_for(&app, host)
                || (image_referrer.is_some() && cf_image_browser_ready_for(&app, host)))
        {
            eprintln!("[cf] verified browser session already available for {host}");
            return Ok(());
        }
    }
    if image_referrer.is_some() {
        // The dedicated image window is about to be reused for a new host.
        *image_session_owner().lock().unwrap() = None;
    }
    if solver_cooldown_active(host.as_deref().unwrap_or("")) {
        eprintln!("[cf] solver cooling down after a recent failed or closed attempt");
        return Err("cloudflare solver is cooling down".into());
    }
    let (tx, mut closed) = oneshot::channel::<()>();
    *PENDING.lock().unwrap() = Some(tx);

    let solver_label = if image_referrer.is_some() { IMAGE_SOLVER_LABEL } else { SOLVER_LABEL };
    let initial_url = image_referrer.as_deref().unwrap_or(&url);
    if let Err(error) = open_solver(&app, initial_url, solver_label) {
        PENDING.lock().unwrap().take();
        note_solver_cooldown(host.as_deref().unwrap_or(""));
        return Err(error);
    }
    let mut dismiss = SolverDismiss(app.clone(), true, solver_label);
    let Some(window) = app.get_webview_window(solver_label) else {
        PENDING.lock().unwrap().take();
        note_solver_cooldown(host.as_deref().unwrap_or(""));
        return Err("cloudflare solver window missing".into());
    };
    if solver_starts_visible(solver_label) {
        let window_raised = window.clone();
        let _ = app.run_on_main_thread(move || raise_window(&window_raised));
    }

    let target = Url::parse(&url).map_err(|error| format!("url: {error}"))?;
    let start = Instant::now();
    let mut stable_since: Option<Instant> = None;
    let mut referrer_navigation_pending = image_referrer.is_some();
    let mut wrong_origin_since: Option<Instant> = None;
    let mut last_stage = String::new();
    let mut last_diagnostic = Instant::now();
    // Hidden WebViews can stall or encounter a challenge requiring user input.
    // Keep image recovery silent while it succeeds automatically, but retain
    // the existing interactive verification as a last resort.
    let mut image_window_raised = false;
    loop {
        if start.elapsed() >= Duration::from_secs(90) {
            PENDING.lock().unwrap().take();
            note_solver_cooldown(host.as_deref().unwrap_or(""));
            eprintln!("[cf] timeout after 90 seconds; last stage: {last_stage}");
            return Err("cloudflare challenge timed out".into());
        }
        tokio::select! {
            _ = &mut closed => {
                PENDING.lock().unwrap().take();
                note_solver_cooldown(host.as_deref().unwrap_or(""));
                eprintln!("[cf] verification window closed by user");
                return Err("cloudflare solver window was closed".into());
            }
            _ = tokio::time::sleep(Duration::from_millis(800)) => {}
        }
        if image_referrer.is_some()
            && !image_window_raised
            && start.elapsed() >= Duration::from_secs(20)
        {
            let window_to_show = window.clone();
            if app.run_on_main_thread(move || raise_window(&window_to_show)).is_ok() {
                image_window_raised = true;
            }
        }
        match probe_page(&window).await {
            Ok(Some(probe)) => {
                if image_referrer.is_some() && probe.authentication_required && !image_window_raised {
                    let window_to_show = window.clone();
                    if app.run_on_main_thread(move || raise_window(&window_to_show)).is_ok() {
                        image_window_raised = true;
                    }
                }
                // Image CDN challenges must be entered through a browser navigation
                // carrying the source Referer. Native navigation to a signed image
                // is rejected with an unrelated Google 403 on some CDNs.
                if referrer_navigation_pending {
                    if let Some(source) = image_referrer.as_ref().and_then(|value| Url::parse(value).ok()) {
                        if probe_is_ready(&probe, &source) {
                            let address = serde_json::to_string(&url).map_err(|error| error.to_string())?;
                            let script = format!(
                                "(() => {{ const a = document.createElement('a'); a.href = {address}; a.referrerPolicy = 'no-referrer-when-downgrade'; document.body.appendChild(a); a.click(); }})()"
                            );
                            window.eval(&script).map_err(|error| format!("image source navigation: {error}"))?;
                            referrer_navigation_pending = false;
                            stable_since = None;
                            continue;
                        }
                    }
                    if probe.denied {
                        PENDING.lock().unwrap().take();
                        note_solver_cooldown(host.as_deref().unwrap_or(""));
                        return Err("image source referrer was denied".into());
                    }
                    continue;
                }
                if probe.denied {
                    PENDING.lock().unwrap().take();
                    note_solver_cooldown(host.as_deref().unwrap_or(""));
                    eprintln!("[cf] verification stopped: source returned an access-denied page");
                    return Err("source returned an access-denied page".into());
                }
                // A completed redirect to a different host cannot verify this
                // image. Stop instead of displaying a static error for 90 seconds.
                if image_referrer.is_some()
                    && probe.ready == "complete"
                    && !probe.challenged
                    && !probe.host.eq_ignore_ascii_case(target.host_str().unwrap_or(""))
                {
                    let since = wrong_origin_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_secs(3) {
                        PENDING.lock().unwrap().take();
                        note_solver_cooldown(host.as_deref().unwrap_or(""));
                        return Err("image host redirected away from its verification page".into());
                    }
                } else {
                    wrong_origin_since = None;
                }
                if probe.authentication_required {
                    // Keep sign-in available if the foreground request times out.
                    // The site's persistent cookies remain in the WebView profile.
                    dismiss.1 = false;
                    let _ = window.set_title("Harbor - sign in to source, then retry if needed");
                }
                let stage = if probe.authentication_required {
                    "sign-in-required"
                } else if probe.challenged {
                    "challenge"
                } else if probe.ready != "complete" {
                    "loading"
                } else if !probe
                    .host
                    .eq_ignore_ascii_case(target.host_str().unwrap_or(""))
                {
                    "redirected"
                } else {
                    "page-ready"
                };
                if stage != last_stage || last_diagnostic.elapsed() >= Duration::from_secs(10) {
                    eprintln!(
                        "[cf] page stage={stage} ready={} elapsed={}s",
                        probe.ready,
                        start.elapsed().as_secs()
                    );
                    last_stage = stage.to_string();
                    last_diagnostic = Instant::now();
                }
                if probe_is_ready(&probe, &target) {
                    let stable = stable_since.get_or_insert_with(Instant::now);
                    if stable.elapsed() >= Duration::from_secs(2) {
                        let has_cookie = harvest(&app, solver_label, &url, &probe.user_agent, require_guard);
                        if require_guard && !has_cookie {
                            // A DLE challenge needs its trust cookie; a loaded
                            // homepage alone cannot establish native clearance.
                            stable_since = None;
                            continue;
                        }
                        if let Some(host) = host.as_deref() {
                            cf_browser_mark_ready(host);
                            if image_referrer.is_some() {
                                *image_session_owner().lock().unwrap() = Some(host.to_string());
                            }
                            if !has_cookie {
                                eprintln!("[cf] browser page verified for {host}; no transferable clearance cookie; using browser-only session");
                            }
                        }
                        dismiss.1 = true;
                        PENDING.lock().unwrap().take();
                        clear_solver_cooldown(host.as_deref().unwrap_or(""));
                        return Ok(());
                    }
                } else {
                    stable_since = None;
                }
            }
            Ok(None) => {
                if last_diagnostic.elapsed() >= Duration::from_secs(10) {
                    eprintln!(
                        "[cf] waiting for WebView JavaScript evaluation ({}s)",
                        start.elapsed().as_secs()
                    );
                    last_diagnostic = Instant::now();
                }
            }
            Err(error) => {
                if last_diagnostic.elapsed() >= Duration::from_secs(10) {
                    eprintln!("[cf] {error} ({}s)", start.elapsed().as_secs());
                    last_diagnostic = Instant::now();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_image_solver_starts_hidden_but_other_sources_remain_visible() {
        assert!(!solver_starts_visible(IMAGE_SOLVER_LABEL));
        assert!(solver_starts_visible(SOLVER_LABEL));
    }

    #[test]
    fn recovered_image_cache_is_scoped_to_url_and_byte_limit() {
        let url = "https://img.batcave.biz/img/cache-test-unique.jpg?s=unit-test";
        let original = image_response(
            url,
            "image/png".to_string(),
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"hello"),
        );
        cache_browser_image(&original);
        let cached = cached_browser_image(url, 5).expect("expected cached image");
        assert_eq!(cached.status, 200);
        assert_eq!(cached.body, original.body);
        assert!(cached_browser_image(url, 4).is_none());
        assert!(cached_browser_image(
            "https://img.batcave.biz/img/cache-test-different.jpg?s=unit-test", 5
        ).is_none());
    }

    #[test]
    fn browser_session_only_matches_its_current_origin() {
        let page = Url::parse("https://www.royalroad.com/fictions/best-rated").unwrap();
        assert!(window_is_on_host(&page, "www.royalroad.com"));
        assert!(!window_is_on_host(&page, "batcave.biz"));
        assert!(!window_is_on_host(&page, "royalroad.com"));
        assert!(!window_is_on_host(
            &Url::parse("http://www.royalroad.com/").unwrap(),
            "www.royalroad.com"
        ));
    }

    #[test]
    fn secondary_challenges_are_not_accepted_as_content() {
        assert_eq!(
            cf_security_page_reason("<html><title>Oh noes!</title><body>Access Denied: error code abc. Protected by Anubis From Techaro.</body></html>"),
            Some("Anubis access denied")
        );
        assert_eq!(
            cf_security_page_reason(
                "<html><body>Making sure you're not a bot! Protected by Anubis</body></html>"
            ),
            Some("Anubis verification")
        );
        assert_eq!(
            cf_security_page_reason(
                "<html><title>Just a moment...</title><script>window.cf_chl_opt={}</script></html>"
            ),
            Some("Cloudflare challenge or access denied")
        );
        assert_eq!(
            cf_security_page_reason(
                "<html><title>Best rated</title><p>A book about Anubis and Cloudflare</p></html>"
            ),
            None
        );
    }

    #[test]
    fn native_rechallenge_and_browser_failure_are_host_scoped() {
        let host = "cf-guard-test-a.invalid";
        let other = "cf-guard-test-b.invalid";
        cf_note_native_rechallenge(host);
        assert!(cf_prefer_browser(host));
        assert!(!cf_prefer_browser(other));
        cf_note_browser_failure(host);
        assert!(cf_browser_cooling_down(host));
        assert!(!cf_browser_cooling_down(other));
        cf_clear_browser_failure(host);
        assert!(!cf_browser_cooling_down(host));
    }

    #[test]
    fn bot_management_cookie_alone_is_not_clearance() {
        assert!(is_clearance_cookie("cf_clearance"));
        assert!(is_clearance_cookie("__guard_trust"));
        assert!(!is_clearance_cookie("__cf_bm"));
        assert!(!is_clearance_cookie("cf_chl_2"));
        assert!(!is_clearance_cookie("session"));
    }

    #[test]
    fn solver_cooldown_only_applies_to_the_challenged_host() {
        note_solver_cooldown("host-a.example");
        assert!(solver_cooldown_active("host-a.example"));
        assert!(!solver_cooldown_active("host-b.example"));
        clear_solver_cooldown("host-a.example");
        assert!(!solver_cooldown_active("host-a.example"));
    }

    #[test]
    fn browser_only_verification_does_not_fabricate_native_clearance() {
        let host = "browser-only-cloudflare-fixture.invalid";
        cf_browser_mark_ready(host);
        assert!(cf_browser_ready(host));
        assert!(cf_cached(host).is_none());
    }

    #[test]
    fn only_completed_same_origin_non_challenge_pages_are_ready() {
        let target = Url::parse("https://example.org/comics").unwrap();
        let valid = PageProbe {
            host: "example.org".into(),
            protocol: "https:".into(),
            ready: "complete".into(),
            challenged: false,
            denied: false,
            usable: true,
            authentication_required: false,
            user_agent: "Example browser".into(),
        };
        assert!(probe_is_ready(&valid, &target));
        assert!(!probe_is_ready(
            &PageProbe {
                authentication_required: true,
                ..valid.clone()
            },
            &target
        ));
        assert!(!probe_is_ready(
            &PageProbe {
                challenged: true,
                ..valid.clone()
            },
            &target
        ));
        assert!(!probe_is_ready(
            &PageProbe {
                ready: "loading".into(),
                ..valid.clone()
            },
            &target
        ));
        assert!(!probe_is_ready(
            &PageProbe {
                host: "evil.example".into(),
                ..valid.clone()
            },
            &target
        ));
        assert!(!probe_is_ready(
            &PageProbe {
                usable: false,
                ..valid.clone()
            },
            &target
        ));
        assert!(!probe_is_ready(
            &PageProbe {
                user_agent: String::new(),
                ..valid
            },
            &target
        ));
    }
}
