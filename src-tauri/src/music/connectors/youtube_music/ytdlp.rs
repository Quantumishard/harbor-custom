//! Stream resolution through yt-dlp.
//!
//! Hand-rolled innertube still returns a player response, and the URLs inside it still look
//! ordinary, but YouTube only serves roughly the first megabyte of them before answering 403
//! to everything else. ffmpeg opens every stream with `Range: bytes=0-`, so it is refused on
//! its very first read and mpv reports MPV_ERROR_LOADING_FAILED. yt-dlp carries the PO token
//! and signature work that keeps a URL whole, and it is updated as YouTube tightens.
//!
//! The borrowed session is a fallback, never the first choice: anonymous extraction resolves
//! public audio faster, so the session is only used when anonymous extraction is refused and
//! the media actually needs the account.

use super::super::super::{MusicStream, MusicVideoStream};
use std::path::PathBuf;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(45);
const FORMAT: &str = "bestaudio[acodec=opus]/bestaudio/best";
// Muxed YouTube formats stop at 720p, so the video track is fetched on its own and mpv is
// handed the audio alongside it. `best` is the fallback for anything with no split rendition.
const SEPARATOR: &str = "|||";

/// yt-dlp only accepts cookies from a file. The file holds the listener's Google session, so
/// it lives for the extraction and is removed on the way out, never persisted.
struct CookieFile(PathBuf);

impl Drop for CookieFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn cookie_file() -> Option<CookieFile> {
    let session = super::auth::current()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
        "harbor-ytmusic-{}-{stamp}.cookies",
        std::process::id()
    ));
    if let Err(error) = std::fs::write(&path, super::auth::netscape(&session.cookies)) {
        // Never fail playback for a filesystem hiccup, but do not hide the downgrade either.
        note_downgrade(&format!(
            "session cookie file could not be written ({:?})",
            error.kind()
        ));
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(CookieFile(path))
}

fn cookie_args(file: &Option<CookieFile>) -> Vec<String> {
    file.as_ref()
        .map(|file| {
            vec![
                "--cookies".to_string(),
                file.0.to_string_lossy().into_owned(),
            ]
        })
        .unwrap_or_default()
}

/// The session is an upgrade, not a requirement: extraction still works anonymously when the
/// borrowed cookies cannot be used. Say so instead of pretending the account was ignored.
fn note_downgrade(reason: &str) {
    crate::music::trace::log(format!("music session downgraded to anonymous: {reason}"));
    eprintln!("[harbor::music] session downgraded to anonymous: {reason}");
}

/// Anonymous extraction answers public audio about 1.7s faster than a cookie-authenticated
/// one, so the session is the retry for the content that actually needs it.
fn note_session_retry(reason: &str) {
    crate::music::trace::log(format!(
        "anonymous extraction failed, retrying with the session: {reason}"
    ));
}

fn stream_args(video_id: &str, cookies: &Option<CookieFile>) -> Vec<String> {
    let mut args = vec![
        "--js-runtimes".to_string(),
        "node".to_string(),
        "--extractor-args".to_string(),
        "youtube:player_client=tv_embedded".to_string(),
        "--no-playlist".to_string(),
        "-f".to_string(),
        FORMAT.to_string(),
        "--print".to_string(),
        format!("%(url)s{SEPARATOR}%(ext)s{SEPARATOR}%(abr)s{SEPARATOR}%(http_headers)j"),
    ];
    args.extend(cookie_args(cookies));
    args.push(format!("https://www.youtube.com/watch?v={video_id}"));
    args
}

async fn extract_audio(
    app: &tauri::AppHandle,
    video_id: &str,
    cookies: &Option<CookieFile>,
) -> Result<MusicStream, String> {
    crate::ytdlp_update::run_validated(
        app,
        stream_args(video_id, cookies),
        TIMEOUT,
        "music stream",
        |output| async move {
            let stream = parse(&String::from_utf8_lossy(&output.stdout))?;
            super::super::super::stream_probe::validate_stream(stream).await
        },
    )
    .await
}

