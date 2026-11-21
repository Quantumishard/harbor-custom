mod cache_sweep;
mod dht_boot;
mod lifecycle;
#[cfg(test)]
mod live_tests;
mod netcheck;
mod selftest;
mod stream_route;
mod trackers;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use librqbit::api::TorrentIdOrHash;
use librqbit::dht::Dht;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, PeerConnectionOptions,
    Session,
};
// Only the desktop new_session builds SessionOptions inline. Android gets the
// whole struct back from p2p_android::session_options, so these three would be
// unused imports there.
#[cfg(not(target_os = "android"))]
use librqbit::dht::PersistentDhtConfig;
#[cfg(not(target_os = "android"))]
use librqbit::{SessionOptions, SessionPersistenceConfig};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

fn lifecycle() -> &'static lifecycle::Lifecycle {
    static LIFECYCLE: OnceLock<lifecycle::Lifecycle> = OnceLock::new();
    LIFECYCLE.get_or_init(|| lifecycle::Lifecycle::new(false))
}

struct EngineState {
    session: Option<Arc<Session>>,
    side_dht: Option<Dht>,
    port: Option<u16>,
    dht_tier: u8,
    ready: bool,
    last_error: Option<String>,
    server: Option<tokio::task::JoinHandle<()>>,
    sweeper: Option<CacheSweeper>,
    lan_server: Option<tokio::task::JoinHandle<()>>,
    lan_port: Option<u16>,
    lan_error: Option<String>,
}

fn engine() -> &'static Mutex<EngineState> {
    static S: OnceLock<Mutex<EngineState>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(EngineState {
            session: None,
            side_dht: None,
            port: None,
            dht_tier: 0,
            ready: false,
            last_error: None,
            server: None,
            sweeper: None,
            lan_server: None,
            lan_port: None,
            lan_error: None,
        })
    })
}

pub const LAN_SERVER_PORT: u16 = 11470;
const LAN_FALLBACK_PORTS: [u16; 10] = [
    11480, 11481, 11482, 11483, 11484, 11485, 11486, 11487, 11488, 11489,
];

const CACHE_SWEEP_INITIAL_DELAY_SECS: u64 = 60;
const CACHE_SWEEP_INTERVAL_SECS: u64 = 30 * 60;
const FILE_SELECTION_TIMEOUT_SECS: u64 = 12;
// The side DHT is an extra peer source, not a prerequisite. Waiting on it before
// adding the torrent puts dead DHT time on the player's startup path.
const SIDE_DHT_SEED_BUDGET: Duration = Duration::from_millis(250);
// Prefetch the first 8 MiB so the demuxer probe and the first GOP are ready, and
// the last 2 MiB because MP4 puts the moov atom and MKV often puts its cues at
// the end of the file. Both are requested as soon as the file selection is
// committed, so they overlap player startup instead of waiting for its first
// HTTP request.
const PRIME_HEAD_BYTES: u64 = 8 * 1024 * 1024;
const PRIME_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const PRIME_READ_BUF: usize = 64 * 1024;
const PRIME_TIMEOUT: Duration = Duration::from_secs(30);
static CACHE_SWEEP_RUNNING: AtomicBool = AtomicBool::new(false);

struct CacheSweepGuard;

impl Drop for CacheSweepGuard {
    fn drop(&mut self) {
        CACHE_SWEEP_RUNNING.store(false, Ordering::Release);
    }
}

struct CacheSweeper {
    task: tokio::task::JoinHandle<()>,
    cancelled: Arc<AtomicBool>,
}

impl CacheSweeper {
    fn cancel(self) {
        self.cancelled.store(true, Ordering::Release);
        self.task.abort();
    }
}

fn newest_mtime(paths: &[std::path::PathBuf]) -> Option<std::time::SystemTime> {
    paths
        .iter()
        .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .max()
}

async fn expire_session_torrents(dir: &std::path::Path, retention_hours: u64) -> u64 {
    let Some(session) = current_session() else {
        return 0;
    };
    let now = std::time::SystemTime::now();
    let max_age = Duration::from_secs(retention_hours.saturating_mul(3600));
    let live: Vec<(String, bool, Vec<std::path::PathBuf>)> = session.with_torrents(|torrents| {
        torrents
            .map(|(_id, handle)| {
                let info_hash = format!("{:?}", handle.info_hash());
                let paused = handle.is_paused();
                let paths = handle
                    .with_metadata(|m| {
                        m.file_infos
                            .iter()
                            .map(|fi| dir.join(&fi.relative_filename))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                (info_hash, paused, paths)
            })
            .collect()
    });

    let mut expired = 0_u64;
    for (info_hash, paused, paths) in live {
        // A playing or downloading torrent is never expired; its files are in use.
        if !paused || paths.is_empty() {
            continue;
        }
        let stale = if retention_hours == 0 {
            true
        } else {
            match newest_mtime(&paths) {
                Some(m) => now
                    .duration_since(m)
                    .map(|age| age >= max_age)
                    .unwrap_or(false),
                None => false,
            }
        };
        if !stale {
            continue;
        }
        let Ok(id) = TorrentIdOrHash::parse(&info_hash) else {
            continue;
        };
        match session.delete(id, true).await {
            Ok(()) => expired += 1,
            Err(error) => {
                eprintln!("[torrent-engine] cache sweep could not release {info_hash}: {error:#}")
            }
        }
    }
    expired
}

fn spawn_cache_sweeper(app: AppHandle) -> CacheSweeper {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_for_task = cancelled.clone();
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(CACHE_SWEEP_INITIAL_DELAY_SECS)).await;
        loop {
            if cancelled_for_task.load(Ordering::Acquire) {
                break;
            }
            let cfg = read_config(&app);
            if let Ok(dir) = engine_dir(&app, &cfg) {
                let retention = cfg.retention_hours.unwrap_or(24);
                let max_gb = cfg.max_gb.unwrap_or(0);
                let started = std::time::Instant::now();
                let released = expire_session_torrents(&dir, retention).await;
                if released > 0 {
                    eprintln!(
                        "[torrent-engine] cache sweep released {released} expired torrent(s)"
                    );
                }
                let cancelled_for_sweep = cancelled_for_task.clone();
                // Never delete the cache of a torrent that is still streaming:
                // the sweep only sees file names, so map the active torrents to
                // their first-level cache entries and pass them as protected.
                let protected = active_cache_roots();
                let result = tokio::task::spawn_blocking(move || {
                    if CACHE_SWEEP_RUNNING
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_err()
                    {
                        return None;
                    }
                    let _guard = CacheSweepGuard;
                    Some(cache_sweep::run_with_cancel(
                        &dir,
                        retention,
                        max_gb,
                        &cancelled_for_sweep,
                        &protected,
                    ))
                })
                .await;
                match result {
                    Ok(Some(stats)) => eprintln!(
                        "[torrent-engine] cache sweep completed in {:?}: scanned={} deleted={} reclaimed_bytes={} errors={} cancelled={} first_error={:?}",
                        started.elapsed(),
                        stats.scanned,
                        stats.deleted,
                        stats.reclaimed_bytes,
                        stats.errors,
                        stats.cancelled,
                        stats.first_error,
                    ),
                    Ok(None) => eprintln!("[torrent-engine] cache sweep skipped; another sweep is active"),
                    Err(error) => eprintln!("[torrent-engine] cache sweep task failed: {error}"),
                }
            }
            tokio::time::sleep(Duration::from_secs(CACHE_SWEEP_INTERVAL_SECS)).await;
        }
    });
    CacheSweeper { task, cancelled }
}

