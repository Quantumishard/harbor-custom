//! Opt-in Soloist visualizer metering.
//!
//! Soloist does not expose decoded PCM through its WebSocket API. On Windows,
//! capture only the managed Soloist process output via WASAPI process loopback.
//! Never capture the system mix, create a second player, or persist PCM.
//! Other platforms return unavailable until their process-specific taps exist.
use crate::music::engine::{MusicMeterChannel, MusicMeterSnapshot};
use realfft::RealFftPlanner;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

// WASAPI process loopback uses a stable stereo float format for metering.
const RATE: u32 = 48_000;
const CHANNELS: usize = 2;
const FRAMES: usize = RATE as usize / 20;
const FFT_SIZE: usize = 2048;
const BANDS: [f64; 8] = [60.0, 120.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];
const MIN_DB: f64 = -120.0;
const MAX_DB: f64 = 24.0;

fn db(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        MIN_DB
    } else {
        (20.0 * value.log10()).clamp(MIN_DB, MAX_DB)
    }
}
struct Signal {
    window: Vec<f32>,
    channels: [MusicMeterChannel; CHANNELS],
    bands: [f64; 8],
    last_seen: Option<Instant>,
    planner: RealFftPlanner<f32>,
}
impl Signal {
    fn new() -> Self {
        Self {
            window: Vec::with_capacity(FRAMES * CHANNELS),
            channels: std::array::from_fn(|_| MusicMeterChannel {
                rms_db: MIN_DB,
                peak_db: MIN_DB,
            }),
            bands: [MIN_DB; 8],
            last_seen: None,
            planner: RealFftPlanner::new(),
        }
    }
    fn reset(&mut self) {
        self.window.clear();
        for channel in &mut self.channels {
            channel.rms_db = MIN_DB;
            channel.peak_db = MIN_DB;
        }
        self.bands.fill(MIN_DB);
        self.last_seen = None;
    }
    fn ingest(&mut self, input: &[f32]) {
        for stereo in input.chunks_exact(CHANNELS) {
            self.window.extend_from_slice(stereo);
            if self.window.len() == FRAMES * CHANNELS {
                self.analyze();
            }
        }
    }
    fn ingest_silence(&mut self, frames: usize) {
        // Avoid allocating large zero buffers on silent loopback packets.
        for _ in 0..frames {
            self.window.extend_from_slice(&[0.0; CHANNELS]);
            if self.window.len() == FRAMES * CHANNELS {
                self.analyze();
            }
        }
    }
    fn analyze(&mut self) {
        let mut peaks = [0.0_f64; CHANNELS];
        let mut squares = [0.0_f64; CHANNELS];
        for frame in self.window.chunks_exact(CHANNELS) {
            for (ch, sample) in frame.iter().enumerate() {
                let v = f64::from(*sample);
                if v.is_finite() {
                    squares[ch] += v * v;
                    peaks[ch] = peaks[ch].max(v.abs());
                }
            }
        }
        for ch in 0..CHANNELS {
            self.channels[ch].rms_db = db((squares[ch] / FRAMES as f64).sqrt());
            self.channels[ch].peak_db = db(peaks[ch]);
        }
        let start = FRAMES - FFT_SIZE;
        let mut samples = vec![0.0_f32; FFT_SIZE];
        let mut energy = 0.0_f64;
        for (index, stereo) in self.window.chunks_exact(CHANNELS).skip(start).enumerate() {
            let window = 0.5
                - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / (FFT_SIZE - 1) as f32).cos();
            samples[index] = (stereo[0] + stereo[1]) * 0.5 * window;
            energy += f64::from(window * window);
        }
        if energy > 0.0 {
            let fft = self.planner.plan_fft_forward(FFT_SIZE);
            let mut output = fft.make_output_vec();
            if fft.process(&mut samples, &mut output).is_ok() {
                let bin_hz = RATE as f64 / FFT_SIZE as f64;
                for (index, center) in BANDS.iter().enumerate() {
                    let first = ((center / 2_f64.sqrt()) / bin_hz).ceil().max(1.0) as usize;
                    let last =
                        (((center * 2_f64.sqrt()) / bin_hz).floor() as usize).min(FFT_SIZE / 2);
                    let power: f64 = output[first..=last]
                        .iter()
                        .map(|value| f64::from(value.re * value.re + value.im * value.im))
                        .sum();
                    self.bands[index] = db((2.0 * power / (FFT_SIZE as f64 * energy)).sqrt());
                }
            }
        } else {
            self.bands.fill(MIN_DB);
        }
        self.last_seen = Some(Instant::now());
        self.window.clear();
    }
    fn reading(&self, track: &super::playback::Snapshot) -> Option<MusicMeterSnapshot> {
        // The visualizers should never display stale readings after a pause,
        // process exit, or missed audio stream.
        let recent = self
            .last_seen
            .is_some_and(|at| at.elapsed() < Duration::from_millis(300));
        if self.last_seen.is_none() {
            return None;
        }
        Some(MusicMeterSnapshot {
            track_id: track.track_id.clone(),
            connector_id: Some("spotify".into()),
            active: recent && track.live && !track.paused,
            channels: self
                .channels
                .iter()
                .map(|c| MusicMeterChannel {
                    rms_db: c.rms_db,
                    peak_db: c.peak_db,
                })
                .collect(),
            spectrum_db: self.bands.to_vec(),
            output_sample_rate_hz: Some(RATE),
            output_channels: Some("stereo".into()),
            output_device: None,
            output_backend: Some("soloist-process-loopback".into()),
        })
    }
}
fn signal() -> &'static Arc<Mutex<Signal>> {
    static SIGNAL: OnceLock<Arc<Mutex<Signal>>> = OnceLock::new();
    SIGNAL.get_or_init(|| Arc::new(Mutex::new(Signal::new())))
}

