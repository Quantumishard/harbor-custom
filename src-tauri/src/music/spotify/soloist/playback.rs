//! Soloist playback adapter. The only WebSocket peer is the native process,
//! bound to loopback; the webview only receives Harbor's normal music events.
use super::{data_dir, endpoint, running};
use crate::music::MusicTrack;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{connect_async, tungstenite::Message};
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub live: bool,
    pub paused: bool,
    pub track_id: String,
    pub position_seconds: f64,
    pub duration_seconds: f64,
}
struct Current {
    track: MusicTrack,
    uri: String,
    loaded: bool,
    ended: bool,
    displaced: bool,
    // A single-track subprocess can briefly advertise Spotify's *next*
    // autoplay URI while exiting. Do not let it displace Harbor's track.
    awaiting_process_exit: bool,
    paused: bool,
    anchor_ms: f64,
    timestamp_ms: u64,
    speed: f64,
    duration: f64,
    started_at: u64,
    listened_seconds: f64,
    last_tick: Instant,
}
struct Watch {
    generation: u64,
    task: Option<tokio::task::JoinHandle<()>>,
    current: Option<Current>,
}
fn watch() -> &'static Mutex<Watch> {
    static INSTANCE: OnceLock<Mutex<Watch>> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Mutex::new(Watch {
            generation: 0,
            task: None,
            current: None,
        })
    })
}
fn video_paused() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn position(current: &Current) -> f64 {
    let elapsed = now_ms().saturating_sub(current.timestamp_ms) as f64;
    ((current.anchor_ms + elapsed * current.speed.max(0.0)) / 1000.0).clamp(
        0.0,
        if current.duration > 0.0 {
            current.duration
        } else {
            f64::MAX
        },
    )
}
fn mark_listening(current: &mut Current) {
    if current.loaded && !current.paused && !current.ended {
        current.listened_seconds += current.last_tick.elapsed().as_secs_f64().min(2.0);
    }
    current.last_tick = Instant::now();
}
pub fn snapshot() -> Option<Snapshot> {
    let guard = watch().lock();
    let current = guard.current.as_ref()?;
    Some(Snapshot {
        live: current.loaded && !current.ended,
        paused: current.paused,
        track_id: current.track.id.clone(),
        position_seconds: position(current),
        duration_seconds: current.duration,
    })
}