pub(crate) fn current_session() -> Option<Arc<Session>> {
    if !lifecycle().is_enabled() {
        return None;
    }
    engine()
        .lock()
        .unwrap()
        .session
        .clone()
        .filter(|session| !session.cancellation_token().is_cancelled())
}

fn current_side_dht() -> Option<Dht> {
    if !lifecycle().is_enabled() {
        return None;
    }
    engine()
        .lock()
        .unwrap()
        .side_dht
        .clone()
        .filter(|dht| !dht.cancellation_token().is_cancelled())
}

/// First path component of every active torrent's files: the engine cache
/// sweep can then skip those entries instead of deleting data a player is using.
fn active_cache_roots() -> Vec<String> {
    let Some(session) = current_session() else {
        return Vec::new();
    };
    session.with_torrents(|torrents| {
        torrents
            .filter(|(_id, handle)| !handle.is_paused())
            .flat_map(|(_id, handle)| {
                handle
                    .with_metadata(|metadata| {
                        metadata
                            .file_infos
                            .iter()
                            .filter_map(|file| {
                                file.relative_filename
                                    .iter()
                                    .next()
                                    .map(|part| part.to_string_lossy().into_owned())
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
    })
}

async fn seed_side_dht(magnet: &str) -> (Vec<SocketAddr>, Duration) {
    let Some(dht) = current_side_dht() else {
        return (Vec::new(), Duration::ZERO);
    };
    if dht_boot::node_count(&dht) == 0 {
        return (Vec::new(), Duration::ZERO);
    }
    let started = Instant::now();
    let peers = dht_boot::seed_peers(&dht, magnet, 40, SIDE_DHT_SEED_BUDGET).await;
    (peers, started.elapsed())
}

async fn run_session<T>(
    session: &Arc<Session>,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let current = current_session().ok_or_else(|| lifecycle::STOPPED.to_string())?;
    if !Arc::ptr_eq(&current, session) {
        return Err(lifecycle::STOPPED.to_string());
    }
    lifecycle::run(session.cancellation_token().clone(), future).await
}

fn current_port() -> Option<u16> {
    current_session()?;
    engine().lock().unwrap().port
}

#[derive(Serialize)]
pub struct EngineStatusDto {
    ready: bool,
    port: Option<u16>,
    active_torrents: usize,
    last_error: Option<String>,
    dht_tier: u8,
    dht_nodes: usize,
}

#[derive(Serialize)]
pub struct EngineFile {
    idx: usize,
    name: String,
    length: u64,
}

#[derive(Serialize)]
pub struct AddResult {
    info_hash: String,
    files: Vec<EngineFile>,
    stream_base: String,
    already_managed: bool,
}

#[derive(Serialize)]
pub struct TorrentEngineStats {
    peers: usize,
    unchoked: usize,
    downloaded: u64,
    #[serde(rename = "downloadSpeed")]
    download_speed: u64,
    #[serde(rename = "streamProgress")]
    stream_progress: u64,
    #[serde(rename = "streamLen")]
    stream_len: u64,
    #[serde(rename = "peerSearchRunning")]
    peer_search_running: bool,
    finished: bool,
    state: String,
}

#[cfg(target_os = "android")]
async fn new_session(
    dir: &std::path::Path,
    full: bool,
    dht: bool,
    persist_dht: bool,
    cancellation: CancellationToken,
) -> Result<Arc<Session>, String> {
    let guard = cancellation.clone().drop_guard();
    let mut options =
        crate::p2p_android::session_options(dir, full, dht, persist_dht, trackers::fallback_url_set());
    options.cancellation_token = Some(cancellation);
    let session = Session::new_with_opts(dir.to_path_buf(), options)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let _ = guard.disarm();
    Ok(session)
}

#[cfg(not(target_os = "android"))]
async fn new_session(
    dir: &std::path::Path,
    full: bool,
    dht: bool,
    persist_dht: bool,
    cancellation: CancellationToken,
) -> Result<Arc<Session>, String> {
    let guard = cancellation.clone().drop_guard();
    let session = Session::new_with_opts(
        dir.to_path_buf(),
        SessionOptions {
            cancellation_token: Some(cancellation),
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(dir.to_path_buf()),
            }),
            disable_dht: !dht,
            disable_dht_persistence: !persist_dht,
            dht_config: persist_dht.then(|| PersistentDhtConfig {
                config_filename: Some(dir.join("dht.json")),
                dump_interval: None,
            }),
            // No session-wide tracker set: every torrent carries its stream's own
            // trackers (or the curated fallback), so junk peers from unrelated
            // trackers do not flood the connection queue.
            // Restored (paused) torrents have no per-add peer options, so the
            // session defaults must already use the streaming cadence: short
            // connect attempts and a read/write timeout that fails a stuck peer.
            peer_opts: Some(PeerConnectionOptions {
                connect_timeout: Some(Duration::from_secs(3)),
                read_write_timeout: Some(Duration::from_secs(10)),
                keep_alive_interval: None,
            }),
            listen_port_range: if full { Some(16881..16931) } else { None },
            enable_upnp_port_forwarding: full,
            ..Default::default()
        },
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    let _ = guard.disarm();
    Ok(session)
}

async fn pause_all_torrents(session: &Arc<Session>) {
    let handles = session.with_torrents(|torrents| {
        torrents
            .map(|(_id, handle)| handle.clone())
            .collect::<Vec<_>>()
    });
    for handle in handles {
        if handle.is_paused() {
            continue;
        }
        if let Err(error) = session.pause(&handle).await {
            eprintln!("[torrent-engine] could not pause restored torrent: {error:#}");
        }
    }
}

fn mark_persisted_torrents_paused(dir: &std::path::Path) -> Result<usize, String> {
    let path = dir.join("session.json");
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut value = serde_json::from_slice::<serde_json::Value>(&raw).map_err(|e| e.to_string())?;
    let Some(torrents) = value.get_mut("torrents").and_then(|v| v.as_object_mut()) else {
        return Ok(0);
    };
    let mut changed = 0usize;
    for torrent in torrents.values_mut() {
        let Some(record) = torrent.as_object_mut() else {
            continue;
        };
        if record.get("is_paused").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        record.insert("is_paused".to_string(), serde_json::Value::Bool(true));
        changed += 1;
    }
    if changed == 0 {
        return Ok(0);
    }
    let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.harbor-pause.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(changed)
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct EngineConfig {
    dir: Option<String>,
    retention_hours: Option<u64>,
    max_gb: Option<u64>,
}

#[cfg(not(target_os = "android"))]
fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|d| d.join("engine.json"))
}

// Same reason as engine_dir below: Android's app_cache_dir is activity.cacheDir,
// which the OS empties under storage pressure. Leaving engine.json there loses
// the user's chosen cache directory and retention settings at random.
#[cfg(target_os = "android")]
fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("engine.json"))
}

fn read_config(app: &AppHandle) -> EngineConfig {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<EngineConfig>(&s).ok())
        .unwrap_or_default()
}

#[cfg(not(target_os = "android"))]
fn engine_dir(app: &AppHandle, cfg: &EngineConfig) -> Result<std::path::PathBuf, String> {
    if let Some(custom) = cfg.dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(std::path::PathBuf::from(custom).join("harbor-stream-cache"));
    }
    app.path()
        .app_cache_dir()
        .map_err(|e| e.to_string())
        .map(|d| d.join("engine"))
}