#[cfg(windows)]
#[path = "capture_win.rs"]
mod win;

pub fn set_enabled(enabled: bool) {
    #[cfg(windows)]
    win::set_enabled(enabled, Arc::clone(signal()));
    #[cfg(not(windows))]
    let _ = enabled;
    if !enabled {
        reset();
    }
}
pub fn reset() {
    if let Ok(mut meter) = signal().lock() {
        meter.reset();
    }
}
pub fn release_process() {
    #[cfg(windows)]
    win::release_process();
    reset();
}
pub fn error() -> Option<String> {
    #[cfg(windows)]
    {
        win::error()
    }
    #[cfg(not(windows))]
    {
        None
    }
}
pub fn snapshot() -> Option<MusicMeterSnapshot> {
    #[cfg(windows)]
    win::ensure_started();
    let track = super::playback::snapshot()?;
    signal().lock().ok()?.reading(&track)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn soloist_tone_produces_measured_channels_and_correct_octave() {
        let mut meter = Signal::new();
        let mut wave = Vec::new();
        for frame in 0..FRAMES * 3 {
            let v = ((2.0 * std::f64::consts::PI * 1000.0 * frame as f64 / RATE as f64).sin() * 0.5)
                as f32;
            wave.extend([v, v]);
        }
        meter.ingest(&wave);
        assert!(meter.channels.iter().all(|c| (c.rms_db + 9.0).abs() < 1.5));
        let loudest = meter
            .bands
            .iter()
            .position(|x| {
                x == &meter
                    .bands
                    .iter()
                    .copied()
                    .fold(f64::NEG_INFINITY, f64::max)
            })
            .unwrap();
        assert_eq!(loudest, 4);
        meter.reset();
        assert!(meter.last_seen.is_none());
    }
    #[test]
    fn a_silent_loopback_packet_does_not_invent_audio() {
        let mut meter = Signal::new();
        meter.ingest_silence(FRAMES);
        assert!(meter.bands.iter().all(|v| *v == MIN_DB));
        assert!(meter.channels.iter().all(|c| c.rms_db == MIN_DB));
    }
}