pub async fn stream(app: &tauri::AppHandle, video_id: &str) -> Result<MusicStream, String> {
    let cookies = cookie_file();
    // Public audio extracts faster anonymously; only restricted media needs the account. Try
    // anonymously first and fall back to the session, rather than paying that cost on every song.
    match extract_audio(app, video_id, &None).await {
        Ok(stream) => Ok(stream),
        Err(anonymous_error) if cookies.is_some() => {
            note_session_retry(&anonymous_error);
            extract_audio(app, video_id, &cookies).await
        }
        Err(error) => Err(error),
    }
}

fn video_args(video_id: &str, cap: u32, cookies: &Option<CookieFile>) -> Vec<String> {
    let mut args = vec![
        "--js-runtimes".to_string(),
        "node".to_string(),
        "--extractor-args".to_string(),
        "youtube:player_client=tv_embedded".to_string(),
        "--no-playlist".to_string(),
        "-f".to_string(),
        video_format(cap),
        "--dump-single-json".to_string(),
    ];
    args.extend(cookie_args(cookies));
    args.push(format!("https://www.youtube.com/watch?v={video_id}"));
    args
}

async fn extract_video(
    app: &tauri::AppHandle,
    video_id: &str,
    cap: u32,
    cookies: &Option<CookieFile>,
) -> Result<MusicVideoStream, String> {
    let output =
        crate::ytdlp_update::run(app, video_args(video_id, cap, cookies), TIMEOUT, "music video")
            .await?;
    parse_video(&String::from_utf8_lossy(&output.stdout))
}

/// The music video behind a track, for the YouTube Music style video pane.
pub async fn video_stream(
    app: &tauri::AppHandle,
    video_id: &str,
    max_height: Option<u32>,
) -> Result<MusicVideoStream, String> {
    let cap = max_height.unwrap_or(1080).clamp(144, 2160);
    let cookies = cookie_file();
    match extract_video(app, video_id, cap, &None).await {
        Ok(stream) => Ok(stream),
        Err(anonymous_error) if cookies.is_some() => {
            note_session_retry(&anonymous_error);
            extract_video(app, video_id, cap, &cookies).await
        }
        Err(error) => Err(error),
    }
}

/// Format selection for a video height cap.
///
/// H.264 tops out at 1080p on YouTube, so above that the cap has to outrank the codec or a
/// 1440/2160 request silently came back as 1080. Below it, keep the compatible avc1 pick.
fn video_format(cap: u32) -> String {
    if cap <= 1080 {
        format!(
            "bestvideo[height<={cap}][vcodec^=avc1][protocol^=https]+bestaudio[acodec^=mp4a][protocol^=https]/bestvideo[height<={cap}][protocol^=https]+bestaudio[protocol^=https]/best"
        )
    } else {
        format!(
            "bestvideo[height<={cap}][protocol^=https]+bestaudio[acodec^=mp4a][protocol^=https]/bestvideo[height<={cap}][protocol^=https]+bestaudio[protocol^=https]/best"
        )
    }
}