#[cfg(target_os = "android")]
fn engine_dir(app: &AppHandle, cfg: &EngineConfig) -> Result<std::path::PathBuf, String> {
    if let Some(custom) = cfg.dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(std::path::PathBuf::from(custom).join("harbor-stream-cache"));
    }
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|d| crate::p2p_android::engine_root(&d))
}

async fn init(app: AppHandle, cancellation: CancellationToken) -> Result<(), String> {
    let cancellation = cancellation.child_token();
    let guard = cancellation.clone().drop_guard();
    #[cfg(not(target_os = "android"))]
    std::env::set_var("DHT_QUERIES_PER_SECOND", "400");
    #[cfg(target_os = "android")]
    std::env::set_var(
        "DHT_QUERIES_PER_SECOND",
        crate::p2p_android::DHT_QUERIES_PER_SECOND,
    );
    // 128 peers per torrent plus DHT sockets can exhaust the default descriptor
    // limit once several torrents stream at the same time.
    #[cfg(unix)]
    {
        if let Err(error) = librqbit::try_increase_nofile_limit() {
            eprintln!("[torrent-engine] could not raise the file descriptor limit: {error:#}");
        }
    }
    let cfg = read_config(&app);
    let dir = engine_dir(&app, &cfg)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    match mark_persisted_torrents_paused(&dir) {
        Ok(0) => {}
        Ok(changed) => {
            eprintln!("[torrent-engine] paused {changed} persisted torrent(s) before restore")
        }
        Err(error) => {
            eprintln!("[torrent-engine] could not pre-pause persisted torrents: {error}")
        }
    }
    let (session, dht_tier) = match new_session(&dir, true, true, true, cancellation.child_token())
        .await
    {
        Ok(s) => (s, 1u8),
        Err(e1) => {
            eprintln!("[torrent-engine] tier1 (inbound + warm dht) unavailable ({e1}); trying no-inbound + warm dht");
            match new_session(&dir, false, true, true, cancellation.child_token()).await {
                Ok(s) => (s, 2u8),
                Err(e2) => {
                    eprintln!(
                        "[torrent-engine] tier2 unavailable ({e2}); trying cold ephemeral dht"
                    );
                    match new_session(&dir, false, true, false, cancellation.child_token()).await {
                        Ok(s) => (s, 3u8),
                        Err(e3) => {
                            eprintln!("[torrent-engine] tier3 (cold dht) unavailable ({e3}); starting without dht");
                            (
                                new_session(&dir, false, false, false, cancellation.child_token())
                                    .await?,
                                4u8,
                            )
                        }
                    }
                }
            }
        }
    };
    // Persisted stream-cache torrents must never resume peer traffic merely
    // because Harbor started. A real HTTP stream request resumes them on demand.
    pause_all_torrents(&session).await;
    let side_dht = dht_boot::build(session.cancellation_token().child_token()).await;
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let server_cancellation = session.cancellation_token().clone();
    let router = stream_route::router(session.clone());
    let server = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(server_cancellation.cancelled_owned())
            .await
        {
            eprintln!("[torrent-engine] server error: {e}");
        }
    });
    let sweeper = spawn_cache_sweeper(app.clone());
    let mut st = engine().lock().unwrap();
    if let Some(old) = st.server.take() {
        old.abort();
    }
    if let Some(old) = st.sweeper.take() {
        old.cancel();
    }
    st.session = Some(session);
    st.side_dht = side_dht;
    st.port = Some(port);
    st.dht_tier = dht_tier;
    st.ready = true;
    st.last_error = None;
    st.server = Some(server);
    st.sweeper = Some(sweeper);
    let _ = guard.disarm();
    eprintln!("[torrent-engine] ready on 127.0.0.1:{port} (dht tier {dht_tier})");
    Ok(())
}

