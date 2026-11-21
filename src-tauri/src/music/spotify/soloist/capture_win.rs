//! Capture the managed Soloist process with Windows WASAPI process loopback.
//! The output remains with Soloist. No system mix, microphone, disk recording,
//! or second playback session is created.
use super::Signal;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use wasapi::{AudioClient, Direction, SampleType, ShareMode, WaveFormat};

struct Worker {
    pid: u32,
    cancel: Arc<AtomicBool>,
    task: JoinHandle<()>,
}
struct Capture {
    enabled: bool,
    source: Option<Arc<Mutex<Signal>>>,
    worker: Option<Worker>,
    retry_at: Instant,
    error: Arc<Mutex<Option<String>>>,
}
fn capture() -> &'static Mutex<Capture> {
    static INSTANCE: OnceLock<Mutex<Capture>> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Mutex::new(Capture {
            enabled: false,
            source: None,
            worker: None,
            retry_at: Instant::now(),
            error: Arc::new(Mutex::new(None)),
        })
    })
}
pub(super) fn set_enabled(enabled: bool, source: Arc<Mutex<Signal>>) {
    if let Ok(mut manager) = capture().lock() {
        manager.enabled = enabled;
        manager.source = if enabled { Some(source) } else { None };
        if !enabled {
            if let Ok(mut error) = manager.error.lock() {
                *error = None;
            }
        }
    }
    // Enabling is a request, not proof that Soloist is currently playing.
    // Start lazily from snapshot() after the engine has become ACTIVE_SOLOIST;
    // this also handles a visualizer mounted before the first Soloist track.
    if !enabled {
        stop_worker();
    }
}
fn stop_worker() {
    let worker = capture()
        .lock()
        .ok()
        .and_then(|mut manager| manager.worker.take());
    if let Some(worker) = worker {
        worker.cancel.store(true, Ordering::Release);
        let _ = worker.task.join();
    }
}
pub(super) fn release_process() {
    // Preserve the meter subscription so the next managed PID can be tapped.
    stop_worker();
}
pub(super) fn error() -> Option<String> {
    let manager = capture().lock().ok()?;
    let value = manager.error.lock().ok()?.clone();
    value
}
pub(super) fn ensure_started() {
    let Some(pid) = super::super::managed_pid() else {
        return;
    };
    let old = {
        let Ok(mut manager) = capture().lock() else {
            return;
        };
        if !manager.enabled {
            return;
        }
        if manager
            .worker
            .as_ref()
            .is_some_and(|worker| worker.pid == pid && !worker.task.is_finished())
        {
            return;
        }
        if Instant::now() < manager.retry_at {
            return;
        }
        manager.worker.take()
    };
    if let Some(worker) = old {
        worker.cancel.store(true, Ordering::Release);
        if worker.task.is_finished() {
            let _ = worker.task.join();
        }
    }
    let Ok(mut manager) = capture().lock() else {
        return;
    };
    if !manager.enabled {
        return;
    }
    let Some(source) = manager.source.clone() else {
        return;
    };
    // Keep the last error visible until a capture stream starts successfully.
    let error = Arc::clone(&manager.error);
    let cancel = Arc::new(AtomicBool::new(false));
    let token = Arc::clone(&cancel);
    manager.retry_at = Instant::now() + Duration::from_secs(2);
    if let Ok(task) = thread::Builder::new()
        .name("harbor-soloist-meter".into())
        .spawn(move || {
            if let Err(reason) = run(pid, &token, &source, &error) {
                if !token.load(Ordering::Acquire) {
                    if let Ok(mut last) = error.lock() {
                        *last = Some(reason);
                    }
                }
            }
        })
    {
        manager.worker = Some(Worker { pid, cancel, task });
    } else if let Ok(mut last) = manager.error.lock() {
        *last = Some("Could not start the Soloist audio capture thread.".into());
    }
}
fn run(
    pid: u32,
    cancel: &AtomicBool,
    meter: &Mutex<Signal>,
    last_error: &Mutex<Option<String>>,
) -> Result<(), String> {
    // wasapi already ships with Harbor and implements the Windows activation
    // callback, PROCESS_LOOPBACK BLOB and WAVEFORMATEXTENSIBLE correctly.
    wasapi::initialize_mta()
        .ok()
        .map_err(|e| format!("WASAPI COM initialization failed: {e}"))?;
    let mut client = AudioClient::new_application_loopback_client(pid, true)
        .map_err(|e| format!("WASAPI process activation failed: {e}"))?;
    if cancel.load(Ordering::Acquire) {
        return Ok(());
    }
    let format = WaveFormat::new(32, 32, &SampleType::Float, super::RATE as usize, 2, None);
    client
        .initialize_client(&format, 0, &Direction::Capture, &ShareMode::Shared, true)
        .map_err(|e| format!("WASAPI capture initialization failed: {e}"))?;
    // The wasapi wrapper selects EVENTCALLBACK on initialization. Set the
    // event handle even though we poll with a bounded shutdown interval.
    let _event = client
        .set_get_eventhandle()
        .map_err(|e| format!("WASAPI event setup failed: {e}"))?;
    let reader = client
        .get_audiocaptureclient()
        .map_err(|e| format!("WASAPI capture client unavailable: {e}"))?;
    client
        .start_stream()
        .map_err(|e| format!("WASAPI capture start failed: {e}"))?;
    if let Ok(mut error) = last_error.lock() {
        *error = None;
    }
    let result = (|| -> Result<(), String> {
        let mut bytes = Vec::new();
        let mut samples = Vec::new();
        while !cancel.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(12));
            for _ in 0..16 {
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                let available = reader
                    .get_next_nbr_frames()
                    .map_err(|e| format!("WASAPI capture packet size failed: {e}"))?
                    .unwrap_or(0);
                if available == 0 {
                    break;
                }
                let byte_count = available as usize * 8; // stereo f32
                if byte_count > 1024 * 1024 {
                    return Err("WASAPI capture packet unexpectedly large.".into());
                }
                bytes.resize(byte_count, 0);
                let (read, flags) = reader
                    .read_from_device(&mut bytes)
                    .map_err(|e| format!("WASAPI capture read failed: {e}"))?;
                if let Ok(mut analysis) = meter.lock() {
                    if flags.silent {
                        analysis.ingest_silence(read as usize);
                    } else {
                        samples.clear();
                        samples.extend(bytes[..read as usize * 8].chunks_exact(4).map(|chunk| {
                            f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
                        }));
                        analysis.ingest(&samples);
                    }
                }
            }
        }
        Ok(())
    })();
    let _ = client.stop_stream();
    result
}
