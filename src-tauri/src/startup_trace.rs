use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Publishing the process start as one value keeps the wall clock and the
/// monotonic instant consistent even if a timeline request arrives early.
static PROCESS_START: OnceLock<(u64, Instant)> = OnceLock::new();
/// The shown timestamp and elapsed duration are published together so a
/// concurrent request can never observe one without the other.
static WINDOW_SHOWN: OnceLock<(u64, u64)> = OnceLock::new();

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Called at the start of the desktop entry, before Tauri builds the window.
pub fn mark_process_start() {
    let _ = PROCESS_START.set((now_unix_ms(), Instant::now()));
}

/// Called once when the native window is actually shown.
pub fn mark_window_shown() {
    let Some((_, start)) = PROCESS_START.get() else {
        return;
    };
    let elapsed = start.elapsed().as_millis() as u64;
    let _ = WINDOW_SHOWN.set((now_unix_ms(), elapsed));
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupTimeline {
    pub process_start_unix_ms: u64,
    pub window_shown_unix_ms: Option<u64>,
    pub window_shown_elapsed_ms: Option<u64>,
}

pub fn timeline() -> StartupTimeline {
    let process_start_unix_ms = PROCESS_START
        .get()
        .map(|(unix_ms, _)| *unix_ms)
        .unwrap_or(0);
    let shown = WINDOW_SHOWN.get().copied();
    StartupTimeline {
        process_start_unix_ms,
        window_shown_unix_ms: shown.map(|(unix_ms, _)| unix_ms),
        window_shown_elapsed_ms: shown.map(|(_, elapsed_ms)| elapsed_ms),
    }
}

#[tauri::command]
pub fn startup_timeline() -> StartupTimeline {
    timeline()
}