async fn ensure_session_locked(app: &AppHandle) -> Result<Arc<Session>, String> {
    let cancellation = lifecycle().token()?;
    if let Some(session) = current_session() {
        return Ok(session);
    }
    lifecycle::run(cancellation.clone(), init(app.clone(), cancellation)).await?;
    current_session().ok_or_else(|| lifecycle::STOPPED.to_string())
}

async fn ensure_session(app: &AppHandle) -> Result<Arc<Session>, String> {
    let _transition = lifecycle().lock().await;
    ensure_session_locked(app).await
}

pub fn ensure_started_on_setup(app: &AppHandle) {
    let enabled = !crate::settings_store::read_torrents_disabled(app);
    let change = lifecycle().request(enabled);
    if !enabled || !lifecycle().enable(change) {
        return;
    }
    if crate::settings_store::read_defer_torrent_engine(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = ensure_session(&app).await {
            if lifecycle().is_enabled() {
                engine().lock().unwrap().last_error = Some(error);
            }
        }
    });
}

fn take_session_for_stop() -> Option<Arc<Session>> {
    let mut st = engine().lock().unwrap();
    if let Some(server) = st.server.take() {
        server.abort();
    }
    if let Some(sweeper) = st.sweeper.take() {
        sweeper.cancel();
    }
    if let Some(server) = st.lan_server.take() {
        server.abort();
    }
    st.lan_port = None;
    st.lan_error = None;
    let session = st.session.take();
    if let Some(session) = &session {
        session.cancellation_token().cancel();
    }
    if let Some(dht) = st.side_dht.take() {
        dht.cancellation_token().cancel();
    }
    st.port = None;
    st.dht_tier = 0;
    st.ready = false;
    session
}

async fn finish_session_stop(session: Arc<Session>) {
    pause_all_torrents(&session).await;
    session.stop().await;
}

async fn stop_locked() {
    if let Some(session) = take_session_for_stop() {
        finish_session_stop(session).await;
    }
}

pub async fn stop_async() {
    lifecycle().request(false);
    let _transition = lifecycle().lock().await;
    stop_locked().await;
}

pub fn stop() {
    tauri::async_runtime::block_on(stop_async());
}

#[tauri::command]
pub async fn torrent_engine_set_enabled(enabled: bool) -> Result<EngineStatusDto, String> {
    let change = lifecycle().request(enabled);
    let _transition = lifecycle().lock().await;
    let has_cancelled_session = engine()
        .lock()
        .unwrap()
        .session
        .as_ref()
        .is_some_and(|session| session.cancellation_token().is_cancelled());
    if has_cancelled_session || (!enabled && lifecycle().is_current(change)) {
        stop_locked().await;
    }
    if enabled {
        lifecycle().enable(change);
    }
    if !lifecycle().is_enabled() {
        engine().lock().unwrap().last_error = None;
    }
    Ok(torrent_engine_status())
}

#[tauri::command]
pub fn torrent_engine_status() -> EngineStatusDto {
    let (port, ready, last_error, dht_tier) = {
        let st = engine().lock().unwrap();
        (st.port, st.ready, st.last_error.clone(), st.dht_tier)
    };
    let ready = ready && current_session().is_some();
    let port = ready.then_some(port).flatten();
    let active_torrents = current_session()
        .map(|s| s.with_torrents(|t| t.count()))
        .unwrap_or(0);
    let dht_nodes = current_side_dht()
        .map(|d| dht_boot::node_count(&d))
        .unwrap_or(0);
    EngineStatusDto {
        ready,
        port,
        active_torrents,
        last_error,
        dht_tier,
        dht_nodes,
    }
}

fn merge_trackers(trackers: Vec<String>) -> Vec<String> {
    trackers::with_fallback(trackers)
}

async fn wait_for_torrent_initialization(
    session: &Arc<Session>,
    handle: &Arc<ManagedTorrent>,
    discard_on_failure: bool,
) -> Result<(), String> {
    let result = match timeout(Duration::from_secs(45), handle.wait_until_initialized()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("{error:#}")),
        Err(_) => Err("torrent init timed out".to_string()),
    };
    if result.is_err() && discard_on_failure {
        if let Err(error) = session
            .delete(TorrentIdOrHash::Hash(handle.info_hash()), true)
            .await
        {
            eprintln!("[torrent-engine] could not discard incomplete torrent: {error:#}");
        }
    }
    result
}

async fn update_only_files_bounded(
    session: &Arc<Session>,
    handle: &Arc<ManagedTorrent>,
    only: &HashSet<usize>,
) -> Result<(), String> {
    timeout(
        Duration::from_secs(FILE_SELECTION_TIMEOUT_SECS),
        session.update_only_files(handle, only),
    )
    .await
    .map_err(|_| "torrent file selection timed out".to_string())?
    .map_err(|error| format!("{error:#}"))
}