async fn connect(app: &AppHandle) -> Result<Socket, String> {
    if !running() {
        return Err("Spotify Soloist is not running".into());
    }
    let url = endpoint(&data_dir(app)?).ok_or("Soloist's local API is unavailable")?;
    let (socket, _) = tokio::time::timeout(Duration::from_secs(3), connect_async(url))
        .await
        .map_err(|_| "Soloist WebSocket timed out")?
        .map_err(|_| "Cannot connect to Soloist's local API")?;
    Ok(socket)
}
fn payload(message: Message) -> Option<Value> {
    serde_json::from_str(message.to_text().ok()?).ok()
}
async fn authenticate(socket: &mut Socket) -> Result<(), String> {
    // Fresh Soloist can report logged_in=false before its stored session
    // finishes restoring. Wait for a real positive state, bounded by timeout.
    let decided = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(frame) = socket.next().await {
            let frame = frame.map_err(|_| "Soloist authentication failed".to_owned())?;
            let Some(auth) = payload(frame) else { continue };
            if auth["type"] != "auth_state" {
                continue;
            }
            if auth["logged_in"] == true {
                return Ok(());
            }
        }
        Err("Soloist closed its WebSocket".to_owned())
    })
    .await;
    match decided {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("Pair Harbor Soloist from the official Spotify app before playing.".into()),
    }
}
/// Reuse a private native control connection instead of establishing a new
/// WebSocket for every volume-slider update. All commands remain ordered.
// A new local play must never race the pause that hands a finished Soloist
// track back to Harbor's queue.
fn playback_handoff() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}
fn control() -> &'static tokio::sync::Mutex<Option<Socket>> {
    static SOCKET: OnceLock<tokio::sync::Mutex<Option<Socket>>> = OnceLock::new();
    SOCKET.get_or_init(|| tokio::sync::Mutex::new(None))
}
async fn command(app: &AppHandle, name: &str, fields: Value) -> Result<(), String> {
    let mut guard = control().lock().await;
    if guard.is_none() {
        let mut socket = connect(app).await?;
        authenticate(&mut socket).await?;
        *guard = Some(socket);
    }
    let mut message = json!({ "type": "command", "command": name });
    if let (Some(body), Some(fields)) = (message.as_object_mut(), fields.as_object()) {
        body.extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    let socket = guard.as_mut().expect("connected above");
    let result: Result<(), String> = async {
        socket
            .send(Message::Text(message.to_string().into()))
            .await
            .map_err(|_| "Cannot send command to Soloist".to_string())?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(frame) = socket.next().await {
                let event = payload(frame.map_err(|_| "Soloist command connection failed")?);
                let Some(event) = event else { continue };
                match event["type"].as_str() {
                    Some("command_result") if event["command"] == name => return Ok(()),
                    Some("error") => {
                        return Err(event["message"]
                            .as_str()
                            .unwrap_or("Soloist rejected the command")
                            .to_owned())
                    }
                    _ => {}
                }
            }
            Err("Soloist closed the command connection".into())
        })
        .await
        .map_err(|_| "Soloist did not acknowledge the command".to_string())?
    }
    .await;
    if result.is_err() {
        *guard = None;
    }
    result
}
fn emit(app: &AppHandle, track: &MusicTrack, event: &str, fields: Value) {
    let mut body = json!({
        "event":event, "trackId":track.id, "connectorId":"spotify",
    });
    if let (Some(target), Some(fields)) = (body.as_object_mut(), fields.as_object()) {
        target.extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    let _ = app.emit("music://event", body);
}
fn property(app: &AppHandle, track: &MusicTrack, name: &str, data: Value) {
    emit(
        app,
        track,
        "property-change",
        json!({"name":name,"data":data}),
    );
}
fn update_position(current: &mut Current, anchor: &Value) {
    if let (Some(ms), Some(timestamp)) = (
        anchor["position_ms"].as_u64(),
        anchor["timestamp_ms"].as_u64(),
    ) {
        current.anchor_ms = ms as f64;
        current.timestamp_ms = timestamp;
        current.speed = anchor["speed"].as_f64().unwrap_or(0.0).clamp(0.0, 4.0);
    }
}
/// Preserve the exact position when pausing or resuming even if Soloist sends
/// playback_changed before its next position_sync anchor.
fn set_playback_paused(current: &mut Current, paused: bool) {
    current.anchor_ms = position(current) * 1000.0;
    current.timestamp_ms = now_ms();
    current.speed = if paused { 0.0 } else { 1.0 };
    current.paused = paused;
}
/// While paused, ignore moving Soloist anchors; a seek with speed zero is
/// still valid. Otherwise a stale sync can make the Harbor clock advance.
fn should_apply_position_sync(current: &Current, event: &Value) -> bool {
    !current.paused || event["position"]["speed"].as_f64().unwrap_or(0.0) <= 0.0
}
/// A changed Spotify URI does not imply natural completion. Soloist sends
/// track_changed for manual skips and remote actions too; only an idle state
/// at the known track end can produce Harbor's EOF/queue advance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackTransition {
    Same,
    NaturalEnd,
    Displaced,
    Ignore,
}