fn parse_video(stdout: &str) -> Result<MusicVideoStream, String> {
    let payload: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|_| "YouTube Music did not return video metadata".to_string())?;
    let formats = payload
        .get("requested_formats")
        .and_then(serde_json::Value::as_array);
    let video = formats
        .and_then(|formats| formats.iter().find(|format| format.get("vcodec").and_then(serde_json::Value::as_str).is_some_and(|codec| codec != "none")))
        .or_else(|| formats.and_then(|formats| formats.first()))
        .unwrap_or(&payload);
    if video.get("vcodec").and_then(serde_json::Value::as_str) == Some("none") {
        return Err("YouTube Music returned audio without a video track".to_string());
    }
    let audio = formats.and_then(|formats| formats.iter().find(|format| !std::ptr::eq(*format, video)));
    let read_url = |format: &serde_json::Value| {
        format
            .get("url")
            .and_then(serde_json::Value::as_str)
            .filter(|url| url.starts_with("https://"))
            .map(str::to_string)
            .ok_or_else(|| "YouTube Music did not return a video stream".to_string())
    };
    let headers =
        |format: &serde_json::Value| -> Result<std::collections::BTreeMap<String, String>, String> {
            serde_json::from_value(
                format
                    .get("http_headers")
                    .or_else(|| payload.get("http_headers"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            )
            .map_err(|_| "YouTube Music returned invalid video request headers".to_string())
        };
    let http_headers = headers(video)?;
    if audio.is_some_and(|audio| headers(audio).ok().as_ref() != Some(&http_headers)) {
        return Err(
            "YouTube Music returned incompatible audio and video request headers".to_string(),
        );
    }
    let mut heights: Vec<u32> = payload
        .get("formats")
        .and_then(serde_json::Value::as_array)
        .map(|formats| {
            formats
                .iter()
                .filter(|format| format.get("vcodec").and_then(serde_json::Value::as_str) != Some("none"))
                .filter_map(|format| format.get("height").and_then(serde_json::Value::as_u64))
                .filter_map(|height| u32::try_from(height).ok())
                .filter(|height| (144..=2160).contains(height))
                .collect::<std::collections::BTreeSet<u32>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default();
    heights.truncate(12);
    MusicStream {
        url: String::new(),
        mime_type: String::new(),
        bitrate: 0,
        http_headers: http_headers.clone(),
    }
    .request_headers()?;
    Ok(MusicVideoStream {
        url: read_url(video)?,
        audio_url: audio.map(read_url).transpose()?,
        http_headers,
        available_heights: heights,
    })
}

fn parse(stdout: &str) -> Result<MusicStream, String> {
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("https://"))
        .ok_or_else(|| "yt-dlp did not return an audio URL".to_string())?;
    let mut parts = line.split(SEPARATOR);
    let url = parts.next().unwrap_or_default().trim();
    if !url.starts_with("https://") {
        return Err("yt-dlp did not return an audio URL".to_string());
    }
    let extension = parts.next().unwrap_or_default().trim();
    // yt-dlp prints NA for anything it could not determine; neither field is load bearing
    // for playback, so an unusable value degrades to a sensible default rather than failing.
    let bitrate = parts
        .next()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .map(|kbps| (kbps * 1000.0).round() as u64)
        .unwrap_or(0);
    let http_headers = parts
        .next()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| "YouTube Music returned invalid request headers".to_string())?
        .unwrap_or_default();
    let stream = MusicStream {
        url: url.to_string(),
        mime_type: mime_of(extension),
        bitrate,
        http_headers,
    };
    stream.request_headers()?;
    Ok(stream)
}

fn mime_of(extension: &str) -> String {
    match extension {
        "webm" | "opus" => "audio/webm",
        "m4a" | "mp4" => "audio/mp4",
        "mp3" => "audio/mpeg",
        _ => "audio/webm",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_extraction_never_passes_a_cookie_file() {
        let args = stream_args("dQw4w9WgXcQ", &None);
        assert!(!args.iter().any(|arg| arg == "--cookies"));
    }

    #[test]
    fn a_session_extraction_passes_a_short_lived_cookie_file() {
        let path = std::env::temp_dir().join(format!(
            "harbor-ytmusic-test-{}-{}.cookies",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::write(&path, "# Netscape HTTP Cookie File\n").expect("test cookie file");
        let cookies = Some(CookieFile(path.clone()));
        let audio = stream_args("dQw4w9WgXcQ", &cookies);
        let at = audio
            .iter()
            .position(|arg| arg == "--cookies")
            .expect("cookie argument");
        assert_eq!(audio[at + 1].as_str(), path.to_string_lossy().as_ref());
        assert!(audio
            .iter()
            .any(|arg| arg == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
        let video = video_args("dQw4w9WgXcQ", 1080, &cookies);
        assert!(video.iter().any(|arg| arg == "--cookies"));
        drop(cookies);
        assert!(!path.exists(), "the borrowed cookie file is removed on drop");
    }

    #[test]
    fn a_high_cap_does_not_prefer_h264() {
        assert!(video_format(1080).contains("vcodec^=avc1"));
        assert!(video_format(720).contains("vcodec^=avc1"));
        assert!(!video_format(1440).contains("avc1"));
        assert!(!video_format(2160).contains("avc1"));
        assert!(video_format(1440).contains("height<=1440"));
    }

    #[test]
    fn video_resolution_rejects_audio_only_and_accepts_reordered_tracks() {
        assert!(parse_video(r#"{"url":"https://example.com/audio","vcodec":"none"}"#).is_err());
        let stream = parse_video(r#"{"requested_formats":[{"url":"https://example.com/audio","vcodec":"none","acodec":"opus"},{"url":"https://example.com/video","vcodec":"vp9","acodec":"none"}]}"#).unwrap();
        assert_eq!(stream.url, "https://example.com/video");
        assert_eq!(stream.audio_url.as_deref(), Some("https://example.com/audio"));
    }

    #[test]
    fn a_printed_line_becomes_a_stream() {
        let stream = parse("https://rr1---sn-x.googlevideo.com/videoplayback?x=1|||webm|||142.5\n")
            .expect("a printed line resolves");
        assert_eq!(
            stream.url,
            "https://rr1---sn-x.googlevideo.com/videoplayback?x=1"
        );
        assert_eq!(stream.mime_type, "audio/webm");
        assert_eq!(stream.bitrate, 142_500);
    }

    #[test]
    fn warning_lines_ahead_of_the_url_are_skipped() {
        let stream = parse("WARNING: something\nhttps://example.com/a|||m4a|||NA\n")
            .expect("the url line is found past the noise");
        assert_eq!(stream.url, "https://example.com/a");
        assert_eq!(stream.mime_type, "audio/mp4");
        assert_eq!(stream.bitrate, 0, "NA degrades rather than failing");
    }

    #[test]
    fn output_without_a_url_is_an_error() {
        assert!(parse("ERROR: unavailable\n").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn resolver_headers_survive_parsing_and_reject_header_injection() {
        let stream = parse(r#"https://example.com/audio|||webm|||128|||{"User-Agent":"provided agent","Accept-Language":"en-US,en;q=0.9"}"#).expect("provider headers");
        assert_eq!(
            stream.http_headers.get("User-Agent").map(String::as_str),
            Some("provided agent")
        );
        assert_eq!(
            stream
                .http_headers
                .get("Accept-Language")
                .map(String::as_str),
            Some("en-US,en;q=0.9")
        );
        assert!(parse(
            r#"https://example.com/audio|||webm|||128|||{"User-Agent":"agent\r\nInjected: yes"}"#
        )
        .is_err());
    }

    #[test]
    fn differing_video_and_audio_headers_are_not_silently_dropped() {
        assert!(parse_video(r#"{"requested_formats":[{"url":"https://example.com/video","http_headers":{"User-Agent":"video"}},{"url":"https://example.com/audio","http_headers":{"User-Agent":"audio"}}]}"#).is_err());
    }

    #[test]
    fn two_printed_urls_are_video_then_audio() {
        let stream = parse_video(r#"{"requested_formats":[{"url":"https://example.com/video","http_headers":{"User-Agent":"resolver"}},{"url":"https://example.com/audio","http_headers":{"User-Agent":"resolver"}}]}"#)
            .expect("a split rendition resolves");
        assert_eq!(stream.url, "https://example.com/video");
        assert_eq!(
            stream.audio_url.as_deref(),
            Some("https://example.com/audio")
        );
        assert_eq!(
            stream.http_headers.get("User-Agent").map(String::as_str),
            Some("resolver")
        );
    }

    #[test]
    fn a_single_url_is_muxed_and_needs_no_audio_track() {
        let stream = parse_video(r#"{"url":"https://example.com/muxed"}"#)
            .expect("a muxed rendition resolves");
        assert_eq!(stream.url, "https://example.com/muxed");
        assert!(
            stream.audio_url.is_none(),
            "mpv must not be handed an audio file that does not exist"
        );
    }

    #[test]
    fn video_output_without_a_url_is_an_error() {
        assert!(parse_video("ERROR: video unavailable\n").is_err());
    }
}


/// Regular YouTube search, not the restricted YouTube Music catalogue.
pub async fn search_interviews(app: &tauri::AppHandle, query: &str, limit: usize) -> Result<Vec<super::super::super::MusicTrack>, String> {
    let args = vec!["--no-warnings".into(), "--flat-playlist".into(), "--dump-single-json".into(), "--skip-download".into(), "--".into(), format!("ytsearch{}:{}", limit.clamp(1, 24), query)];
    let output = crate::ytdlp_update::run(app, args, Duration::from_secs(25), "YouTube interviews").await?;
    interview_results(&String::from_utf8_lossy(&output.stdout), limit)
}

fn interview_results(raw: &str, limit: usize) -> Result<Vec<super::super::super::MusicTrack>, String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| "YouTube search returned invalid metadata".to_string())?;
    let entries = value.get("entries").and_then(serde_json::Value::as_array).ok_or("YouTube search returned no entries")?;
    let mut seen = std::collections::HashSet::new();
    Ok(entries.iter().filter_map(|entry| {
        let id = entry.get("id")?.as_str()?;
        if id.len() != 11 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') || !seen.insert(id.to_owned()) { return None; }
        let title = entry.get("title")?.as_str()?.trim();
        if title.is_empty() { return None; }
        let channel = entry.get("channel").or_else(|| entry.get("uploader")).and_then(serde_json::Value::as_str).unwrap_or("YouTube");
        let seconds = entry.get("duration").and_then(serde_json::Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).unwrap_or(0.0) as u64;
        let mut track = super::items::track(id, title.to_string(), Some(channel.to_string()), None, format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"), seconds);
        track.title = title.to_string();
        track.media_kind = Some("video".into());
        if seconds == 0 { track.duration_label.clear(); }
        Some(track)
    }).take(limit).collect())
}

/// Continue regular YouTube results. yt-dlp walks the provider's search continuation;
/// playlist-start skips earlier entries and the extra entry signals whether another page exists.
pub async fn search_video_page(app: &tauri::AppHandle, query: &str, offset: usize, limit: usize) -> Result<(Vec<super::super::super::MusicTrack>, bool), String> {
    let end = offset.checked_add(limit + 1).ok_or("Invalid video search offset")?;
    let args = vec!["--no-warnings".into(), "--flat-playlist".into(), "--dump-single-json".into(), "--skip-download".into(),
        "--playlist-start".into(), (offset + 1).to_string(), "--playlist-end".into(), end.to_string(),
        "--".into(), format!("ytsearch{end}:{query}")];
    let output = crate::ytdlp_update::run(app, args, Duration::from_secs(32), "YouTube video search").await?;
    let raw = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "YouTube search returned invalid metadata")?;
    let entries = value.get("entries").and_then(serde_json::Value::as_array).ok_or("YouTube search returned no entries")?;
    // The lookahead is fetched again at the start of the next page, so never expose it here.
    let page = serde_json::json!({"entries": entries.iter().take(limit).collect::<Vec<_>>()});
    Ok((interview_results(&page.to_string(), limit)?, entries.len() > limit))
}

#[cfg(test)]
mod interview_tests {
    use super::*;
    #[test]
    fn regular_search_preserves_channels_titles_and_exact_ids() {
        let raw = r#"{"entries":[{"id":"abcdefghijk","title":"Artist talks about new album","channel":"Interview channel","duration":125.5},{"id":"abcdefghijk","title":"Duplicate"},{"id":"https://bad","title":"Bad identity"}]}"#;
        let tracks = interview_results(raw, 12).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "Artist talks about new album");
        assert_eq!(tracks[0].artist, "Interview channel");
        assert_eq!(tracks[0].source_id.as_deref(), Some("abcdefghijk"));
        assert_eq!(tracks[0].duration_seconds, 125);
    }
}
    #[test]
    fn available_heights_list_the_upload() {
        let stream = parse_video(
            r#"{"url":"https://example.test/v","vcodec":"avc1","formats":[
                {"height":1080,"vcodec":"avc1"},
                {"height":720,"vcodec":"vp9"},
                {"height":2160,"vcodec":"none"},
                {"height":480,"vcodec":"avc1"},
                {"height":1440,"vcodec":"vp9"}
            ]}"#,
        )
        .expect("video");
        assert_eq!(stream.available_heights, vec![1440, 1080, 720, 480]);
    }