async fn add_result_from_handle(
    session: &Arc<Session>,
    handle: Arc<ManagedTorrent>,
    already_managed: bool,
    file_idx: Option<usize>,
) -> Result<AddResult, String> {
    let init_started = Instant::now();
    wait_for_torrent_initialization(session, &handle, !already_managed).await?;
    let init_ms = init_started.elapsed().as_millis();
    let files = handle
        .with_metadata(|m| {
            m.file_infos
                .iter()
                .enumerate()
                .map(|(idx, fi)| EngineFile {
                    idx,
                    name: fi
                        .relative_filename
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| fi.relative_filename.to_string_lossy().to_string()),
                    length: fi.len,
                })
                .collect::<Vec<_>>()
        })
        .map_err(|e| format!("{e:#}"))?;
    let narrow_idx = file_idx
        .filter(|&i| i < files.len())
        .or_else(|| files.iter().max_by_key(|f| f.length).map(|f| f.idx));
    let narrow_started = Instant::now();
    if let Some(idx) = narrow_idx {
        let only: HashSet<usize> = HashSet::from([idx]);
        if let Err(error) = update_only_files_bounded(session, &handle, &only).await {
            eprintln!("[torrent-engine] initial file narrowing failed: {error}");
        }
    }
    let narrow_ms = narrow_started.elapsed().as_millis();
    eprintln!(
        "[torrent-engine] files timing: already_managed={already_managed} init_ms={init_ms} narrow_ms={narrow_ms} files={} narrow_idx={narrow_idx:?}",
        files.len()
    );
    let port = current_port().ok_or_else(|| "engine port unavailable".to_string())?;
    Ok(AddResult {
        info_hash: format!("{:?}", handle.info_hash()),
        files,
        stream_base: format!("http://127.0.0.1:{port}/stream"),
        already_managed,
    })
}

#[tauri::command]
pub async fn torrent_engine_add(
    app: AppHandle,
    magnet: String,
    trackers: Vec<String>,
    file_idx: Option<usize>,
    origin: Option<String>,
) -> Result<AddResult, String> {
    let origin = origin.as_deref().unwrap_or("unknown");
    let session = ensure_session(&app).await?;
    run_session(&session, async {
        if let Some(info_hash) = dht_boot::info_hash_from_magnet(&magnet) {
            if let Some(handle) = session.get(TorrentIdOrHash::Hash(info_hash)) {
                return add_result_from_handle(&session, handle, true, file_idx).await;
            }
        }
        let add_started = Instant::now();
        let (seed, seed_took) = seed_side_dht(&magnet).await;
        let seeded_peers = seed.len();
        // librqbit ignores AddTorrentOptions.trackers for magnets, so splice the
        // per-stream trackers directly into the magnet URI to guarantee they
        // announce. The curated fallback is only used when the source has none.
        let resolved_trackers = trackers::with_fallback(trackers.clone());
        let magnet = trackers::embed_into_magnet(&magnet, &resolved_trackers);
        let opts = AddTorrentOptions {
            overwrite: true,
            paused: true,
            skip_initial_check: true,
            only_files: file_idx.map(|i| vec![i]),
            trackers: Some(resolved_trackers),
            initial_peers: (!seed.is_empty()).then_some(seed),
            peer_opts: Some(PeerConnectionOptions {
                connect_timeout: Some(Duration::from_secs(4)),
                read_write_timeout: Some(Duration::from_secs(10)),
                keep_alive_interval: None,
            }),
            force_tracker_interval: Some(Duration::from_secs(120)),
            ..Default::default()
        };
        let add_call_started = Instant::now();
        let added = timeout(
            Duration::from_secs(60),
            session.add_torrent(AddTorrent::from_url(magnet.as_str()), Some(opts)),
        )
        .await
        .map_err(|_| "metadata timed out: no peers reached in 60s".to_string())?
        .map_err(|e| format!("{e:#}"))?;
        let add_took = add_call_started.elapsed();
        let (handle, already_managed) = match added {
            AddTorrentResponse::AlreadyManaged(_, handle) => (handle, true),
            AddTorrentResponse::Added(_, handle) => (handle, false),
            AddTorrentResponse::ListOnly(_) => {
                return Err("torrent added as list-only".to_string());
            }
        };
        let files_started = Instant::now();
        let result = add_result_from_handle(&session, handle, already_managed, file_idx).await;
        let files_took = files_started.elapsed();
        if let Ok(result) = &result {
            eprintln!(
                "[torrent-engine] add timing: origin={origin} hash={} seeded_peers={} seed_ms={} add_ms={} files_ms={} total_ms={}",
                result.info_hash,
                seeded_peers,
                seed_took.as_millis(),
                add_took.as_millis(),
                files_took.as_millis(),
                add_started.elapsed().as_millis()
            );
        }
        result
    })
    .await
}

fn build_magnet(hash: &str) -> String {
    format!("magnet:?xt=urn:btih:{hash}")
}