fn track_transition(current: &Current, event: &Value) -> TrackTransition {
    track_transition_for_mode(current, event, super::single_track_mode())
}
fn track_transition_for_mode(
    current: &Current,
    event: &Value,
    single_track: bool,
) -> TrackTransition {
    let kind = event["type"].as_str().unwrap_or("");
    if current.ended {
        return TrackTransition::Ignore;
    }
    // A fresh event listener first receives state from the prior Connect song.
    // Do not treat those initial notifications as a takeover of the new request.
    // This grace period is only for displacement; matching track and EOF events
    // are still processed normally.
    let starting = (now_ms() / 1000).saturating_sub(current.started_at) < 3;
    if single_track {
        // In single-track mode Soloist's own process exit is the only EOF.
        // It may publish idle or a transient device state before the last
        // audio buffer has finished, so never cut Harbor's track short.
        if kind == "device_changed" {
            return TrackTransition::Ignore;
        }
        if kind != "track_changed" && kind != "playback_state" {
            return TrackTransition::Ignore;
        }
        if event["item"]["uri"].as_str() == Some(current.uri.as_str()) {
            return TrackTransition::Same;
        }
        if kind == "playback_state" && event["status"] == "idle" {
            return TrackTransition::Ignore;
        }
        // Soloist can report an unrelated Spotify autoplay item even in
        // --single-track mode just before it terminates. This is not an
        // external takeover: only process exit is authoritative for EOF.
        return TrackTransition::Ignore;
    }
    if kind == "device_changed" {
        return if !starting && current.loaded && event["is_active"] == false {
            TrackTransition::Displaced
        } else {
            TrackTransition::Ignore
        };
    }
    if kind != "track_changed" && kind != "playback_state" {
        return TrackTransition::Ignore;
    }
    if kind == "playback_state" && event["is_active"] == false {
        return if !starting && current.loaded {
            TrackTransition::Displaced
        } else {
            TrackTransition::Ignore
        };
    }
    // Daemon-backed playback can stall buffering at its true end. Single-track
    // mode instead waits for the subprocess exit to avoid premature EOF.
    if kind == "playback_state"
        && event["status"] == "buffering"
        && current.loaded
        && current.duration > 0.0
        && position(current) >= current.duration - 1.5
    {
        return TrackTransition::NaturalEnd;
    }
    if event["item"]["uri"].as_str() == Some(current.uri.as_str()) {
        return TrackTransition::Same;
    }
    if !current.loaded {
        // The event socket can initially report the previous Spotify song,
        // before Soloist accepts Harbor's new play(uri) command.
        return TrackTransition::Ignore;
    }
    if kind == "playback_state" {
        if event["status"] == "idle" && event["item"]["uri"].is_null() {
            return if current.duration > 0.0 && position(current) >= current.duration - 1.5 {
                TrackTransition::NaturalEnd
            } else {
                TrackTransition::Displaced
            };
        }
        if event["item"]["uri"].as_str().is_none() {
            return TrackTransition::Ignore;
        }
    }
    // Soloist can autoplay its next Spotify track without ever emitting idle.
    // When the previous Harbor track actually reached its end, advance
    // Harbor's own queue rather than treating Spotify's new URI as a takeover.
    // Mid-track remote skips remain external actions, not queue advancement.
    if !current.paused
        && current.duration > 0.0
        && event["item"]["uri"].as_str().is_some()
        && position(current) >= current.duration - 1.5
    {
        return TrackTransition::NaturalEnd;
    }
    if starting {
        TrackTransition::Ignore
    } else {
        TrackTransition::Displaced
    }
}

