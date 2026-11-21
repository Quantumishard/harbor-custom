//! Live verification of Soloist playback against the real executable.
//! Runs only when HARBOR_SOLOIST_LIVE=1 is set and a paired Harbor Soloist
//! session exists; otherwise it skips. Playback is muted and uses an isolated
//! copy of the stored session so the running app is never disturbed.
use super::playback::{pause, play, seek, snapshot, stop};
use crate::music::MusicTrack;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

const LIVE_FLAG: &str = "HARBOR_SOLOIST_LIVE";
const URI: &str = "spotify:track:0VjIjW4GlUZAMYd2vXMi3b";

fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// A mock app whose data directory is a private copy of the paired session,
/// the Soloist executable path and the personal API key.
fn live_app() -> Result<tauri::AppHandle, String> {
    let source = std::env::var("APPDATA").map_err(|_| "APPDATA is not set".to_owned())?;
    let source = PathBuf::from(source).join("app.harbor");
    let secrets: Value = serde_json::from_str(
        &std::fs::read_to_string(source.join("secrets.json"))
            .map_err(|_| "Harbor secrets.json is not readable".to_owned())?,
    )
    .map_err(|_| "Harbor secrets.json is not valid JSON".to_owned())?;
    let executable = secrets["harbor.spotify.soloist.v1.executable"]
        .as_str()
        .ok_or("Configure Spotify Soloist in Harbor first.")?
        .to_owned();
    let key = secrets["harbor.spotify.soloist.v1.apiKey"]
        .as_str()
        .ok_or("Add the personal Soloist API key in Harbor first.")?
        .to_owned();

    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "app.harbor.soloist.live.test".into();
    // A real (headless) Wry app: the playback adapter is typed against the
    // production AppHandle. No window is created and run() is never called.
    let builder = tauri::Builder::default();
    // Tests run off the main thread, which Windows and Linux event loops
    // reject unless the runtime is told to allow it.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.any_thread();
    let app = builder
        .build(context)
        .map_err(|error| format!("headless app: {error}"))?;
    let handle = app.handle().clone();
    let data = handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?;
    if !data.ends_with("app.harbor.soloist.live.test") {
        return Err("refusing to touch a directory outside the live-test harness".into());
    }
    // A previous failed run may have left its daemon running (the test process
    // panics before stop()). Use the pid file, but only when the process name
    // still matches Soloist, and never touch the real app's session.
    let pid_file = data.join("spotify-soloist").join("soloist.pid");
    if let Ok(pid) = std::fs::read_to_string(&pid_file) {
        let pid = pid.trim();
        #[cfg(windows)]
        {
            let listed = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output();
            if listed.is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains("soloist.exe"))
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", pid, "/F"])
                    .output();
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        #[cfg(not(windows))]
        {
            if pid.chars().all(|c| c.is_ascii_digit()) {
                let _ = std::process::Command::new("kill")
                    .args(["-9", pid])
                    .output();
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    std::fs::write(
        data.join("secrets.json"),
        serde_json::json!({
            "harbor.spotify.soloist.v1.executable": executable,
            "harbor.spotify.soloist.v1.apiKey": key,
        })
        .to_string(),
    )
    .map_err(|error| error.to_string())?;
    // Soloist 1.3.x keeps the paired session across settings/ and cache/
    // inside the data directory, so both trees are copied.
    let session = data.join("spotify-soloist");
    let source_session = source.join("spotify-soloist");
    for name in ["settings", "cache"] {
        if source_session.join(name).exists() {
            copy_tree(&source_session.join(name), &session.join(name))
                .map_err(|error| format!("copy {name}: {error}"))?;
        }
    }
    let _ = std::fs::copy(
        source_session.join(".device_id"),
        session.join(".device_id"),
    );
    Ok(handle)
}

fn track() -> MusicTrack {
    MusicTrack {
        explicit: None,
        version: None,
        media_kind: None,
        id: URI.to_owned(),
        connector_id: Some("spotify".into()),
        source_id: Some(URI.to_owned()),
        playback_url: None,
        title: "Live pause test".into(),
        artist: "Harbor".into(),
        album: None,
        artwork: String::new(),
        duration_seconds: 200,
        duration_label: "3:20".into(),
    }
}

async fn wait_for(what: &str, check: impl Fn(Option<super::playback::Snapshot>) -> bool) -> bool {
    for _ in 0..150 {
        let state = snapshot();
        if check(state.clone()) {
            return true;
        }
        match state {
            Some(state) => eprintln!(
                "live: waiting for {what}: paused={} position={:.1}s",
                state.paused, state.position_seconds
            ),
            None => eprintln!("live: waiting for {what}: no snapshot"),
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

#[tokio::test]
async fn live_daemon_pause_resumes_and_ends_the_queue() {
    if std::env::var(LIVE_FLAG).is_err() {
        eprintln!("skipped: set {LIVE_FLAG}=1 with a paired Soloist session to run");
        return;
    }
    let handle = live_app().expect("live harness");
    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    {
        use tauri::Listener;
        let sink = events.clone();
        handle.listen_any("music://event", move |event| {
            let payload: Value =
                serde_json::from_str(event.payload()).unwrap_or_else(|_| Value::Null);
            let mut log = sink.lock().unwrap();
            if log.len() < 600 {
                let name = payload["event"].as_str().unwrap_or("?");
                let detail = match name {
                    "property-change" => format!(
                        " property-change {}={}",
                        payload["name"].as_str().unwrap_or("?"),
                        payload["data"]
                    ),
                    _ => String::new(),
                };
                log.push(format!("{name}{detail}"));
            }
        });
    }

    play(&handle, track(), 0.0).await.expect("soloist play");
    assert!(
        wait_for("load", |state| state.is_some_and(|state| state.live)).await,
        "track never loaded"
    );
    // Give Soloist a moment to publish its real duration.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let duration = snapshot().expect("snapshot").duration_seconds;
    eprintln!("live: playing, duration {duration:.1}s");

    seek(&handle, (duration - 12.0).max(0.0))
        .await
        .expect("seek near the end");
    tokio::time::sleep(Duration::from_millis(2500)).await;
    pause(&handle, true).await.expect("pause command");
    let paused = snapshot().expect("snapshot after pause");
    assert!(paused.paused, "pause did not freeze Harbor's state");
    let at = paused.position_seconds;
    eprintln!("live: paused at {at:.1}s / {duration:.1}s");

    // The daemon must survive an indefinite pause: no single-track watchdog.
    let mut drift = 0.0f64;
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(super::running(), "the Soloist daemon exited while paused");
        let state = snapshot().expect("snapshot while paused");
        assert!(state.paused, "pause state was lost while paused");
        drift = drift.max((state.position_seconds - at).abs());
    }
    eprintln!("live: survived a 75s pause, clock drift {drift:.2}s");
    assert!(
        drift < 1.0,
        "timer kept running while paused (drift {drift:.2}s)"
    );

    // Resume from the warm pause: native play, same process, same position.
    pause(&handle, false).await.expect("resume command");
    assert!(
        wait_for("resume", |state| state
            .is_some_and(|state| state.live && !state.paused))
        .await,
        "resume never cleared pause"
    );
    let resumed = snapshot().expect("snapshot after resume");
    assert!(super::running(), "resume lost the daemon");
    assert!(
        resumed.position_seconds >= at - 3.0 && resumed.position_seconds <= at + 3.0,
        "resume landed at {:.1}s, expected near {at:.1}s",
        resumed.position_seconds
    );
    eprintln!("live: resumed at {:.1}s", resumed.position_seconds);

    // Let the track reach its end: the end handoff must emit exactly one EOF
    // and keep the daemon alive for the next queue entry.
    let mut ended = false;
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let has_eof = events
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("end-file"));
        if has_eof {
            ended = true;
            break;
        }
    }
    eprintln!("live: reached end of track, EOF emitted: {ended}");
    assert!(ended, "the end of the track never advanced the queue");
    assert!(super::running(), "the daemon died at the end of the track");

    stop(&handle, false).await.expect("stop");
    assert!(snapshot().is_none(), "stop did not clear the track");
    // The live harness owns a throwaway daemon: shut it down so it does not
    // sit on the copied session after the test.
    let _ = super::terminate_managed();
    let log = events.lock().unwrap();
    let end_files = log.iter().filter(|line| line.contains("end-file")).count();
    let failures = log
        .iter()
        .filter(|line| line.contains("player-failure"))
        .count();
    eprintln!(
        "live: {} events, {} end-file emissions, {} player-failure emissions",
        log.len(),
        end_files,
        failures
    );
    assert_eq!(end_files, 1, "expected exactly one end-of-track emission");
    assert_eq!(failures, 0, "playback reported a failure");
}