pub(crate) async fn ensure_added(
    session: &Arc<Session>,
    hash: &str,
    trackers: Vec<String>,
    file_idx: Option<usize>,
) -> Result<(String, Vec<EngineFile>), String> {
    run_session(session, async {
        let id = TorrentIdOrHash::parse(hash).map_err(|e| e.to_string())?;
        let handle = match session.get(id) {
            Some(h) => h,
            None => {
                // build_magnet() yields a bare magnet; splice the resolved
                // trackers into it so librqbit announces them (it drops
                // AddTorrentOptions.trackers for magnets - the only peer path
                // when UDP/DHT are blocked).
                let resolved_trackers = trackers::with_fallback(trackers);
                let magnet = trackers::embed_into_magnet(&build_magnet(hash), &resolved_trackers);
                let (seed, _) = seed_side_dht(&magnet).await;
                let opts = AddTorrentOptions {
                    overwrite: true,
                    paused: true,
                    only_files: file_idx.map(|i| vec![i]),
                    trackers: Some(resolved_trackers),
                    initial_peers: (!seed.is_empty()).then_some(seed),
                    peer_opts: Some(PeerConnectionOptions {
                        connect_timeout: Some(Duration::from_secs(4)),
                        read_write_timeout: Some(Duration::from_secs(10)),
                        keep_alive_interval: None,
                    }),
                    force_tracker_interval: Some(Duration::from_secs(120)),
                    ..Default::default()
                };
                let added = timeout(
                    Duration::from_secs(60),
                    session.add_torrent(AddTorrent::from_url(magnet.as_str()), Some(opts)),
                )
                .await
                .map_err(|_| "metadata timed out: no peers reached in 60s".to_string())?
                .map_err(|e| format!("{e:#}"))?;
                let (h, already_managed) = match added {
                    AddTorrentResponse::AlreadyManaged(_, handle) => (handle, true),
                    AddTorrentResponse::Added(_, handle) => (handle, false),
                    AddTorrentResponse::ListOnly(_) => {
                        return Err("torrent added as list-only".to_string());
                    }
                };
                wait_for_torrent_initialization(&session, &h, !already_managed).await?;
                h
            }
        };
        let info_hash = format!("{:?}", handle.info_hash());
        let files = handle
            .with_metadata(|m| {
                m.file_infos
                    .iter()
                    .enumerate()
                    .map(|(idx, fi)| EngineFile {
                        idx,
                        name: fi
                            .relative_filename
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| fi.relative_filename.to_string_lossy().to_string()),
                        length: fi.len,
                    })
                    .collect::<Vec<_>>()
            })
            .map_err(|e| format!("{e:#}"))?;
        if let Some(idx) = file_idx.filter(|&i| i < files.len()) {
            let only: HashSet<usize> = HashSet::from([idx]);
            let _ = update_only_files_bounded(&session, &handle, &only).await;
        }
        Ok((info_hash, files))
    })
    .await
}

pub fn lan_status() -> (bool, Option<u16>, Option<String>) {
    let st = engine().lock().unwrap();
    (st.lan_server.is_some(), st.lan_port, st.lan_error.clone())
}

async fn bind_lan_listener() -> Result<(TcpListener, u16), String> {
    let mut first_error: Option<String> = None;
    for port in std::iter::once(LAN_SERVER_PORT).chain(LAN_FALLBACK_PORTS) {
        match TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await {
            Ok(listener) => return Ok((listener, port)),
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(format!("port {port} unavailable: {e}"));
                }
            }
        }
    }
    Err(first_error.unwrap_or_else(|| format!("port {LAN_SERVER_PORT} unavailable")))
}

pub async fn start_lan_server(app: &AppHandle) -> Result<u16, String> {
    let _transition = lifecycle().lock().await;
    let session = match ensure_session_locked(app).await {
        Ok(s) => s,
        Err(e) => {
            engine().lock().unwrap().lan_error = Some(e.clone());
            return Err(e);
        }
    };
    run_session(&session, async {
        stop_lan_server();
        let (listener, port) = match bind_lan_listener().await {
            Ok(bound) => bound,
            Err(msg) => {
                engine().lock().unwrap().lan_error = Some(msg.clone());
                return Err(msg);
            }
        };
        let server_cancellation = session.cancellation_token().clone();
        let router = stream_route::router(session.clone());
        let server = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router)
                .with_graceful_shutdown(server_cancellation.cancelled_owned())
                .await
            {
                eprintln!("[torrent-engine] lan server error: {e}");
            }
        });
        let mut st = engine().lock().unwrap();
        st.lan_server = Some(server);
        st.lan_port = Some(port);
        st.lan_error = None;
        Ok(port)
    })
    .await
}