fn is_stray_single_track_item(current: &Current, event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some("track_changed" | "playback_state")
    ) && event["item"]["uri"]
        .as_str()
        .is_some_and(|uri| uri != current.uri)
}
enum Action {
    Loaded(MusicTrack),
    Pause(MusicTrack, bool),
    Position(MusicTrack, f64),
    Duration(MusicTrack, f64),
    End(MusicTrack, u64, f64),
    Volume(MusicTrack, f64),
    Displaced(MusicTrack),
}
fn process(app: &AppHandle, generation: u64, event: &Value) {
    let mut actions = Vec::new();
    {
        let mut guard = watch().lock();
        if guard.generation != generation {
            return;
        }
        let Some(current) = guard.current.as_mut() else {
            return;
        };
        let kind = event["type"].as_str().unwrap_or("");
        if super::single_track_mode()
            && current.loaded
            && is_stray_single_track_item(current, event)
        {
            current.awaiting_process_exit = true;
        }
        match kind {
            "track_changed" | "playback_state" => match track_transition(current, event) {
                TrackTransition::NaturalEnd => {
                    mark_listening(current);
                    current.ended = true;
                    actions.push(Action::End(
                        current.track.clone(),
                        current.started_at,
                        current.listened_seconds,
                    ));
                }
                TrackTransition::Displaced => {
                    mark_listening(current);
                    current.ended = true;
                    current.displaced = true;
                    current.paused = true;
                    current.speed = 0.0;
                    actions.push(Action::Displaced(current.track.clone()));
                }
                TrackTransition::Same if current.awaiting_process_exit => {}
                TrackTransition::Same => {
                    if !current.loaded {
                        current.loaded = true;
                        current.last_tick = Instant::now();
                        actions.push(Action::Loaded(current.track.clone()));
                    }
                    if let Some(duration) =
                        event["item"]["decorations"]["playback"]["duration_ms"].as_u64()
                    {
                        current.duration = duration as f64 / 1000.0;
                        actions.push(Action::Duration(current.track.clone(), current.duration));
                    }
                    if kind == "playback_state" {
                        mark_listening(current);
                        update_position(current, &event["position"]);
                        let status = event["status"].as_str().unwrap_or("");
                        if super::single_track_mode() && status == "buffering" {
                            // Freeze the clock during buffering but don't
                            // display a premature pause at the song boundary.
                            current.speed = 0.0;
                            actions
                                .push(Action::Position(current.track.clone(), position(current)));
                        } else if !(super::single_track_mode() && status == "idle") {
                            set_playback_paused(current, status != "playing");
                            actions.push(Action::Pause(current.track.clone(), current.paused));
                            actions
                                .push(Action::Position(current.track.clone(), position(current)));
                        }
                    }
                }
                TrackTransition::Ignore => {}
            },
            "playback_changed"
                if current.loaded && !current.ended && !current.awaiting_process_exit =>
            {
                if let Some(status) = event["status"].as_str() {
                    if status == "playing" || status == "paused" || status == "idle" {
                        mark_listening(current);
                        if super::single_track_mode() && status == "idle" {
                            // Wait for successful process exit, not its
                            // pre-end idle/crossfade notification.
                        } else {
                            let finished_at_end = status == "idle"
                                && current.duration > 0.0
                                && position(current) >= current.duration - 1.5;
                            if finished_at_end {
                                current.ended = true;
                                actions.push(Action::End(
                                    current.track.clone(),
                                    current.started_at,
                                    current.listened_seconds,
                                ));
                            } else {
                                set_playback_paused(current, status != "playing");
                                actions.push(Action::Pause(current.track.clone(), current.paused));
                            }
                        }
                    }
                }
            }
            "device_changed" if track_transition(current, event) == TrackTransition::Displaced => {
                mark_listening(current);
                current.ended = true;
                current.displaced = true;
                current.paused = true;
                current.speed = 0.0;
                actions.push(Action::Displaced(current.track.clone()));
            }
            "position_sync"
                if current.loaded && !current.ended && !current.awaiting_process_exit =>
            {
                mark_listening(current);
                if should_apply_position_sync(current, event) {
                    update_position(current, &event["position"]);
                    actions.push(Action::Position(current.track.clone(), position(current)));
                }
            }
            "volume_changed" if current.loaded && !current.ended => {
                if let Some(value) = event["volume"].as_f64() {
                    actions.push(Action::Volume(current.track.clone(), value));
                }
            }
            _ => {}
        }
    }
    for action in actions {
        if watch().lock().generation != generation {
            return;
        }
        match action {
            Action::Loaded(track) => {
                property(app, &track, "pause", json!(false));
                emit(app, &track, "file-loaded", json!({}));
            }
            Action::Pause(track, value) => property(app, &track, "pause", json!(value)),
            Action::Position(track, value) => property(app, &track, "time-pos", json!(value)),
            Action::Duration(track, value) => property(app, &track, "duration", json!(value)),
            Action::Volume(track, value) => property(app, &track, "volume", json!(value)),
            // External Spotify actions do not imply EOF or player failure.
            // Report the previous track as paused; never invalidate Harbor's
            // global play request or advance a queue from this notification.
            Action::Displaced(track) => {
                video_paused().store(false, Ordering::SeqCst);
                property(app, &track, "pause", json!(true));
            }
            Action::End(track, started_at, listened) => {
                let app = app.clone();
                tokio::spawn(async move {
                    let handoff = playback_handoff().lock().await;
                    if watch().lock().generation != generation {
                        return;
                    }
                    // Spotify may already be playing an unrelated autoplay
                    // track. Silence it BEFORE Harbor receives EOF and starts
                    // the next song from its own queue.
                    let mut force_stopped = false;
                    if command(&app, "pause", json!({})).await.is_err() {
                        reset_control().await;
                        if command(&app, "pause", json!({})).await.is_err() {
                            // Failing closed is safer than leaving Soloist
                            // playing independently of Harbor's queue.
                            if let Err(error) = super::terminate_managed() {
                                emit(&app, &track, "player-failure", json!({"reason":error}));
                                return;
                            }
                            force_stopped = true;
                        }
                    }
                    // A user-initiated stop invalidates this handoff. Only
                    // our own verified force-stop may still emit Harbor EOF.
                    if watch().lock().generation != generation && !force_stopped {
                        return;
                    }
                    drop(handoff);
                    emit(&app, &track, "end-file", json!({"reason":"eof"}));
                    if crate::music::engine::should_scrobble(
                        listened,
                        track.duration_seconds as f64,
                    ) {
                        if let Ok(true) =
                            crate::music::commands::scrobble_track(&app, &track, started_at).await
                        {
                            let _ = app.emit("music://lastfm", json!({"status":"scrobbled"}));
                        }
                    }
                });
            }
        }
    }
}
fn tick(app: &AppHandle, generation: u64) {
    let reading = {
        let mut guard = watch().lock();
        if guard.generation != generation {
            return;
        }
        let Some(current) = guard.current.as_mut() else {
            return;
        };
        if !current.loaded || current.paused || current.ended {
            return;
        }
        mark_listening(current);
        (current.track.clone(), position(current))
    };
    property(app, &reading.0, "time-pos", json!(reading.1));
}
fn fail(app: &AppHandle, generation: u64, message: &str) {
    let track = {
        let mut guard = watch().lock();
        if guard.generation != generation {
            return;
        }
        let Some(current) = guard.current.as_mut() else {
            return;
        };
        current.ended = true;
        current.paused = true;
        current.speed = 0.0;
        current.track.clone()
    };
    emit(app, &track, "player-failure", json!({"reason":message}));
}
/// Single-track mode exits normally after the *last* audio buffer. Trust
/// exit code 0, not Spotify's independent Connect queue or a coarse timer.
fn finish_single_track(app: &AppHandle, generation: u64, exit_code: i32) {
    if exit_code != 0 {
        fail(
            app,
            generation,
            if exit_code == 10 {
                "The Soloist build has expired. Install a current Soloist build."
            } else {
                "Soloist single-track playback exited unexpectedly. Check pairing and the installed build."
            },
        );
        return;
    }
    let finished = {
        let mut guard = watch().lock();
        if guard.generation != generation {
            return;
        }
        let Some(current) = guard.current.as_mut() else {
            return;
        };
        if current.ended {
            return;
        }
        if !current.loaded {
            drop(guard);
            fail(
                app,
                generation,
                "Soloist stopped before the requested track loaded.",
            );
            return;
        }
        mark_listening(current);
        current.ended = true;
        (
            current.track.clone(),
            current.started_at,
            current.listened_seconds,
            current.duration,
        )
    };
    let (track, started_at, listened, duration) = finished;
    if duration > 0.0 {
        property(app, &track, "time-pos", json!(duration));
    }
    emit(app, &track, "end-file", json!({"reason":"eof"}));
    if crate::music::engine::should_scrobble(listened, track.duration_seconds as f64) {
        let app = app.clone();
        tokio::spawn(async move {
            if let Ok(true) = crate::music::commands::scrobble_track(&app, &track, started_at).await
            {
                let _ = app.emit("music://lastfm", json!({"status":"scrobbled"}));
            }
        });
    }
}
// Do not depend on the WebSocket being closed at precisely the same time as
// the single-track subprocess. Soloist may leave its socket alive after audio
// finishes, so checking only *after* socket.next() breaks leaves Harbor stuck
// on the last song and never advances its own queue.
fn process_single_track_exit(app: &AppHandle, generation: u64) -> bool {
    if let Some(code) = super::single_track_exit() {
        finish_single_track(app, generation, code);
        true
    } else {
        false
    }
}
async fn listen(app: AppHandle, generation: u64) {
    let mut failures = 0u8;
    loop {
        if watch().lock().generation != generation {
            return;
        }
        if process_single_track_exit(&app, generation) {
            return;
        }
        if let Ok(mut socket) = connect(&app).await {
            failures = 0;
            let mut clock = tokio::time::interval(Duration::from_millis(400));
            clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    frame = socket.next() => match frame {
                        Some(Ok(frame)) => if let Some(event) = payload(frame) {
                            if event["type"] == "auth_state" && event["logged_in"] == false {
                                fail(&app, generation, "Soloist needs to be paired again.");
                                return;
                            }
                            process(&app, generation, &event);
                        },
                        _ => break,
                    },
                    _ = clock.tick() => {
                        if process_single_track_exit(&app, generation) {
                            return;
                        }
                        tick(&app, generation);
                    },
                }
                if watch().lock().generation != generation {
                    return;
                }
            }
        }
        if process_single_track_exit(&app, generation) {
            return;
        }
        failures = failures.saturating_add(1);
        if failures >= 12 {
            fail(
                &app,
                generation,
                "Soloist connection was lost. Check its setup in Music Connections.",
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
fn cancel() {
    super::capture::reset();
    let mut guard = watch().lock();
    guard.generation = guard.generation.wrapping_add(1);
    if let Some(task) = guard.task.take() {
        task.abort();
    }
    guard.current = None;
    video_paused().store(false, Ordering::SeqCst);
}
fn observe(app: AppHandle, track: MusicTrack, uri: String) {
    super::capture::reset();
    let mut guard = watch().lock();
    guard.generation = guard.generation.wrapping_add(1);
    if let Some(task) = guard.task.take() {
        task.abort();
    }
    let generation = guard.generation;
    guard.current = Some(Current {
        duration: track.duration_seconds as f64,
        track,
        uri,
        loaded: false,
        ended: false,
        displaced: false,
        awaiting_process_exit: false,
        paused: false,
        anchor_ms: 0.0,
        timestamp_ms: now_ms(),
        speed: 1.0,
        started_at: now_ms() / 1000,
        listened_seconds: 0.0,
        last_tick: Instant::now(),
    });
    video_paused().store(false, Ordering::SeqCst);
    guard.task = Some(tokio::spawn(listen(app, generation)));
}
fn percent(volume: f64) -> u8 {
    if !volume.is_finite() {
        return 82;
    }
    (volume.clamp(0.0, 1.0) * 100.0).round() as u8
}
pub async fn play(app: &AppHandle, track: MusicTrack, volume: f64) -> Result<(), String> {
    let _handoff = playback_handoff().lock().await;
    let uri = track
        .source_id
        .as_deref()
        .filter(|id| {
            (id.starts_with("spotify:track:") && id.len() > 14)
                || (id.starts_with("spotify:episode:") && id.len() > 16)
        })
        .ok_or("Spotify track is missing a valid URI")?
        .to_owned();
    // Spotify Connect mode carries an autonomous recommendation queue.
    // Harbor must own queue advancement, so play this URI in a dedicated
    // single-track subprocess instead (Spotify-supported --single-track).
    super::start_harbor_track(app, &uri, percent(volume)).await?;
    observe(app.clone(), track, uri);
    // The process starts its URI and volume itself. Never send play(uri) or
    // activate a separate Connect context that could restore Spotify autoplay.
    Ok(())
}
fn owns_output() -> bool {
    watch()
        .lock()
        .current
        .as_ref()
        .is_some_and(|current| !current.displaced)
}
pub async fn pause(app: &AppHandle, paused: bool) -> Result<(), String> {
    if !owns_output() {
        return Ok(());
    }
    let result = command(app, if paused { "pause" } else { "play" }, json!({})).await;
    if result.is_ok() {
        // An explicit pause or resume supersedes a prior video auto-pause.
        video_paused().store(false, Ordering::SeqCst);
    }
    result
}
pub async fn seek(app: &AppHandle, seconds: f64) -> Result<(), String> {
    if !owns_output() {
        return Ok(());
    }
    if !seconds.is_finite() {
        return Err("Music seek position is invalid".into());
    }
    command(
        app,
        "seek",
        json!({"position_ms":(seconds.max(0.0)*1000.0).min(u64::MAX as f64) as u64}),
    )
    .await
}
pub async fn set_volume(app: &AppHandle, volume: f64) -> Result<(), String> {
    if !owns_output() {
        return Ok(());
    }
    command(app, "set_volume", json!({"volume":percent(volume)})).await
}
pub async fn stop(app: &AppHandle, resume: bool) -> Result<(), String> {
    if resume {
        if video_paused().swap(false, Ordering::SeqCst) {
            return pause(app, false).await;
        }
        return Ok(());
    }
    // Finish any pending end-of-track handoff before stopping the daemon.
    let _handoff = playback_handoff().lock().await;
    // If another Spotify client has taken over, closing Harbor must not
    // pause the new song or deactivate a device that Harbor no longer owns.
    let owned = owns_output();
    super::capture::release_process();
    cancel();
    if super::single_track_mode() {
        // Does not advertise a Connect device and has no autonomous queue.
        // Terminate only Harbor's own process, not another Spotify device.
        return super::terminate_managed();
    }
    if !owned || !running() {
        return Ok(());
    }
    // A cached WebSocket can go stale even while the Soloist child is alive.
    // Retry once with a fresh connection before falling back to terminating
    // only Harbor's managed child. Never block the next audio engine merely
    // because Soloist is no longer answering its pause command.
    if command(app, "pause", json!({})).await.is_err() {
        reset_control().await;
        if command(app, "pause", json!({})).await.is_err() {
            return super::terminate_managed();
        }
    }
    // Release Spotify Connect when switching to a different local source.
    let _ = command(app, "deactivate", json!({})).await;
    Ok(())
}
pub fn paused_for_video() -> bool {
    video_paused().load(Ordering::SeqCst)
}
pub async fn pause_for_video(app: &AppHandle) -> Result<bool, String> {
    if snapshot().is_none_or(|state| !state.live || state.paused) {
        return Ok(false);
    }
    pause(app, true).await?;
    video_paused().store(true, Ordering::SeqCst);
    Ok(true)
}
pub async fn resume_after_video(app: &AppHandle) -> Result<(), String> {
    if video_paused().swap(false, Ordering::SeqCst) {
        pause(app, false).await
    } else {
        Ok(())
    }
}
pub async fn reset_control() {
    *control().lock().await = None;
}
pub fn shutdown() {
    cancel();
    if let Ok(mut socket) = control().try_lock() {
        socket.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_track_waits_for_process_exit_instead_of_early_connect_idle() {
        let mut current = test_current();
        current.anchor_ms = 179_000.0;
        current.timestamp_ms = now_ms();
        current.speed = 0.0;
        let idle = json!({"type":"playback_state","status":"idle","item":null});
        assert_eq!(
            track_transition_for_mode(&current, &idle, false),
            TrackTransition::NaturalEnd
        );
        assert_eq!(
            track_transition_for_mode(&current, &idle, true),
            TrackTransition::Ignore
        );
        let new_song = json!({"type":"track_changed","item":{"uri":"spotify:track:unrelated"}});
        assert_eq!(
            track_transition_for_mode(&current, &new_song, false),
            TrackTransition::NaturalEnd
        );
        // In a single-track process, Soloist can advertise the next Spotify
        // autoplay URI just before exit. Never mark Harbor as displaced:
        // doing that suppresses the process-exit EOF and stalls the queue.
        assert_eq!(
            track_transition_for_mode(&current, &new_song, true),
            TrackTransition::Ignore
        );
        assert!(is_stray_single_track_item(&current, &new_song));
        let mut waiting = test_current();
        waiting.awaiting_process_exit = true;
        assert!(waiting.awaiting_process_exit);
        assert!(!is_stray_single_track_item(
            &current,
            &json!({
                "type":"playback_state","item":{"uri":"spotify:track:one"}
            })
        ));
        let matching = json!({"type":"playback_state","status":"playing",
            "item":{"uri":"spotify:track:one"}});
        assert_eq!(
            track_transition_for_mode(&current, &matching, true),
            TrackTransition::Same
        );
    }
    #[test]
    fn volume_is_clamped() {
        assert_eq!(percent(-4.0), 0);
        assert_eq!(percent(2.0), 100);
        assert_eq!(percent(f64::NAN), 82);
        assert_eq!(percent(0.5), 50);
    }

    fn test_current() -> Current {
        Current {
            track: MusicTrack {
                explicit: None,
                version: None,
                media_kind: None,
                id: "spotify:track:one".into(),
                connector_id: Some("spotify".into()),
                source_id: Some("spotify:track:one".into()),
                playback_url: None,
                title: "Song".into(),
                artist: "Artist".into(),
                album: None,
                artwork: String::new(),
                duration_seconds: 180,
                duration_label: "3:00".into(),
            },
            uri: "spotify:track:one".into(),
            loaded: true,
            ended: false,
            displaced: false,
            awaiting_process_exit: false,
            paused: false,
            anchor_ms: 42_000.0,
            timestamp_ms: now_ms(),
            speed: 1.0,
            duration: 180.0,
            started_at: (now_ms() / 1000).saturating_sub(5),
            listened_seconds: 0.0,
            last_tick: Instant::now(),
        }
    }
    #[test]
    fn a_pause_freezes_position_without_waiting_for_another_sync_event() {
        let mut current = test_current();
        set_playback_paused(&mut current, true);
        assert_eq!(current.speed, 0.0);
        assert!(current.paused);
        let previous = position(&current);
        std::thread::sleep(Duration::from_millis(3));
        assert_eq!(position(&current), previous);
        set_playback_paused(&mut current, false);
        assert_eq!(current.speed, 1.0);
        assert!(!current.paused);
    }
    #[test]
    fn position_is_bounded_by_duration() {
        let mut current = test_current();
        current.anchor_ms = 185_000.0;
        assert_eq!(position(&current), 180.0);
    }

    #[test]
    fn external_song_changes_never_advance_the_harbor_queue() {
        let current = test_current();
        let switched = json!({"type":"track_changed","item":{"uri":"spotify:track:other"}});
        assert_eq!(
            track_transition(&current, &switched),
            TrackTransition::Displaced
        );
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"playback_state", "status":"playing", "is_active":true,
                    "item":{"uri":"spotify:track:other"}
                })
            ),
            TrackTransition::Displaced
        );

        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"playback_state", "status":"paused", "is_active":true,
                    "item":{"uri":"spotify:track:other"}
                })
            ),
            TrackTransition::Displaced
        );

        // A mid-song remote skip does not advance Harbor's queue.
        let mut not_finished = test_current();
        not_finished.anchor_ms = 170_000.0;
        not_finished.timestamp_ms = now_ms();
        not_finished.speed = 0.0;
        assert_eq!(
            track_transition(&not_finished, &switched),
            TrackTransition::Displaced
        );
        // Soloist may start autoplay with track_changed, skipping idle.
        let mut near_end = test_current();
        near_end.anchor_ms = 179_900.0;
        near_end.timestamp_ms = now_ms();
        near_end.speed = 0.0;
        assert_eq!(
            track_transition(&near_end, &switched),
            TrackTransition::NaturalEnd
        );
        assert_eq!(
            track_transition(
                &near_end,
                &json!({
                    "type":"playback_state", "status":"playing", "is_active":true,
                    "item":{"uri":"spotify:track:autoplay"}
                })
            ),
            TrackTransition::NaturalEnd
        );
        assert_eq!(
            track_transition(
                &near_end,
                &json!({
                    "type":"playback_state", "status":"idle", "item":null
                })
            ),
            TrackTransition::NaturalEnd
        );
    }

    #[test]
    fn stop_or_device_transfer_does_not_trigger_recovery_or_eof() {
        let current = test_current();
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"playback_state", "status":"idle", "item":null
                })
            ),
            TrackTransition::Displaced
        );
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"device_changed", "is_active":false
                })
            ),
            TrackTransition::Displaced
        );
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"playback_state", "status":"paused", "is_active":false,
                    "item":{"uri":"spotify:track:one"}
                })
            ),
            TrackTransition::Displaced
        );
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"track_changed", "item":{"uri":"spotify:track:one"}
                })
            ),
            TrackTransition::Same
        );
    }

    #[test]
    fn startup_events_from_the_prior_connect_session_are_ignored() {
        let mut current = test_current();
        current.started_at = now_ms() / 1000;
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"track_changed", "item":{"uri":"spotify:track:previous"}
                })
            ),
            TrackTransition::Ignore
        );
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"device_changed", "is_active":false
                })
            ),
            TrackTransition::Ignore
        );
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"playback_state", "status":"idle", "is_active":false,
                    "item":{"uri":"spotify:track:previous"}
                })
            ),
            TrackTransition::Ignore
        );
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"playback_state", "status":"playing", "item":{"uri":"spotify:track:one"}
                })
            ),
            TrackTransition::Same
        );
    }

    #[test]
    fn old_events_cannot_displace_a_pending_or_completed_play_request() {
        let mut current = test_current();
        current.loaded = false;
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"track_changed", "item":{"uri":"spotify:track:previous"}
                })
            ),
            TrackTransition::Ignore
        );
        current.loaded = true;
        current.ended = true;
        assert_eq!(
            track_transition(
                &current,
                &json!({
                    "type":"track_changed", "item":{"uri":"spotify:track:next"}
                })
            ),
            TrackTransition::Ignore
        );
    }
}
