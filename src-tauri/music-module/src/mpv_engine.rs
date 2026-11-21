//! Experimental MPV music decks hosted outside of harbor.exe.
//! The Tauri command facade remains in the application until event transport and
//! audio settings parity are validated. Shared libmpv stays in the installer.
use libmpv2::{Mpv, Format};
use crate::audio::MusicAudioSettings;
use crate::{meter, spectrum};
use std::sync::Mutex;
use libmpv2::events::{Event, EventContext, PropertyData};
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
use serde_json::json;
use std::io::Write;
use std::ffi::{CString, c_char};

#[repr(transparent)]
pub(crate) struct NativeFlag(pub i32);
unsafe impl libmpv2::GetData for NativeFlag {
    fn get_format() -> libmpv2::Format { libmpv2::Format::Flag }
}
use serde::Serialize;

/// Position updates reach the host at most this often; see `spawn_mpv_events`.
const POSITION_EVENT_GAP: std::time::Duration = std::time::Duration::from_millis(200);

#[derive(Default)]
struct Deck {
    player: Option<Arc<Mpv>>,
    generation: Arc<AtomicU64>,
    threads: Vec<std::thread::JoinHandle<()>>,
    track_id: Option<String>,
    connector_id: Option<String>,
    source_url: Option<String>,
    volume: f64,
    gain: f64,
    spectrum: Arc<Mutex<spectrum::Spectrum>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSnapshot {
    pub deck: u8,
    pub live: bool,
    pub track_id: Option<String>,
    pub connector_id: Option<String>,
    pub volume: f64,
    pub paused: Option<bool>,
    pub position_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub gain: f64,
}

pub struct MusicMpvEngine {
    decks: [Deck; 2],
    crossfade: f64,
    settings: MusicAudioSettings,
    meter_enabled: bool,
    broadcast_device: Option<String>,
    broadcast_generation: Arc<AtomicU64>,
    sync_threads: Vec<std::thread::JoinHandle<()>>,
}

impl Default for MusicMpvEngine {
    fn default() -> Self {
        Self { decks: [
            Deck { volume: 0.82, gain: 1.0, ..Deck::default() },
            Deck { volume: 0.82, gain: 0.0, ..Deck::default() },
        ], crossfade: -1.0, settings: MusicAudioSettings::default(), meter_enabled: false, broadcast_device: None, broadcast_generation: Arc::new(AtomicU64::new(0)), sync_threads: Vec::new() }
    }
}

fn deck_index(deck: u8) -> Result<usize, String> {
    (deck <= 1).then_some(usize::from(deck))
        .ok_or_else(|| "Music deck must be 0 or 1".into())
}

/// Replacing a session must leave nothing of the outgoing one alive: libmpv teardown
/// resets FFmpeg's process-wide callback, so a context destroyed after its successor
/// starts can take the new player down with it. Signal the event loop, join it, then drop
/// the player. Concurrent decks (A/B, broadcast) remain deliberate and unaffected.
fn retire_player(deck: &mut Deck) -> Result<(), String> {
    deck.generation.fetch_add(1, Ordering::SeqCst);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    join_threads(&mut deck.threads, deadline)?;
    deck.player = None;
    Ok(())
}

/// Join finished workers, bounded by `deadline`. On timeout every handle stays tracked,
/// so a later retire can still finish the job instead of detaching threads.
fn join_threads(
    threads: &mut Vec<std::thread::JoinHandle<()>>,
    deadline: std::time::Instant,
) -> Result<(), String> {
    while let Some(thread) = threads.pop() {
        while !thread.is_finished() {
            if std::time::Instant::now() >= deadline {
                threads.push(thread);
                return Err("Music player is still shutting down. Try again.".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let _ = thread.join();
    }
    Ok(())
}

fn checked_level(value: f64) -> Result<f64, String> {
    if !value.is_finite() || !(0.0..=6.0).contains(&value) {
        return Err("Music volume is invalid".into());
    }
    Ok(value)
}

pub(crate) fn mpv_argv_command(player:&Mpv,args:&[&str])->Result<(),String> {
    let args:Vec<CString>=args.iter().map(|s|CString::new(*s)
        .map_err(|_|"Invalid NUL in music command".to_string())).collect::<Result<_,_>>()?;
    let mut ptrs:Vec<*const c_char>=args.iter().map(|s|s.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    // Native mpv command accepts a NULL-terminated array of arguments. CString
    // instances own the buffers until the synchronous function has returned.
    let status=unsafe{libmpv2_sys::mpv_command(player.ctx.as_ptr(),ptrs.as_mut_ptr())};
    if status<0 {Err(format!("Music mpv command failed: {status}"))} else {Ok(())}
}

fn apply_audio(player: &Mpv, settings: &MusicAudioSettings) -> Result<(),String> {
    let replay = if settings.dsp_bypass || settings.replay_gain=="off" {
        "no"
    } else {settings.replay_gain.as_str()};
    for (key,value) in [
        ("replaygain", replay), ("replaygain-clip","no"),
        ("replaygain-preamp","0"), ("replaygain-fallback","0"),
    ] {player.set_property(key,value).map_err(|e|format!("{key}: {e}"))?;}
    player.set_property("volume-max", settings.volume_limit*100.0)
        .map_err(|e|format!("Music volume ceiling: {e}"))?;
    let filter=settings.filter();
    player.set_property("af",filter.as_str())
        .map_err(|e|format!("Music DSP filters: {e}"))?;
    player.set_property("speed",settings.speed).map_err(|e|e.to_string())?;
    player.set_property("audio-pitch-correction",
        if settings.keep_pitch {"yes"} else {"no"}).map_err(|e|e.to_string())?;
    player.set_property("audio-exclusive",
        if settings.exclusive {"yes"} else {"no"}).map_err(|e|e.to_string())?;
    player.set_property("audio-samplerate",i64::from(settings.sample_rate))
        .map_err(|e|e.to_string())?;
    player.set_property("audio-device",settings.device.as_str())
        .map_err(|e|e.to_string())?;
    Ok(())
}

fn apply_stream_headers(player:&Mpv,headers:&std::collections::BTreeMap<String,String>)
    ->Result<(),String>{
    use libmpv2_sys::{mpv_format_MPV_FORMAT_NODE,mpv_format_MPV_FORMAT_NODE_ARRAY,
        mpv_format_MPV_FORMAT_STRING,mpv_node,mpv_node__bindgen_ty_1,mpv_node_list};
    if headers.len()>16 {return Err("Too many Music source headers".into());}
    let mut strings=Vec::new();
    for (name,value) in headers{
        if name.is_empty()||name.len()>128||value.len()>8192||
            !name.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'-'||c==b'_')||
            value.chars().any(|c|c=='\r'||c=='\n'||c=='\0'){
            return Err("Music source headers are invalid".into());
        }
        if name.eq_ignore_ascii_case("user-agent"){
            player.set_property("user-agent",value.as_str()).map_err(|e|e.to_string())?;
        }else{
            strings.push(CString::new(format!("{name}: {value}")).map_err(|e|e.to_string())?);
        }
    }
    let mut nodes:Vec<mpv_node>=strings.iter().map(|v|mpv_node{
        u:mpv_node__bindgen_ty_1{string:v.as_ptr().cast_mut()},
        format:mpv_format_MPV_FORMAT_STRING
    }).collect();
    let mut list=mpv_node_list{num:nodes.len() as i32,
        values:if nodes.is_empty(){std::ptr::null_mut()}else{nodes.as_mut_ptr()},
        keys:std::ptr::null_mut()};
    let mut node=mpv_node{u:mpv_node__bindgen_ty_1{list:&mut list},
        format:mpv_format_MPV_FORMAT_NODE_ARRAY};
    let status=unsafe{libmpv2_sys::mpv_set_property(player.ctx.as_ptr(),
        b"http-header-fields\0".as_ptr().cast(),mpv_format_MPV_FORMAT_NODE,
        (&mut node as *mut mpv_node).cast())};
    if status<0{Err("Music source headers could not be applied".into())}else{Ok(())}
}

fn new_player(label: &str) -> Result<Mpv, String> {
    Mpv::with_initializer(|init| {
        for (key, value) in [
            ("title", label), ("audio-client-name", label),
            ("video", "no"), ("vo", "null"), ("force-window", "no"),
            ("terminal", "no"), ("idle", "yes"), ("keep-open", "yes"),
            ("ytdl", "no"), ("volume-max", "600"),
            // mpv's default of 0 lets a stalled HTTP read wait forever.
            ("network-timeout", "30"),
        ] {
            init.set_property(key, value)?;
        }
        // Automated functional probes must never seize the user's audio output.
        if std::env::var("HARBOR_MUSIC_TEST_NO_AUDIO").as_deref() == Ok("1") {
            init.set_property("ao", "null")?;
        }
        Ok(())
    }).map_err(|error| format!("Music module MPV: {error}"))
}

impl MusicMpvEngine {
    pub fn settings(&self) -> MusicAudioSettings {self.settings.clone()}

    pub fn set_settings(&mut self, settings: MusicAudioSettings) -> Result<MusicAudioSettings,String> {
        let updated=settings.normalized();
        // Apply to currently active decks before adopting the new settings.
        // If any update fails, restore the previous configuration.
        for (index,deck) in self.decks.iter().enumerate() {
            if let Some(player)=deck.player.as_ref() {
                let mut requested=updated.clone();
                if index==1 {
                    if let Some(device)=self.broadcast_device.as_ref() {
                        requested.device=device.clone();
                        requested.exclusive=false;
                    }
                }
                if let Err(error)=apply_audio(player,&requested) {
                    for old in &self.decks {
                        if let Some(player)=old.player.as_ref() {
                            let _=apply_audio(player,&self.settings);
                        }
                    }
                    return Err(error);
                }
            }
        }
        self.settings=updated.clone();
        Ok(updated)
    }

    pub fn play(&mut self, deck: u8, url: &str, track_id: &str, connector_id: Option<&str>, volume: f64,
        headers:&std::collections::BTreeMap<String,String>) -> Result<(), String> {
        let index = deck_index(deck)?;
        let volume = checked_level(volume)?;
        if index==1 && self.broadcast_device.is_some() {
            return Err("Deck B is carrying the broadcast".into());
        }
        if url.trim().is_empty() || url.len() > 16384 || url.contains('\0') {
            return Err("Music stream URL is invalid".into());
        }
        if track_id.len() > 1024 {
            return Err("Music track identifier too long".into());
        }
        // A track change during a broadcast retires the mirror and deck B before the
        // replacement primary exists, so no outgoing context outlives a new one.
        let restart_broadcast = if index == 0 { self.broadcast_device.clone() } else { None };
        if restart_broadcast.is_some() {
            self.broadcast_stop()?;
        }
        // Stop the prior event loop before replacing its native session.
        {
            let deck = &mut self.decks[index];
            retire_player(deck)?;
        }
        let generation = self.decks[index].generation.load(Ordering::SeqCst);
        let player = new_player(if index == 0 { "Harbor Music" } else { "Harbor Music B" })?;
        apply_audio(&player,&self.settings)?;
        apply_stream_headers(&player,headers)?;
        if self.meter_enabled && index==0 {
            meter::set_enabled(&player,true)?;
        }
        player.set_property("volume", self.settings.clamp_volume(volume) * self.decks[index].gain * 100.0)
            .map_err(|e| format!("Music volume: {e}"))?;
        // libmpv2 command accepts an argument vector; the source string is kept
        // as a single argument rather than interpolated into a shell command.
        let player = Arc::new(player);
        let spectrum = Arc::new(Mutex::new(spectrum::Spectrum::default()));
        let thread = spawn_mpv_events(player.clone(), self.decks[index].generation.clone(), generation,
            track_id.to_owned(), connector_id.map(str::to_owned), deck, spectrum.clone())?;
        // Track the session before the fallible load: a failed loadfile must still be
        // retired with its worker instead of leaving a detached thread and player behind.
        self.decks[index].threads.push(thread);
        self.decks[index].player = Some(player.clone());
        if let Err(error) = mpv_argv_command(&player, &["loadfile", url, "replace"]) {
            let _ = retire_player(&mut self.decks[index]);
            return Err(error);
        }
        self.decks[index].track_id = Some(track_id.to_owned());
        self.decks[index].connector_id = connector_id.map(str::to_owned);
        self.decks[index].source_url=Some(url.to_owned());
        self.decks[index].volume = self.settings.clamp_volume(volume);
        self.decks[index].spectrum = spectrum;
        if index==0 {
            if let Some(device)=restart_broadcast {
                self.broadcast_start(&device)?;
            }
        }
        Ok(())
    }

    pub fn meter_enabled(&mut self, enabled: bool) -> Result<(), String> {
        if self.meter_enabled == enabled {
            return Ok(());
        }
        for (index,deck) in self.decks.iter().enumerate() {
            if index==0 {
                if let Some(player)=&deck.player {
                    meter::set_enabled(player,enabled)?;
                }
            }
            if let Ok(mut spectrum)=deck.spectrum.lock() { spectrum.clear(); }
        }
        self.meter_enabled=enabled;
        Ok(())
    }

    pub fn meter_snapshot(&self, deck:u8) -> Result<Option<meter::MusicMeterSnapshot>,String> {
        let index=deck_index(deck)?;
        if !self.meter_enabled || index!=0 {return Ok(None);}
        let state=&self.decks[index];
        let (Some(player),Some(track_id))=(&state.player,&state.track_id) else {return Ok(None)};
        let mut snapshot=meter::snapshot(player,track_id,state.connector_id.as_deref());
        if snapshot.active {
            if let (Ok(spectrum),Ok(position))=(state.spectrum.lock(),player.get_property::<f64>("time-pos")) {
                snapshot.spectrum_db=spectrum.at(position);
            }
        }
        Ok(Some(snapshot))
    }

    pub fn broadcast_status(&self) -> serde_json::Value {
        let Some(device)=&self.broadcast_device else {
            return serde_json::json!({"active":false,"device":null,"product":null,"trackId":null,"driftMs":null});
        };
        let a=self.snapshot(0).ok();
        let b=self.snapshot(1).ok();
        let drift=match (a.as_ref().and_then(|a|a.position_seconds),b.as_ref().and_then(|b|b.position_seconds)) {
            (Some(a),Some(b))=>Some((b-a)*1000.0),
            _=>None
        };
        serde_json::json!({"active":true,"device":device,"product":null,
            "trackId":b.and_then(|v|v.track_id),"driftMs":drift})
    }

    pub fn broadcast_start(&mut self,device:&str)->Result<serde_json::Value,String>{
        if device.trim().is_empty() || device.len()>500 || device.chars().any(char::is_control) {
            return Err("Invalid Music broadcast output".into());
        }
        if self.broadcast_device.is_some(){self.broadcast_stop()?;}
        if self.decks[1].player.is_some(){
            return Err("Deck B is already playing. Stop it before broadcasting.".into());
        }
        let source=self.decks[0].source_url.clone();
        let track=self.decks[0].track_id.clone();
        let connector=self.decks[0].connector_id.clone();
        if let (Some(source),Some(track))=(source,track) {
            retire_player(&mut self.decks[1])?;
            let player=new_player("Harbor Music Broadcast")?;
            let mut settings=self.settings.clone();
            settings.device=device.to_owned();
            settings.exclusive=false;
            apply_audio(&player,&settings)?;
            player.set_property("volume",self.decks[0].volume*100.0)
                .map_err(|e|e.to_string())?;
            let original=self.snapshot(0)?;
            let player=Arc::new(player);
            let generation=self.decks[1].generation.load(Ordering::SeqCst);
            let spectrum=Arc::new(Mutex::new(spectrum::Spectrum::default()));
            let thread=spawn_mpv_events(player.clone(),self.decks[1].generation.clone(),generation,
                track.clone(),connector.clone(),1,spectrum.clone())?;
            // Track the session before the fallible load, exactly as normal playback does.
            self.decks[1].threads.push(thread);
            self.decks[1].player=Some(player.clone());
            if let Err(error)=mpv_argv_command(&player,&["loadfile",&source,"replace"]){
                let _=retire_player(&mut self.decks[1]);
                return Err(error);
            }
            if let Some(position)=original.position_seconds.filter(|value|*value>0.05){
                let _=mpv_argv_command(&player,&["seek",&position.to_string(),"absolute"]);
            }
            if original.paused.unwrap_or(false){
                let _=player.set_property("pause",true);
            }
            self.decks[1].track_id=Some(track);
            self.decks[1].connector_id=connector;
            self.decks[1].source_url=Some(source);
            self.decks[1].spectrum=spectrum;
            self.decks[1].volume=self.decks[0].volume;
        }
        self.broadcast_device=Some(device.to_owned());
        let generation=self.broadcast_generation.fetch_add(1,Ordering::SeqCst)+1;
        if let (Some(source),Some(mirror))=(&self.decks[0].player,&self.decks[1].player){
            let active=self.broadcast_generation.clone();
            let source=source.clone();
            let mirror=mirror.clone();
            let handle=std::thread::spawn(move||{
                while active.load(Ordering::SeqCst)==generation {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    if active.load(Ordering::SeqCst)!=generation {break;}
                    let a=source.get_property::<f64>("time-pos").ok();
                    let b=mirror.get_property::<f64>("time-pos").ok();
                    let paused=source.get_property::<NativeFlag>("pause").ok().is_some_and(|v|v.0!=0);
                    let _=mirror.set_property("pause",paused);
                    if let (Some(a),Some(b))=(a,b){
                        if (a-b).abs()>0.15 && a>=0.0 && a.is_finite(){
                            let _=mpv_argv_command(&mirror,&["seek",&a.to_string(),"absolute+exact"]);
                        }
                    }
                }
            });
            self.sync_threads.push(handle);
        }
        Ok(self.broadcast_status())
    }

    pub fn broadcast_stop(&mut self)->Result<serde_json::Value,String>{
        self.retire_sync_threads()?;
        if self.broadcast_device.is_some(){
            // Retire deck B first: if its worker will not exit, the broadcast stays marked
            // active so a later play() cannot slip in a new primary beside the old mirror.
            self.stop_deck(1)?;
            self.broadcast_device=None;
        }
        Ok(self.broadcast_status())
    }

    pub fn paused(&mut self, deck: u8, paused: bool) -> Result<(), String> {
        let index = deck_index(deck)?;
        if let Some(player) = &self.decks[index].player {
            player.set_property("pause", paused).map_err(|e| e.to_string())?;
        }
        if index==0 && self.broadcast_device.is_some() {
            if let Some(player)=&self.decks[1].player {
                let _=player.set_property("pause",paused);
            }
        }
        Ok(())
    }

    pub fn seek(&mut self, deck: u8, seconds: f64) -> Result<(), String> {
        let index = deck_index(deck)?;
        if !seconds.is_finite() || seconds < 0.0 {
            return Err("Music seek position is invalid".into());
        }
        if let Some(player) = &self.decks[index].player {
            mpv_argv_command(player, &["seek", &seconds.to_string(), "absolute"])?;
        }
        if index==0 && self.broadcast_device.is_some() {
            if let Some(player)=&self.decks[1].player{
                let _=mpv_argv_command(player,&["seek",&seconds.to_string(),"absolute"]);
            }
        }
        Ok(())
    }

    pub fn set_loop(&mut self, deck: u8, start: Option<f64>, end: Option<f64>) -> Result<(), String> {
        let index=deck_index(deck)?;
        let point=|value:Option<f64>| -> Result<String,String> {
            match value {
                Some(v) if v.is_finite() && v>=0.0 => Ok(format!("{v:.3}")),
                None => Ok("no".into()),
                _ => Err("Music loop point invalid".into()),
            }
        };
        let start=point(start)?;
        let end=point(end)?;
        if let Some(player)=&self.decks[index].player {
            player.set_property("ab-loop-a",start.as_str()).map_err(|e|e.to_string())?;
            player.set_property("ab-loop-b",end.as_str()).map_err(|e|e.to_string())?;
        }
        Ok(())
    }

    pub fn scratch(&mut self, deck: u8, position: f64, rate: f64, holding: bool) -> Result<f64,String> {
        let index=deck_index(deck)?;
        if !position.is_finite() || position<0.0 || !rate.is_finite() {
            return Err("Music scratch input invalid".into());
        }
        let Some(player)=&self.decks[index].player else{return Ok(position)};
        let target=format!("{position:.3}");
        if holding {
            let _=player.set_property("audio-pitch-correction","no");
            let _=player.set_property("speed",rate.abs().clamp(0.25,4.0));
        } else {
            let _=player.set_property("speed",1.0);
        }
        mpv_argv_command(player,&["seek",target.as_str(),"absolute+exact"])?;
        Ok(player.get_property::<f64>("time-pos").unwrap_or(position))
    }

    pub fn mute(&mut self, deck:u8, muted:bool) -> Result<(),String> {
        let index=deck_index(deck)?;
        if let Some(player)=&self.decks[index].player {
            player.set_property("mute", if muted {"yes"} else {"no"})
                .map_err(|e|e.to_string())?;
        }
        Ok(())
    }

    pub fn volume(&mut self, deck: u8, volume: f64) -> Result<(), String> {
        let index = deck_index(deck)?;
        let volume = checked_level(volume)?;
        let state = &mut self.decks[index];
        if let Some(player) = &state.player {
            player.set_property("volume", volume * state.gain * 100.0)
                .map_err(|e| e.to_string())?;
        }
        state.volume = volume;
        Ok(())
    }

    pub fn stop(&mut self, deck: u8) -> Result<(), String> {
        let index = deck_index(deck)?;
        if index == 1 && self.broadcast_device.is_some() {
            // Deck B is the broadcast mirror: stopping it stops the broadcast, so its
            // synchronization worker is retired with it instead of outliving the player.
            return self.broadcast_stop().map(|_| ());
        }
        self.stop_deck(index)
    }

    fn stop_deck(&mut self, index: usize) -> Result<(), String> {
        if index==0 && self.broadcast_device.is_some(){
            self.retire_sync_threads()?;
            // The mirror outlived its source: retire deck B before deck A.
            self.stop_deck(1)?;
        }
        retire_player(&mut self.decks[index])?;
        self.decks[index].track_id = None;
        self.decks[index].connector_id = None;
        self.decks[index].source_url=None;
        Ok(())
    }

    /// The broadcast mirror holds both deck players. Bump its generation and join it so
    /// the outgoing sessions are released before any replacement is created.
    fn retire_sync_threads(&mut self) -> Result<(), String> {
        self.broadcast_generation.fetch_add(1, Ordering::SeqCst);
        join_threads(
            &mut self.sync_threads,
            std::time::Instant::now() + std::time::Duration::from_secs(2),
        )
    }

    pub fn crossfade(&mut self, position: f64) -> Result<(), String> {
        if !position.is_finite() || !(-1.0..=1.0).contains(&position) {
            return Err("Music crossfade position is invalid".into());
        }
        let left = if position <= 0.0 { 1.0 } else { 1.0 - position };
        let right = if position >= 0.0 { 1.0 } else { 1.0 + position };
        for (index, gain) in [left, right].into_iter().enumerate() {
            let state = &mut self.decks[index];
            if self.broadcast_device.is_some() && index==1 {continue;}
            if let Some(player) = &state.player {
                player.set_property("volume", state.volume * gain * 100.0)
                    .map_err(|e| e.to_string())?;
            }
            state.gain = gain;
        }
        self.crossfade = position;
        Ok(())
    }

    pub fn snapshot(&self, deck: u8) -> Result<DeckSnapshot, String> {
        let index = deck_index(deck)?;
        let state = &self.decks[index];
        let player = state.player.as_ref();
        Ok(DeckSnapshot {
            deck,
            live: player.is_some(),
            track_id: state.track_id.clone(),
            connector_id: state.connector_id.clone(),
            volume: state.volume,
            paused: player.and_then(|p| p.get_property::<NativeFlag>("pause").ok().map(|v| v.0 != 0)),
            position_seconds: player.and_then(|p| p.get_property::<f64>("time-pos").ok()),
            duration_seconds: player.and_then(|p| p.get_property::<f64>("duration").ok()),
            gain: state.gain,
        })
    }
}


// stderr is a distinct framed event channel. stdout remains request/reply only.
pub(crate) fn emit_event(payload: serde_json::Value) {
    let framed=json!({
        "kind":"music-event", "abi":1, "version":env!("CARGO_PKG_VERSION"),
        "channel":"music://event", "payload":payload
    });
    let stderr=std::io::stderr();
    let mut output=stderr.lock();
    if serde_json::to_writer(&mut output,&framed).is_ok() {
        let _=output.write_all(b"\n");
    }
}

fn playback_end_reason(event: &Event<'_>, eof_signaled: &mut bool) -> Option<&'static str> {
    let reason = match event {
        Event::PropertyChange { name: "eof-reached", change: PropertyData::Flag(reached), .. } => {
            if !reached {
                *eof_signaled = false;
                return None;
            }
            "eof"
        }
        Event::EndFile(reason) => match reason {
            0 => "eof",
            2 => "stop",
            3 => "quit",
            4 => "error",
            5 => "redirect",
            _ => "other",
        },
        _ => return None,
    };
    if reason == "eof" {
        if *eof_signaled { return None; }
        *eof_signaled = true;
    }
    Some(reason)
}

fn spawn_mpv_events(
    player: Arc<Mpv>,
    active_generation: Arc<AtomicU64>,
    generation: u64,
    track_id: String,
    connector_id: Option<String>,
    deck: u8,
    spectrum: Arc<Mutex<spectrum::Spectrum>>,
) -> Result<std::thread::JoinHandle<()>, String> {
    let mut context=EventContext::new(player.ctx);
    for (name,format,id) in [
        ("time-pos",Format::Double,1),("duration",Format::Double,2),
        ("pause",Format::Flag,3),("volume",Format::Double,4),
        ("eof-reached",Format::Flag,5),
    ] {
        context.observe_property(name,format,id)
            .map_err(|e|format!("Music event subscription: {e}"))?;
    }
    Ok(std::thread::spawn(move || {
        let mut eof_signaled = false;
        let mut last_position = std::time::Instant::now() - POSITION_EVENT_GAP;
        while active_generation.load(Ordering::SeqCst)==generation {
            let Some(Ok(event))=context.wait_event(0.25) else {continue};
            if let Event::LogMessage {prefix,text,..} = &event {
                if *prefix=="ffmpeg" {
                    if let Ok(mut value)=spectrum.lock(){value.ingest(text);}
                }
                continue;
            }
            if matches!(event,Event::Seek){
                if let Ok(mut value)=spectrum.lock(){value.clear();}
            }
            // Observed `time-pos` fires at mpv's own cadence, often many times a second. Each
            // event is a JSON line on the event pipe plus an IPC message and a host re-render, so
            // emitting all of them saturates the UI main thread for no extra accuracy. Keep the
            // same 5 Hz the in-process deck delivers.
            if matches!(event,Event::PropertyChange{name:"time-pos",..}) {
                if last_position.elapsed()<POSITION_EVENT_GAP {continue;}
                last_position=std::time::Instant::now();
            }
            // keep-open retains the file at EOF, so EndFile may never arrive.
            let end_reason = playback_end_reason(&event, &mut eof_signaled);
            let output=match event {
                Event::FileLoaded=>Some(json!({"event":"file-loaded"})),
                Event::Seek=>Some(json!({"event":"seek"})),
                Event::EndFile(_)=>None,
                Event::Shutdown=>break,
                Event::PropertyChange {name,change,..}=>{
                    let data=match change {
                        PropertyData::Flag(value)=>json!(value),
                        PropertyData::Double(value)=>json!(value),
                        PropertyData::Int64(value)=>json!(value),
                        PropertyData::Str(value)=>json!(value),
                        PropertyData::OsdStr(value)=>json!(value),
                        PropertyData::Node(_)=>continue,
                    };
                    Some(json!({"event":"property-change","name":name,"data":data}))
                },
                _=>None,
            };
            if let Some(mut output)=output {
                output["trackId"]=json!(track_id);
                output["connectorId"]=json!(connector_id);
                output["deck"]=json!(deck);
                emit_event(output);
            }
            if let Some(reason) = end_reason {
                emit_event(json!({"event":"end-file","reason":reason,
                    "trackId":track_id,"connectorId":connector_id,"deck":deck}));
            }
        }
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn eof_event(reached: bool) -> Event<'static> {
        Event::PropertyChange { name: "eof-reached", change: PropertyData::Flag(reached), reply_userdata: 5 }
    }

    #[test]
    fn a_timed_out_retire_keeps_every_worker_tracked() {
        let mut threads = vec![std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(400))
        })];
        assert!(join_threads(&mut threads, std::time::Instant::now()).is_err());
        assert_eq!(threads.len(), 1, "an unfinished worker must stay tracked");
        assert!(join_threads(
            &mut threads,
            std::time::Instant::now() + std::time::Duration::from_secs(2)
        )
        .is_ok());
        assert!(threads.is_empty(), "a later retire finishes the job");
    }

    #[test]
    fn keep_open_completion_is_emitted_once_and_rearms_after_replay() {
        let mut signaled = false;
        assert_eq!(playback_end_reason(&eof_event(false), &mut signaled), None);
        assert_eq!(playback_end_reason(&eof_event(true), &mut signaled), Some("eof"));
        assert_eq!(playback_end_reason(&eof_event(true), &mut signaled), None);
        assert_eq!(playback_end_reason(&Event::EndFile(0), &mut signaled), None);
        assert_eq!(playback_end_reason(&eof_event(false), &mut signaled), None);
        assert_eq!(playback_end_reason(&Event::EndFile(0), &mut signaled), Some("eof"));
        assert_eq!(playback_end_reason(&eof_event(true), &mut signaled), None);
    }

    #[test]
    fn stops_and_errors_are_not_natural_completion() {
        for (code, expected) in [(2, "stop"), (3, "quit"), (4, "error"), (5, "redirect"), (99, "other")] {
            let mut signaled = false;
            assert_eq!(playback_end_reason(&Event::EndFile(code), &mut signaled), Some(expected));
            assert!(!signaled);
        }
    }
    #[test]
    fn rejects_untrusted_input_before_opening_mpv() {
        let mut engine = MusicMpvEngine::default();
        assert!(engine.play(2, "http://example.test", "x", None, 0.5, &std::collections::BTreeMap::new()).is_err());
        assert!(engine.play(0, "", "x", None, 0.5, &std::collections::BTreeMap::new()).is_err());
        assert!(engine.play(0, "file.mp3", "x", None, f64::NAN, &std::collections::BTreeMap::new()).is_err());
        assert!(engine.seek(0, f64::INFINITY).is_err());
        assert!(engine.crossfade(2.0).is_err());
        assert!(!engine.snapshot(0).unwrap().live);
    }
    #[test]
    fn deck_gain_starts_on_a() {
        let engine = MusicMpvEngine::default();
        assert_eq!(engine.snapshot(0).unwrap().gain, 1.0);
        assert_eq!(engine.snapshot(1).unwrap().gain, 0.0);
    }
}