pub fn stop_lan_server() {
    let mut st = engine().lock().unwrap();
    if let Some(h) = st.lan_server.take() {
        h.abort();
    }
    st.lan_port = None;
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct PeerDiag {
    live: usize,
    queued: usize,
    connecting: usize,
    seeders: usize,
    downloaded: u64,
    down_mbps: f64,
}

fn peer_diag(handle: &Arc<ManagedTorrent>) -> PeerDiag {
    let stats = handle.stats();
    match stats.live.as_ref() {
        Some(live) => PeerDiag {
            live: live.snapshot.peer_stats.live,
            queued: live.snapshot.peer_stats.queued,
            connecting: live.snapshot.peer_stats.connecting,
            seeders: live.snapshot.peer_stats.seeders,
            downloaded: live.snapshot.downloaded_and_checked_bytes,
            down_mbps: live.download_speed.mbps,
        },
        None => PeerDiag {
            downloaded: stats.progress_bytes,
            ..Default::default()
        },
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct PrimeLeg {
    pub bytes: u64,
    pub first_byte: Duration,
    pub elapsed: Duration,
    /// Peer state when the first byte arrived: separates "slow swarm" from
    /// "one blocked piece while the rest of the torrent was already flowing".
    pub first_byte_peers: usize,
    pub first_byte_downloaded: u64,
}

#[derive(Debug)]
pub(crate) struct PrimeReport {
    pub head: Result<PrimeLeg, String>,
    pub tail: Result<PrimeLeg, String>,
    pub total: Duration,
    pub before: PeerDiag,
    pub after: PeerDiag,
}

// Reads one contiguous range of the selected file through the streaming priority
// path. Dropping the returned stream releases the demand on the torrent.
async fn prime_range(
    handle: &Arc<ManagedTorrent>,
    file_idx: usize,
    from_end: bool,
    bytes: u64,
) -> Result<PrimeLeg, String> {
    let mut stream = handle
        .clone()
        .stream(file_idx)
        .map_err(|error| format!("{error:#}"))?;
    let len = stream.len();
    if len == 0 {
        return Ok(PrimeLeg::default());
    }
    let (offset, want) = if from_end {
        let want = bytes.min(len);
        (len - want, want)
    } else {
        (0, bytes.min(len))
    };
    let started = Instant::now();
    if offset > 0 {
        stream
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| error.to_string())?;
    }
    let mut buf = vec![0u8; PRIME_READ_BUF];
    let mut read = 0_u64;
    let mut first_byte = None;
    let mut first_byte_peers = 0;
    let mut first_byte_downloaded = 0;
    while read < want {
        let step = (want - read).min(PRIME_READ_BUF as u64) as usize;
        let n = stream
            .read(&mut buf[..step])
            .await
            .map_err(|error| error.to_string())?;
        if n == 0 {
            break;
        }
        read += n as u64;
        if first_byte.is_none() {
            first_byte = Some(started.elapsed());
            let diag = peer_diag(handle);
            first_byte_peers = diag.live;
            first_byte_downloaded = diag.downloaded;
        }
    }
    Ok(PrimeLeg {
        bytes: read,
        first_byte: first_byte.unwrap_or_else(|| started.elapsed()),
        elapsed: started.elapsed(),
        first_byte_peers,
        first_byte_downloaded,
    })
}

// Head and tail are demanded concurrently: an MP4 player asks for the moov atom
// at the end of the file on its very first request, while MKV/HEVC probes read
// from the start. Interleaving both keeps either container's probe from waiting
// on the other.
pub(crate) async fn prime_stream_head_tail(
    handle: &Arc<ManagedTorrent>,
    file_idx: usize,
) -> PrimeReport {
    let before = peer_diag(handle);
    let started = Instant::now();
    let head = prime_range(handle, file_idx, false, PRIME_HEAD_BYTES);
    let tail = prime_range(handle, file_idx, true, PRIME_TAIL_BYTES);
    let (head, tail) = tokio::join!(head, tail);
    PrimeReport {
        head,
        tail,
        total: started.elapsed(),
        before,
        after: peer_diag(handle),
    }
}

fn describe_prime_leg(leg: &Result<PrimeLeg, String>) -> String {
    match leg {
        Ok(leg) => format!(
            "{}B/ttfb{}ms/{}ms@peers{}/{downloaded}B",
            leg.bytes,
            leg.first_byte.as_millis(),
            leg.elapsed.as_millis(),
            leg.first_byte_peers,
            downloaded = leg.first_byte_downloaded,
        ),
        Err(error) => error.clone(),
    }
}

fn spawn_stream_prime(handle: Arc<ManagedTorrent>, file_idx: usize) {
    tokio::spawn(async move {
        let info_hash = format!("{:?}", handle.info_hash());
        match timeout(PRIME_TIMEOUT, prime_stream_head_tail(&handle, file_idx)).await {
            Ok(report) => {
                let downloaded = report
                    .after
                    .downloaded
                    .saturating_sub(report.before.downloaded);
                let seconds = report.total.as_secs_f64();
                let avg_mbps = if seconds > 0.0 {
                    downloaded as f64 / seconds / (1024.0 * 1024.0)
                } else {
                    0.0
                };
                let piece_kb = handle
                    .with_metadata(|metadata| metadata.info.piece_length / 1024)
                    .unwrap_or_default();
                eprintln!(
                    "[torrent-engine] prime hash={info_hash} file={file_idx} piece_kb={piece_kb} head={} tail={} total_ms={} peers={}->{} queued={} connecting={} seeders={} downloaded_kb={} avg_MBps={avg_mbps:.2} down_MBps={:.2}",
                    describe_prime_leg(&report.head),
                    describe_prime_leg(&report.tail),
                    report.total.as_millis(),
                    report.before.live,
                    report.after.live,
                    report.before.queued,
                    report.before.connecting,
                    report.before.seeders,
                    downloaded / 1024,
                    report.after.down_mbps
                )
            }
            Err(_) => {
                let diag = peer_diag(&handle);
                eprintln!(
                    "[torrent-engine] prime hash={info_hash} file={file_idx} timed out after {}ms peers={} queued={} connecting={} downloaded_kb={}",
                    PRIME_TIMEOUT.as_millis(),
                    diag.live,
                    diag.queued,
                    diag.connecting,
                    diag.downloaded / 1024
                )
            }
        }
    });
}

#[tauri::command]
pub async fn torrent_engine_select(info_hash: String, file_idx: usize) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "engine not ready".to_string())?;
    run_session(&session, async {
        let id = TorrentIdOrHash::parse(&info_hash).map_err(|e| e.to_string())?;
        let handle = session.get(id).ok_or_else(|| "no torrent".to_string())?;
        let only: HashSet<usize> = HashSet::from([file_idx]);
        update_only_files_bounded(&session, &handle, &only).await?;
        // Peer discovery previously started only when the player issued its first
        // HTTP request, which is after mpv init and the resume lookup. Starting it
        // here lets tracker/DHT discovery, peer connects, and the head/tail
        // prefetch run while the player boots.
        if handle.is_paused() {
            session
                .unpause(&handle)
                .await
                .map_err(|error| format!("{error:#}"))?;
        }
        spawn_stream_prime(handle.clone(), file_idx);
        Ok(())
    })
    .await
}

