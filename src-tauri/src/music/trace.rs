//! Opt-in playback trace for stalls the interface can only show as "loading".
//! Enable with `HARBOR_MUSIC_TRACE=1`; lines land in `music-trace.log` beside the app logs.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

pub(crate) fn enabled() -> bool {
    std::env::var("HARBOR_MUSIC_TRACE").as_deref() == Ok("1")
}

pub(crate) fn configure(app: &tauri::AppHandle) {
    use tauri::Manager;
    if !enabled() {
        return;
    }
    let _ = PATH.set(app.path().app_log_dir().ok().map(|directory| {
        let _ = std::fs::create_dir_all(&directory);
        directory.join("music-trace.log")
    }));
}

/// One append. Silent unless the trace was configured, and never fails a command.
pub(crate) fn log(line: impl AsRef<str>) {
    let Some(Some(path)) = PATH.get() else {
        return;
    };
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let _ = writeln!(file, "{millis} {}", line.as_ref());
}