// Select an exact set of files in one shot (no per-file re-add/replace storm) and
// unpause. An empty set pauses the torrent so nothing keeps downloading.
#[tauri::command]
pub async fn torrent_engine_select_set(
    info_hash: String,
    file_idxs: Vec<usize>,
) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "engine not ready".to_string())?;
    run_session(&session, async {
        let id = TorrentIdOrHash::parse(&info_hash).map_err(|e| e.to_string())?;
        let handle = session.get(id).ok_or_else(|| "no torrent".to_string())?;
        let only: HashSet<usize> = file_idxs.into_iter().collect();
        if only.is_empty() {
            session.pause(&handle).await.map_err(|e| format!("{e:#}"))?;
            return Ok(());
        }
        session
            .update_only_files(&handle, &only)
            .await
            .map_err(|e| format!("{e:#}"))?;
        session
            .unpause(&handle)
            .await
            .map_err(|e| format!("{e:#}"))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn torrent_engine_stats(
    info_hash: String,
    file_idx: Option<usize>,
) -> Result<TorrentEngineStats, String> {
    let session = current_session().ok_or_else(|| "engine not ready".to_string())?;
    let id = TorrentIdOrHash::parse(&info_hash).map_err(|e| e.to_string())?;
    let handle = session.get(id).ok_or_else(|| "no torrent".to_string())?;
    let s = handle.stats();
    let (peers, download_speed, peer_search_running) = match &s.live {
        Some(live) => (
            live.snapshot.peer_stats.live,
            (live.download_speed.mbps * 1024.0 * 1024.0) as u64,
            true,
        ),
        None => (0, 0, false),
    };
    let stream_progress = match file_idx {
        Some(i) => s.file_progress.get(i).copied().unwrap_or(s.progress_bytes),
        None => s.progress_bytes,
    };
    let stream_len = match file_idx {
        Some(i) => handle
            .with_metadata(|m| m.file_infos.get(i).map(|fi| fi.len))
            .ok()
            .flatten()
            .unwrap_or(s.total_bytes),
        None => s.total_bytes,
    };
    Ok(TorrentEngineStats {
        peers,
        unchoked: peers,
        downloaded: s.progress_bytes,
        download_speed,
        stream_progress,
        stream_len,
        peer_search_running,
        finished: s.finished,
        state: format!("{:?}", s.state),
    })
}

#[tauri::command]
pub async fn torrent_engine_remove(info_hash: String, delete_files: bool) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "engine not ready".to_string())?;
    let id = TorrentIdOrHash::parse(&info_hash).map_err(|e| e.to_string())?;
    session
        .delete(id, delete_files)
        .await
        .map_err(|e| format!("{e:#}"))?;
    Ok(())
}

#[tauri::command]
pub async fn torrent_engine_restart(app: AppHandle) -> Result<EngineStatusDto, String> {
    let _transition = lifecycle().lock().await;
    stop_locked().await;
    if lifecycle().is_enabled() {
        tokio::time::sleep(Duration::from_millis(600)).await;
        if lifecycle().is_enabled() {
            ensure_session_locked(&app).await?;
        }
    }
    Ok(torrent_engine_status())
}

#[tauri::command]
pub async fn torrent_engine_hard_reset(app: AppHandle) -> Result<EngineStatusDto, String> {
    let _transition = lifecycle().lock().await;
    stop_locked().await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let cfg = read_config(&app);
    if let Ok(dir) = engine_dir(&app, &cfg) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    engine().lock().unwrap().last_error = None;
    if lifecycle().is_enabled() {
        ensure_session_locked(&app).await?;
    }
    Ok(torrent_engine_status())
}

#[tauri::command]
pub async fn torrent_engine_set_options(
    app: AppHandle,
    dir: Option<String>,
    retention_hours: u64,
    max_gb: u64,
    restart: bool,
) -> Result<EngineStatusDto, String> {
    let _transition = lifecycle().lock().await;
    let cfg = EngineConfig {
        dir: dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        retention_hours: Some(retention_hours),
        max_gb: Some(max_gb),
    };
    if let Some(p) = config_path(&app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&p, serde_json::to_string(&cfg).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    if restart {
        stop_locked().await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        if lifecycle().is_enabled() {
            ensure_session_locked(&app).await?;
        }
    }
    Ok(torrent_engine_status())
}

#[tauri::command]
pub async fn torrent_engine_selftest(app: AppHandle) -> selftest::SelfTestResult {
    let result = async {
        let session = ensure_session(&app).await?;
        run_session(&session, async { Ok(selftest::run(app).await) }).await
    }
    .await;
    match result {
        Ok(result) => result,
        Err(error) => selftest::unavailable(error),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentListItem {
    pub info_hash: String,
    pub name: String,
    pub downloaded: u64,
    pub total: u64,
    pub download_speed: u64,
    pub finished: bool,
    pub paused: bool,
    pub state: String,
}

#[tauri::command]
pub fn torrent_engine_list() -> Vec<TorrentListItem> {
    let Some(session) = current_session() else {
        return Vec::new();
    };
    session.with_torrents(|torrents| {
        torrents
            .map(|(_id, handle)| {
                let s = handle.stats();
                let info_hash = format!("{:?}", handle.info_hash());
                let name = handle
                    .with_metadata(|m| {
                        m.file_infos.iter().max_by_key(|fi| fi.len).map(|fi| {
                            fi.relative_filename
                                .file_name()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_else(|| {
                                    fi.relative_filename.to_string_lossy().to_string()
                                })
                        })
                    })
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| info_hash.clone());
                let download_speed = s
                    .live
                    .as_ref()
                    .map(|l| (l.download_speed.mbps * 1024.0 * 1024.0) as u64)
                    .unwrap_or(0);
                let state = format!("{:?}", s.state);
                let paused = state.contains("Paused");
                TorrentListItem {
                    info_hash,
                    name,
                    downloaded: s.progress_bytes,
                    total: s.total_bytes,
                    download_speed,
                    finished: s.finished,
                    paused,
                    state,
                }
            })
            .collect()
    })
}

#[tauri::command]
pub async fn torrent_engine_pause(info_hash: String) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "engine not ready".to_string())?;
    let id = TorrentIdOrHash::parse(&info_hash).map_err(|e| e.to_string())?;
    let handle = session.get(id).ok_or_else(|| "no torrent".to_string())?;
    session.pause(&handle).await.map_err(|e| format!("{e:#}"))?;
    Ok(())
}

#[tauri::command]
pub async fn torrent_engine_resume(info_hash: String) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "engine not ready".to_string())?;
    run_session(&session, async {
        let id = TorrentIdOrHash::parse(&info_hash).map_err(|e| e.to_string())?;
        let handle = session.get(id).ok_or_else(|| "no torrent".to_string())?;
        session
            .unpause(&handle)
            .await
            .map_err(|e| format!("{e:#}"))?;
        Ok(())
    })
    .await
}
