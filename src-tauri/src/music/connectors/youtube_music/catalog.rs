use super::super::super::{
    MusicAlbumRef, MusicArtistRef, MusicCatalogItem, MusicCatalogKind, MusicCatalogPage,
    MusicCatalogRow, MusicCatalogScope, MusicPlaylistImport, MusicPlaylistRef, MusicRowLayout,
    MusicStationRef, MusicStream, MusicTrack, MusicVideoStream,
};
use super::innertube::{self, Client};
use super::{items, parse, rows};
use serde_json::Value;

const HOME_SHELVES: usize = 6;
const CHART_SHELVES: usize = 1;
const ROW_ITEMS: usize = 20;
const LIST_TRACKS: usize = 100;
const STATION_TRACKS: usize = 50;
const LIST_ITEM: &str = "musicResponsiveListItemRenderer";
const QUEUE_ITEM: &str = "playlistPanelVideoRenderer";

pub async fn songs(
    client: &Client,
    app: &tauri::AppHandle,
    query: &str,
    limit: usize,
) -> Result<Vec<MusicTrack>, String> {
    let response = client.search(app, query, innertube::SONGS_FILTER).await?;
    Ok(gather(
        &response,
        LIST_ITEM,
        items::track_from_list_item,
        limit,
    ))
}

pub async fn videos(
    client: &Client,
    app: &tauri::AppHandle,
    query: &str,
    limit: usize,
    interviews: bool,
) -> Result<Vec<MusicTrack>, String> {
    let response = client.search(app, query, innertube::VIDEOS_FILTER).await?;
    Ok(video_results_kind(&response, limit, interviews))
}

#[cfg(test)]
fn video_results(response: &Value, limit: usize) -> Vec<MusicTrack> {
    video_results_kind(response, limit, false)
}

pub(super) fn video_results_kind(
    response: &Value,
    limit: usize,
    interviews: bool,
) -> Vec<MusicTrack> {
    let mut found = Vec::new();
    parse::collect(response, LIST_ITEM, &mut found);
    let mut seen = std::collections::HashSet::new();
    let mut videos = Vec::new();
    let mut sources = Vec::new();
    for item in found {
        // Keep provider-declared official music. UGC search also contains tutorials,
        // covers and static audio uploads; those are not music-video discovery.
        let kind = item.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType").and_then(Value::as_str);
        let Some(kind) = kind else { continue };
        if interviews {
            if kind != "MUSIC_VIDEO_TYPE_UGC" {
                continue;
            }
        } else if kind != "MUSIC_VIDEO_TYPE_OMV" && kind != "MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC" {
            continue;
        }
        let Some(mut track) = items::track_from_list_item(item) else {
            continue;
        };
        if interviews && !track.title.to_lowercase().contains("interview") {
            continue;
        }
        track.media_kind = Some("video".to_string());
        let Some(id) = track.source_id.as_deref() else {
            continue;
        };
        if id.len() != 11
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !seen.insert(id.to_string())
        {
            continue;
        }
        // The provider often lists a stage or lyric upload before the official video and
        // gives both the same song title. Keep the music video first: discovery dedupes by
        // title, so whichever comes first is the one the listener sees.
        if kind == "MUSIC_VIDEO_TYPE_OMV" {
            videos.push(track);
        } else {
            sources.push(track);
        }
    }
    videos.extend(sources);
    videos.truncate(limit);
    videos
}

/// The "top result" card. YouTube Music pins the official video there even when the videos
/// shelf omits it or lists a stage upload with the same title first.
pub(super) fn card_video(response: &Value) -> Option<MusicTrack> {
    let mut cards = Vec::new();
    parse::collect(response, "musicCardShelfRenderer", &mut cards);
    let card = *cards.first()?;
    let title = parse::text(card.get("title")?)?;
    let subtitle = parse::text(card.get("subtitle")?)?;
    let parts: Vec<&str> = subtitle
        .split('•')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let kind = parts.first()?;
    if !kind.eq_ignore_ascii_case("video") && !kind.eq_ignore_ascii_case("music video") {
        return None;
    }
    let artist = parts.get(1)?.to_string();
    let duration_label = parts
        .iter()
        .rev()
        .find(|part| part.contains(':'))
        .copied()
        .unwrap_or("");
    let seconds = super::fields::seconds_from_label(duration_label).unwrap_or(0);
    let art = parse::nav(
        card,
        &["thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"],
    )?;
    let url = art.as_array()?.last()?.get("url")?.as_str()?;
    let id = url.split("/vi/").nth(1)?.split('/').next()?;
    if id.len() != 11
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    let mut track = items::track(id, title, Some(artist), None, url.to_string(), seconds);
    track.media_kind = Some("video".to_string());
    Some(track)
}

pub async fn albums(
    client: &Client,
    app: &tauri::AppHandle,
    query: &str,
    limit: usize,
) -> Result<Vec<MusicAlbumRef>, String> {
    let response = client.search(app, query, innertube::ALBUMS_FILTER).await?;
    Ok(gather(
        &response,
        LIST_ITEM,
        items::album_from_list_item,
        limit,
    ))
}

pub async fn artists(
    client: &Client,
    app: &tauri::AppHandle,
    query: &str,
    limit: usize,
) -> Result<Vec<MusicArtistRef>, String> {
    let response = client.search(app, query, innertube::ARTISTS_FILTER).await?;
    Ok(gather(
        &response,
        LIST_ITEM,
        items::artist_from_list_item,
        limit,
    ))
}

pub async fn playlists(
    client: &Client,
    app: &tauri::AppHandle,
    query: &str,
    limit: usize,
) -> Result<Vec<MusicPlaylistRef>, String> {
    let response = client
        .search(app, query, innertube::PLAYLISTS_FILTER)
        .await?;
    Ok(gather(
        &response,
        LIST_ITEM,
        items::playlist_from_list_item,
        limit,
    ))
}

pub async fn home_rows(
    client: &Client,
    app: &tauri::AppHandle,
) -> Result<Vec<MusicCatalogRow>, String> {
    let response = client.browse(app, "FEmusic_home").await?;
    Ok(rows::browse_rows(
        &response,
        "ytm:home",
        HOME_SHELVES,
        ROW_ITEMS,
    ))
}

pub async fn chart_rows(
    client: &Client,
    app: &tauri::AppHandle,
) -> Result<Vec<MusicCatalogRow>, String> {
    let response = client.browse(app, "FEmusic_charts").await?;
    Ok(rows::browse_rows(
        &response,
        "ytm:charts",
        CHART_SHELVES,
        ROW_ITEMS,
    ))
}

/// The account's liked songs, the YouTube Music counterpart of "Liked on Spotify". `LM` is the
/// provider's fixed id for that playlist; it only exists for a signed-in session.
pub async fn liked_row(
    client: &Client,
    app: &tauri::AppHandle,
    signed_in: bool,
) -> Result<Option<MusicCatalogRow>, String> {
    if !signed_in {
        return Ok(None);
    }
    let response = client.browse(app, &playlist_browse_id("LM")?).await?;
    Ok(liked_row_from(&response))
}

fn liked_row_from(response: &Value) -> Option<MusicCatalogRow> {
    let tracks = gather(response, LIST_ITEM, items::track_from_list_item, ROW_ITEMS);
    if tracks.is_empty() {
        return None;
    }
    Some(MusicCatalogRow {
        id: "ytm:home:liked".to_string(),
        title: "Liked on YouTube Music".to_string(),
        title_literal: true,
        subtitle: Some("YouTube Music".to_string()),
        layout: MusicRowLayout::TrackGrid,
        source: super::fields::CONNECTOR.to_string(),
        items: tracks.into_iter().map(MusicCatalogItem::Track).collect(),
    })
}

/// The account's own playlists, the YouTube Music counterpart of the Spotify playlist shelf.
const LIBRARY_PLAYLISTS: &str = "FEmusic_liked_playlists";
const LIBRARY_ALBUMS: &str = "FEmusic_liked_albums";
const LIBRARY_LANDING: &str = "FEmusic_library_landing";
/// Playlist ids the provider keeps in the library as automatic lists rather than user content.
/// Liked Music has its own row above, and saved episodes are not a music playlist.
const AUTO_PLAYLISTS: [&str; 2] = ["VLLM", "VLSE"];
/// The library screens show grouped rows rather than a provider-ordered carousel.
const LIBRARY_ITEMS: usize = 100;

pub async fn library_playlists(
    client: &Client,
    app: &tauri::AppHandle,
    signed_in: bool,
) -> Result<Option<MusicCatalogRow>, String> {
    if !signed_in {
        return Ok(None);
    }
    let response = client.browse(app, LIBRARY_PLAYLISTS).await?;
    Ok(playlists_row(
        &response,
        "ytm:home:playlists",
        "music.row.ytPlaylists",
    ))
}

fn playlists_row(response: &Value, id: &str, title: &str) -> Option<MusicCatalogRow> {
    let playlists = gather(
        response,
        "musicTwoRowItemRenderer",
        items::catalog_item,
        LIBRARY_ITEMS,
    )
    .into_iter()
    .filter_map(|item| match item {
        MusicCatalogItem::Playlist(playlist) if !AUTO_PLAYLISTS.contains(&playlist.id.as_str()) => {
            Some(playlist)
        }
        _ => None,
    })
    .collect::<Vec<_>>();
    if playlists.is_empty() {
        return None;
    }
    Some(MusicCatalogRow {
        id: id.to_string(),
        title: title.to_string(),
        title_literal: false,
        subtitle: None,
        layout: MusicRowLayout::Covers,
        source: super::fields::CONNECTOR.to_string(),
        items: playlists.into_iter().map(MusicCatalogItem::Playlist).collect(),
    })
}

/// The rows of the YouTube Music library surface: liked songs, the account's playlists, the
/// artists in the library, and saved albums. Sections that the account has nothing in are left
/// out so an empty shelf never renders.
pub async fn library_rows(
    client: &Client,
    app: &tauri::AppHandle,
) -> Result<Vec<MusicCatalogRow>, String> {
    let (liked, playlists, landing, albums) = tokio::join!(
        liked_row(client, app, true),
        client.browse(app, LIBRARY_PLAYLISTS),
        client.browse(app, LIBRARY_LANDING),
        client.browse(app, LIBRARY_ALBUMS),
    );
    let mut rows = Vec::new();
    if let Ok(Some(mut row)) = liked {
        // The library page opens the full list through the row's View all action.
        row.id = "ytm:library:liked".to_string();
        rows.push(row);
    }
    if let Ok(response) = playlists {
        if let Some(row) = playlists_row(&response, "ytm:library:playlists", "music.row.playlists")
        {
            rows.push(row);
        }
    }
    if let Ok(response) = landing {
        if let Some(row) = artists_row_from(&response) {
            rows.push(row);
        }
    }
    if let Ok(response) = albums {
        if let Some(row) = albums_row_from(&response) {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return Err("YouTube Music did not return a library for this account".to_string());
    }
    Ok(rows)
}

fn artists_row_from(response: &Value) -> Option<MusicCatalogRow> {
    let mut seen = std::collections::HashSet::new();
    let artists = gather(
        response,
        "musicTwoRowItemRenderer",
        items::catalog_item,
        LIBRARY_ITEMS,
    )
    .into_iter()
    .filter_map(|item| match item {
        MusicCatalogItem::Artist(artist) if seen.insert(artist.id.clone()) => Some(artist),
        _ => None,
    })
    .collect::<Vec<_>>();
    if artists.is_empty() {
        return None;
    }
    Some(MusicCatalogRow {
        id: "ytm:library:artists".to_string(),
        title: "music.row.artists".to_string(),
        title_literal: false,
        subtitle: None,
        layout: MusicRowLayout::Circles,
        source: super::fields::CONNECTOR.to_string(),
        items: artists.into_iter().map(MusicCatalogItem::Artist).collect(),
    })
}

fn albums_row_from(response: &Value) -> Option<MusicCatalogRow> {
    let mut seen = std::collections::HashSet::new();
    let albums = gather(
        response,
        "musicTwoRowItemRenderer",
        items::catalog_item,
        LIBRARY_ITEMS,
    )
    .into_iter()
    .filter_map(|item| match item {
        MusicCatalogItem::Album(album) if seen.insert(album.id.clone()) => Some(album),
        _ => None,
    })
    .collect::<Vec<_>>();
    if albums.is_empty() {
        return None;
    }
    Some(MusicCatalogRow {
        id: "ytm:library:albums".to_string(),
        title: "music.search.albums".to_string(),
        title_literal: false,
        subtitle: None,
        layout: MusicRowLayout::Covers,
        source: super::fields::CONNECTOR.to_string(),
        items: albums.into_iter().map(MusicCatalogItem::Album).collect(),
    })
}

pub async fn album_tracks(
    client: &Client,
    app: &tauri::AppHandle,
    album: &MusicAlbumRef,
) -> Result<Vec<MusicTrack>, String> {
    let id = safe_browse_id(&album.id)?;
    tokio::time::timeout(std::time::Duration::from_secs(25), async {
        let response = client.browse(app, &id).await?;
        let tracks = track_pages(
            response,
            |token| async move { client.browse_continuation(app, &token).await },
            "album",
        )
        .await?;
        Ok(tracks
            .into_iter()
            .map(|track| adopt(track, album))
            .collect())
    })
    .await
    .map_err(|_| "YouTube Music album timed out".to_string())?
}

pub async fn artist_top(
    client: &Client,
    app: &tauri::AppHandle,
    artist: &MusicArtistRef,
) -> Result<Vec<MusicTrack>, String> {
    let page = super::artist::catalog(client, app, artist, MusicCatalogKind::Tracks, None).await?;
    Ok(page
        .items
        .into_iter()
        .filter_map(|item| match item {
            MusicCatalogItem::Track(track) => Some(track),
            _ => None,
        })
        .collect())
}

pub async fn playlist_tracks(
    client: &Client,
    app: &tauri::AppHandle,
    playlist: &MusicPlaylistRef,
) -> Result<Vec<MusicTrack>, String> {
    let response = client
        .browse(app, &playlist_browse_id(&playlist.id)?)
        .await?;
    Ok(gather(
        &response,
        LIST_ITEM,
        items::track_from_list_item,
        LIST_TRACKS,
    ))
}

/// One page of a playlist's songs. `None` starts at the playlist's first shelf; each page hands
/// back the continuation token for the next one.
pub async fn playlist_page(
    client: &Client,
    app: &tauri::AppHandle,
    playlist: &MusicPlaylistRef,
    cursor: Option<&str>,
) -> Result<MusicCatalogPage, String> {
    let response = match cursor {
        Some(token) => {
            if token.len() > 8_192 || token.chars().any(char::is_control) {
                return Err("This YouTube Music playlist cursor is invalid".to_string());
            }
            client.browse_continuation(app, token).await?
        }
        None => {
            client
                .browse(app, &playlist_browse_id(&playlist.id)?)
                .await?
        }
    };
    playlist_page_from(&response, cursor.is_some())
}

fn playlist_page_from(response: &Value, continuation: bool) -> Result<MusicCatalogPage, String> {
    // The import parser validates every entry, so an incomplete page cannot pass for the list.
    let normalized = playlist_song_response(response, !continuation)?;
    let (entries, next) =
        super::artist::collection_page(&normalized, MusicCatalogKind::Tracks, "")?;
    Ok(MusicCatalogPage {
        items: entries,
        next_cursor: next,
        total: None,
        scope: MusicCatalogScope::Catalog,
    })
}

pub async fn import_playlist(
    client: &Client,
    app: &tauri::AppHandle,
    source_id: &str,
) -> Result<MusicPlaylistImport, String> {
    let mix = mix_source(source_id)?;
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        if let Some((playlist_id, seed)) = mix {
            let response = client.watch_queue(app, Some(&seed), &playlist_id).await?;
            return mix_snapshot(&response, &playlist_id, &seed);
        }
        let browse_id = import_browse_id(source_id)?;
        let first = client.browse(app, &browse_id).await?;
        playlist_import_pages(first, |token| async move {
            client.browse_continuation(app, &token).await
        })
        .await
    })
    .await
    .map_err(|_| "YouTube Music playlist import timed out".to_string())?
}

fn mix_source(raw: &str) -> Result<Option<(String, String)>, String> {
    let Some((playlist_id, seed)) = raw.trim().split_once(':') else {
        return Ok(None);
    };
    let invalid = || "Invalid YouTube Music Mix source".to_string();
    let playlist = safe_browse_id(playlist_id).map_err(|_| invalid())?;
    let video = safe_video_id(seed).map_err(|_| invalid())?;
    if playlist != playlist_id
        || video != seed
        || !playlist.starts_with("RD")
        || playlist.len() <= 2
        || playlist.starts_with("RDCLAK5uy_")
        || video.len() != 11
    {
        return Err(invalid());
    }
    Ok(Some((playlist, video)))
}

fn mix_snapshot(
    response: &Value,
    playlist_id: &str,
    seed: &str,
) -> Result<MusicPlaylistImport, String> {
    let invalid =
        || "YouTube Music did not return this Mix's current queue. Please try again.".to_string();
    let mut panels = Vec::new();
    parse::collect(response, "playlistPanelRenderer", &mut panels);
    let panel = panels
        .into_iter()
        .find(|panel| panel["playlistId"].as_str() == Some(playlist_id))
        .ok_or_else(invalid)?;
    let contents = panel["contents"].as_array().ok_or_else(invalid)?;
    let mut tracks = Vec::new();
    for item in contents {
        if let Some(renderer) = item.get(QUEUE_ITEM) {
            let track = items::track_from_panel(renderer).ok_or_else(invalid)?;
            if track.id.len() != 11 || safe_video_id(&track.id).is_err() {
                return Err(invalid());
            }
            tracks.push(track);
        }
    }
    let seed_track = tracks
        .iter()
        .find(|track| track.id == seed)
        .ok_or_else(invalid)?;
    let name =
        parse::text(&panel["title"]).unwrap_or_else(|| format!("Mix – {}", seed_track.title));
    // Radio continuations extend an unbounded queue, not a finite playlist.
    Ok(MusicPlaylistImport { name, tracks })
}

async fn playlist_import_pages<F, Fut>(
    first: Value,
    mut next: F,
) -> Result<MusicPlaylistImport, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let name = playlist_title(&first).ok_or_else(|| {
        "This YouTube Music playlist is private, deleted or unavailable.".to_string()
    })?;
    let tracks = track_pages(
        playlist_song_response(&first, true)?,
        |token| {
            let page = next(token);
            async move { playlist_song_response(&page.await?, false) }
        },
        "playlist",
    )
    .await?;
    Ok(MusicPlaylistImport { name, tracks })
}

fn playlist_song_response(response: &Value, initial: bool) -> Result<Value, String> {
    let invalid =
        || "YouTube Music did not return this playlist's tracks. Please try again.".to_string();
    let mut containers = Vec::new();
    let mut actions = Vec::new();
    for key in [
        "musicPlaylistShelfRenderer",
        "musicPlaylistShelfContinuation",
    ] {
        if initial && key == "musicPlaylistShelfContinuation" {
            continue;
        }
        let mut shelves = Vec::new();
        parse::collect(response, key, &mut shelves);
        for shelf in shelves {
            validate_playlist_song_items(&shelf["contents"])?;
            if let Some(continuations) = shelf.get("continuations") {
                for continuation in continuations.as_array().ok_or_else(invalid)? {
                    if continuation
                        .pointer("/nextContinuationData/continuation")
                        .and_then(Value::as_str)
                        .is_none()
                    {
                        return Err(invalid());
                    }
                }
            }
            containers.push(serde_json::json!({ (key): shelf }));
        }
    }
    if !initial {
        for action in response["onResponseReceivedActions"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(items) = action.get("appendContinuationItemsAction") {
                validate_playlist_song_items(&items["continuationItems"])?;
                actions.push(action.clone());
            }
        }
    }
    if containers.is_empty() && actions.is_empty() {
        return Err(invalid());
    }
    Ok(serde_json::json!({ "contents": containers, "onResponseReceivedActions": actions }))
}

fn validate_playlist_song_items(value: &Value) -> Result<(), String> {
    let invalid =
        || "YouTube Music returned incomplete playlist tracks. Please try again.".to_string();
    for item in value.as_array().ok_or_else(invalid)? {
        if let Some(renderer) = item.get(LIST_ITEM) {
            let track = items::track_from_list_item(renderer).ok_or_else(invalid)?;
            if track.id.len() != 11 || safe_video_id(&track.id).as_deref() != Ok(track.id.as_str())
            {
                return Err(invalid());
            }
        } else if let Some(renderer) = item.get("continuationItemRenderer") {
            let token = renderer
                .pointer("/continuationEndpoint/continuationCommand/token")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if token.is_empty() || token.len() > 8192 || token.chars().any(char::is_control) {
                return Err(invalid());
            }
        } else {
            return Err(invalid());
        }
    }
    Ok(())
}

fn playlist_title(response: &Value) -> Option<String> {
    let mut headers = Vec::new();
    parse::collect(response, "musicResponsiveHeaderRenderer", &mut headers);
    parse::collect(response, "musicDetailHeaderRenderer", &mut headers);
    headers
        .into_iter()
        .find_map(|header| parse::text(&header["title"]))
}

async fn track_pages<F, Fut>(
    mut response: Value,
    mut next: F,
    noun: &str,
) -> Result<Vec<MusicTrack>, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut tracks = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..100 {
        let (entries, continuation) =
            super::artist::collection_page(&response, MusicCatalogKind::Tracks, "")?;
        tracks.extend(entries.into_iter().filter_map(|entry| match entry {
            MusicCatalogItem::Track(track) => Some(track),
            _ => None,
        }));
        let Some(token) = continuation else {
            return Ok(tracks);
        };
        if !seen.insert(token.clone()) {
            return Err(format!(
                "YouTube Music repeated a page of this {noun}. Please try again."
            ));
        }
        response = next(token).await?;
    }
    Err(format!(
        "This YouTube Music {noun} exceeded the supported page count"
    ))
}

fn playlist_browse_id(raw: &str) -> Result<String, String> {
    let id = safe_browse_id(raw)?;
    Ok(if id.starts_with("VL") {
        id
    } else {
        format!("VL{id}")
    })
}

fn import_browse_id(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let id = safe_browse_id(raw.strip_prefix("VL").unwrap_or(raw))?;
    if !["PL", "OLAK5uy_", "RDCLAK5uy_"].iter().any(|prefix| {
        id.strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty())
    }) {
        return Err("Use a public or unlisted YouTube playlist, not a personal mix.".into());
    }
    Ok(format!("VL{id}"))
}

pub async fn station_tracks(
    client: &Client,
    app: &tauri::AppHandle,
    station: &MusicStationRef,
) -> Result<Vec<MusicTrack>, String> {
    let playlist_id = safe_browse_id(&station.id)?;
    let video_id = playlist_id
        .strip_prefix("RDAMVM")
        .map(safe_video_id)
        .transpose()?;
    let response = client
        .watch_queue(app, video_id.as_deref(), &playlist_id)
        .await?;
    Ok(gather(
        &response,
        QUEUE_ITEM,
        items::track_from_panel,
        STATION_TRACKS,
    ))
}

pub async fn stream(app: &tauri::AppHandle, track: &MusicTrack) -> Result<MusicStream, String> {
    let video_id = safe_video_id(track.source_id.as_deref().unwrap_or(&track.id))?;
    // A raw Innertube URL can pass a one-byte probe but fail mpv's full-range read.
    // Keep resolver failures actionable instead of caching an unusable fallback.
    super::ytdlp::stream(app, &video_id).await.map_err(|error| {
        format!("YouTube Music could not resolve this song. Try again or choose another source. {error}")
    })
}

pub async fn video_stream(
    app: &tauri::AppHandle,
    track: &MusicTrack,
    max_height: Option<u32>,
) -> Result<MusicVideoStream, String> {
    let video_id = safe_video_id(track.source_id.as_deref().unwrap_or(&track.id))?;
    super::ytdlp::video_stream(app, &video_id, max_height).await
}

fn gather<T>(response: &Value, key: &str, build: fn(&Value) -> Option<T>, limit: usize) -> Vec<T> {
    let mut found = Vec::new();
    parse::collect(response, key, &mut found);
    found.into_iter().filter_map(build).take(limit).collect()
}

fn adopt(mut track: MusicTrack, album: &MusicAlbumRef) -> MusicTrack {
    if track.album.is_none() {
        track.album = Some(album.title.clone());
    }
    // The album's cover is the canonical artwork for a track listed on that album.
    if !album.artwork.is_empty() {
        track.artwork = album.artwork.clone();
    }
    if track.artist == "Unknown artist" {
        track.artist = album.artist.clone();
    }
    track
}

fn safe_video_id(raw: &str) -> Result<String, String> {
    safe_id(raw, 24).ok_or_else(|| "Invalid music video id".to_string())
}

fn safe_browse_id(raw: &str) -> Result<String, String> {
    safe_id(raw, 80).ok_or_else(|| "Invalid music catalog id".to_string())
}

fn safe_id(raw: &str, ceiling: usize) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > ceiling
        || !trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn video_ids_reject_urls_and_shell_input() {
        assert_eq!(safe_video_id("abc_123-Z").expect("valid id"), "abc_123-Z");
        assert!(safe_video_id("https://youtube.com/watch?v=abc").is_err());
        assert!(safe_video_id("abc; rm file").is_err());
        assert!(safe_video_id("  ").is_err());
    }

    #[test]
    fn browse_ids_allow_the_longer_catalog_prefixes() {
        assert_eq!(
            safe_browse_id("MPREb_wYRcCbSMkPI").expect("album id"),
            "MPREb_wYRcCbSMkPI"
        );
        assert_eq!(
            safe_browse_id("VLOLAK5uy_kShaSSQrHWMi").expect("playlist id"),
            "VLOLAK5uy_kShaSSQrHWMi"
        );
        assert!(safe_browse_id("VL../../etc").is_err());
    }

    #[test]
    fn gather_walks_the_response_and_honors_the_limit() {
        let response = json!({"contents": [
            {"musicResponsiveListItemRenderer": {
                "playlistItemData": {"videoId": "one"},
                "flexColumns": [{"musicResponsiveListItemFlexColumnRenderer": {
                    "text": {"runs": [{"text": "First"}]}
                }}]
            }},
            {"musicResponsiveListItemRenderer": {
                "playlistItemData": {"videoId": "two"},
                "flexColumns": [{"musicResponsiveListItemFlexColumnRenderer": {
                    "text": {"runs": [{"text": "Second"}]}
                }}]
            }}
        ]});
        let tracks = gather(&response, LIST_ITEM, items::track_from_list_item, 1);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "First");
    }

    #[test]
    fn liked_songs_become_a_lead_row() {
        let response = json!({"contents": [
            {"musicResponsiveListItemRenderer": {
                "playlistItemData": {"videoId": "one"},
                "flexColumns": [{"musicResponsiveListItemFlexColumnRenderer": {
                    "text": {"runs": [{"text": "Liked song"}]}
                }}]
            }}
        ]});
        let row = liked_row_from(&response).expect("liked row");
        assert_eq!(row.id, "ytm:home:liked");
        assert_eq!(row.title, "Liked on YouTube Music");
        assert_eq!(row.layout, MusicRowLayout::TrackGrid);
        assert_eq!(row.items.len(), 1);
        // A signed-out account has no liked playlist, so no empty row is added.
        assert!(liked_row_from(&json!({})).is_none());
    }

    fn library_playlist(title: &str, browse_id: &str) -> Value {
        json!({
            "musicTwoRowItemRenderer": {
                "title": {"runs": [{"text": title}]},
                "subtitle": {"runs": [
                    {"text": "ThundeR"}, {"text": " • "}, {"text": "5 tracks"}
                ]},
                "navigationEndpoint": {"browseEndpoint": {
                    "browseId": browse_id,
                    "browseEndpointContextSupportedConfigs": {
                        "browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_PLAYLIST"}
                    }
                }},
                "thumbnailRenderer": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [
                    {"url": "https://example.test/cover.jpg", "width": 576, "height": 576}
                ]}}}
            }
        })
    }

    #[test]
    fn library_playlists_become_a_covers_row_without_automatic_lists() {
        let response = json!({"contents": [
            {"grid": {"items": [
                library_playlist("Liked Music", "VLLM"),
                library_playlist("Saved episodes", "VLSE"),
                library_playlist("Favorite Songs", "VLPLPiI50_X6Uc4LP")
            ]}}
        ]});
        let row = playlists_row(&response, "ytm:home:playlists", "music.row.ytPlaylists")
            .expect("playlist row");
        assert_eq!(row.id, "ytm:home:playlists");
        assert_eq!(row.title, "music.row.ytPlaylists");
        assert!(!row.title_literal);
        assert_eq!(row.layout, MusicRowLayout::Covers);
        assert_eq!(row.items.len(), 1);
        match &row.items[0] {
            MusicCatalogItem::Playlist(playlist) => {
                assert_eq!(playlist.id, "VLPLPiI50_X6Uc4LP");
                assert_eq!(playlist.name, "Favorite Songs");
                assert_eq!(playlist.track_count, Some(5));
                assert_eq!(playlist.artwork, vec!["https://example.test/cover.jpg"]);
            }
            _ => panic!("expected a playlist item"),
        }
        // A signed-out account has no library, and auto playlists alone are not a row.
        assert!(playlists_row(&json!({}), "ytm:home:playlists", "music.row.ytPlaylists").is_none());
        let auto_only = json!({"contents": [library_playlist("Liked Music", "VLLM")]});
        assert!(playlists_row(&auto_only, "ytm:home:playlists", "music.row.ytPlaylists").is_none());
    }

    fn library_artist(name: &str, channel_id: &str) -> Value {
        json!({
            "musicTwoRowItemRenderer": {
                "title": {"runs": [{"text": name}]},
                "subtitle": {"runs": [{"text": "Artist"}, {"text": " • "}, {"text": "2M subscribers"}]},
                "navigationEndpoint": {"browseEndpoint": {
                    "browseId": channel_id,
                    "browseEndpointContextSupportedConfigs": {
                        "browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}
                    }
                }}
            }
        })
    }

    fn library_album(title: &str, album_id: &str) -> Value {
        json!({
            "musicTwoRowItemRenderer": {
                "title": {"runs": [{"text": title}]},
                "subtitle": {"runs": [{"text": "Album"}, {"text": " • "}, {"text": "Muse"}, {"text": " • "}, {"text": "2003"}]},
                "navigationEndpoint": {"browseEndpoint": {
                    "browseId": album_id,
                    "browseEndpointContextSupportedConfigs": {
                        "browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ALBUM"}
                    }
                }}
            }
        })
    }

    #[test]
    fn library_sections_keep_only_their_own_kind_and_dedupe() {
        let landing = json!({"contents": [
            library_playlist("Favorite Songs", "VLPLPiI50_X6Uc4LP"),
            library_artist("Muse", "UCmuse"),
            library_artist("Muse", "UCmuse"),
            library_artist("Tame Impala", "UCtame")
        ]});
        let row = artists_row_from(&landing).expect("artist row");
        assert_eq!(row.id, "ytm:library:artists");
        assert_eq!(row.title, "music.row.artists");
        assert_eq!(row.layout, MusicRowLayout::Circles);
        assert_eq!(row.items.len(), 2);
        assert!(artists_row_from(&json!({"contents": [library_playlist("A", "VLPLone")]})).is_none());

        let saved = json!({"contents": [
            library_album("Absolution", "MPREb_one"),
            library_artist("Muse", "UCmuse"),
            library_album("Absolution", "MPREb_one")
        ]});
        let row = albums_row_from(&saved).expect("album row");
        assert_eq!(row.id, "ytm:library:albums");
        assert_eq!(row.title, "music.search.albums");
        assert_eq!(row.layout, MusicRowLayout::Covers);
        assert_eq!(row.items.len(), 1);
        // The endpoint answers with an empty grid for accounts that saved no albums.
        assert!(albums_row_from(&json!({})).is_none());
    }

    #[test]
    fn album_tracks_inherit_the_album_cover_and_artist() {
        let album = MusicAlbumRef {
            id: "MPREb_one".to_string(),
            connector_id: "youtube".to_string(),
            title: "Absolution".to_string(),
            artist: "Muse".to_string(),
            artwork: "cover.jpg".to_string(),
            year: Some(2003),
            track_count: Some(14),
            explicit: None,
        };
        let bare = items::track(
            "MdVBSHOMWSY",
            "Hysteria".to_string(),
            None,
            None,
            String::new(),
            227,
        );
        let filled = adopt(bare, &album);
        assert_eq!(filled.artist, "Muse");
        assert_eq!(filled.album.as_deref(), Some("Absolution"));
        assert_eq!(filled.artwork, "cover.jpg");
    }

    #[test]
    fn video_search_preserves_actual_provider_ids_and_excludes_audio_art_tracks() {
        // Reduced public YouTube Music video-search response captured 2026-09-14.
        let mut response: Value =
            serde_json::from_str(include_str!("video-search-fixture.json")).unwrap();
        let tracks = video_results(&response, 12);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].source_id.as_deref(), Some("FGBhQbmPwH8"));
        assert_eq!(tracks[0].title, "One More Time");
        assert_eq!(tracks[0].artist, "Daft Punk");
        assert!(tracks[0].artwork.starts_with("https://"));
        assert_eq!(tracks[1].source_id.as_deref(), Some("a5uQMwRMHcs"));
        assert_eq!(tracks[0].media_kind.as_deref(), Some("video"));
        assert_eq!(video_results(&response, 1).len(), 1);
        let pointer = "/contents/0/musicResponsiveListItemRenderer/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType";
        *response.pointer_mut(pointer).unwrap() = json!("MUSIC_VIDEO_TYPE_ATV");
        assert_eq!(video_results(&response, 12).len(), 1);
        let duplicate = response["contents"][2].clone();
        response["contents"].as_array_mut().unwrap().push(duplicate);
        assert_eq!(video_results(&response, 12).len(), 1);
    }
    #[test]
    fn the_top_result_card_is_a_video_identity() {
        let response = json!({"contents": [{"musicCardShelfRenderer": {
            "title": {"runs": [{"text": "Gnarly"}]},
            "subtitle": {"runs": [{"text": "Video"}, {"text": " • "}, {"text": "KATSEYE"}, {"text": " • "}, {"text": "246M views"}, {"text": " • "}, {"text": "2:22"}]},
            "thumbnail": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [
                {"url": "https://i.ytimg.com/vi/R2-yomhYAj4/hqdefault.jpg"}
            ]}}}
        }}]});
        let track = card_video(&response).expect("card");
        assert_eq!(track.source_id.as_deref(), Some("R2-yomhYAj4"));
        assert_eq!(track.title, "Gnarly");
        assert_eq!(track.artist, "KATSEYE");
        assert_eq!(track.duration_seconds, 142);
        assert_eq!(track.media_kind.as_deref(), Some("video"));
        // A song card is not a video identity.
        let song = json!({"musicCardShelfRenderer": {
            "title": {"runs": [{"text": "Gnarly"}]},
            "subtitle": {"runs": [{"text": "Song • KATSEYE"}]},
            "thumbnail": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [
                {"url": "https://i.ytimg.com/vi/R2-yomhYAj4/hqdefault.jpg"}
            ]}}}
        }});
        assert!(card_video(&song).is_none());
    }

    #[test]
    fn an_official_video_leads_a_source_upload_with_the_same_title() {
        let mut response: Value =
            serde_json::from_str(include_str!("video-search-fixture.json")).unwrap();
        let pointer = "/contents/0/musicResponsiveListItemRenderer/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType";
        // The clean-stage upload is listed first and shares the song's title.
        *response.pointer_mut(pointer).unwrap() = json!("MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC");
        let tracks = video_results(&response, 12);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].source_id.as_deref(), Some("a5uQMwRMHcs"));
    }

    #[test]
    fn official_source_music_uploads_count_as_music_videos() {
        let mut response: Value =
            serde_json::from_str(include_str!("video-search-fixture.json")).unwrap();
        let pointer = "/contents/0/musicResponsiveListItemRenderer/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType";
        // YouTube Music types a label's art track this way; it is still the official upload.
        *response.pointer_mut(pointer).unwrap() = json!("MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC");
        assert_eq!(video_results(&response, 12).len(), 2);
        *response.pointer_mut(pointer).unwrap() = json!("MUSIC_VIDEO_TYPE_ATV");
        assert_eq!(video_results(&response, 12).len(), 1);
    }

    #[test]
    fn interviews_do_not_mix_official_videos_or_audio() {
        let mut response: Value =
            serde_json::from_str(include_str!("video-search-fixture.json")).unwrap();
        assert!(video_results_kind(&response, 12, true).is_empty());
        let item = &mut response["contents"][0]["musicResponsiveListItemRenderer"];
        item["flexColumns"][0]["musicResponsiveListItemFlexColumnRenderer"]["text"]["runs"][0]
            ["text"] = json!("Daft Punk Interview");
        let pointer = "/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType";
        *item.pointer_mut(pointer).unwrap() = json!("MUSIC_VIDEO_TYPE_UGC");
        assert_eq!(video_results_kind(&response, 12, true).len(), 1);
        assert_eq!(video_results_kind(&response, 12, false).len(), 1);
    }

    fn playlist_fixture() -> Value {
        // Reduced public YouTube Music playlist browse + continuation captured 2026-10-30.
        serde_json::from_str(include_str!("playlist-page-fixture.json")).unwrap()
    }

    fn mix_fixture() -> Value {
        // Reduced anonymous YouTube Music next response captured 2026-10-30.
        serde_json::from_str(include_str!("mix-queue-fixture.json")).unwrap()
    }

    #[test]
    fn mix_sources_preserve_the_playlist_and_selected_video_independently() {
        assert_eq!(
            mix_source("RDGMEMCMFH2exzjBeE_zAHHJOdxgVMWUJYt4Zs3Ko:05VSCSna5WA").unwrap(),
            Some((
                "RDGMEMCMFH2exzjBeE_zAHHJOdxgVMWUJYt4Zs3Ko".into(),
                "05VSCSna5WA".into()
            ))
        );
        assert_eq!(
            mix_source("PLw-VjHDlEOgtH-Ce-dJzPOtIm5xTVC4t2").unwrap(),
            None
        );
        for source in [
            "PLplaylist:05VSCSna5WA",
            "RDCLAK5uy_playlist:05VSCSna5WA",
            "RD:05VSCSna5WA",
            "RDmix:short",
            "RDmix:05VSCSna5WA:extra",
            "RDmix: 05VSCSna5WA",
            "RD../mix:05VSCSna5WA",
            "LM:05VSCSna5WA",
        ] {
            assert!(mix_source(source).is_err(), "{source}");
        }
    }

    #[test]
    fn mix_snapshot_keeps_queue_order_and_provider_ids_without_exhausting_radio() {
        let response = mix_fixture();
        let imported = mix_snapshot(
            &response,
            "RDGMEMCMFH2exzjBeE_zAHHJOdxgVMWUJYt4Zs3Ko",
            "05VSCSna5WA",
        )
        .unwrap();
        assert_eq!(imported.name, "Mix – Smart");
        assert_eq!(
            imported
                .tracks
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            ["05VSCSna5WA", "0EK_M2taRIM", "V6TEcoNUmc8"]
        );
        assert_eq!(imported.tracks[0].artist, "LE SSERAFIM");
        assert_eq!(imported.tracks[0].duration_seconds, 189);
        assert_eq!(imported.tracks[1].album.as_deref(), Some("ELEVEN"));
        assert_eq!(imported.tracks[2].source_id.as_deref(), Some("V6TEcoNUmc8"));
        // The fixture's Ditto entry carries no thumbnail; the id still supplies a poster.
        assert_eq!(
            imported.tracks[2].artwork,
            "https://i.ytimg.com/vi/V6TEcoNUmc8/hq720.jpg"
        );
    }

    #[test]
    fn mix_snapshot_ignores_unrelated_panels_and_rejects_incomplete_queues() {
        let response = mix_fixture();
        let mut panels = Vec::new();
        parse::collect(&response, "playlistPanelRenderer", &mut panels);
        let panel = panels[0].clone();
        let mut unrelated = panel.clone();
        unrelated["playlistId"] = json!("RDother");
        unrelated["contents"][0][QUEUE_ITEM]["title"] = json!({"runs": [{"text": "Wrong song"}]});
        let combined = json!({"panels": [{"playlistPanelRenderer": unrelated}, {"playlistPanelRenderer": panel}]});
        assert_eq!(
            mix_snapshot(
                &combined,
                "RDGMEMCMFH2exzjBeE_zAHHJOdxgVMWUJYt4Zs3Ko",
                "05VSCSna5WA"
            )
            .unwrap()
            .tracks[0]
                .title,
            "Smart"
        );
        for contents in [
            Value::Null,
            json!([]),
            json!([{"playlistPanelVideoRenderer": {"videoId": "05VSCSna5WA"}}]),
        ] {
            let mut invalid = panel.clone();
            invalid["contents"] = contents;
            assert!(mix_snapshot(
                &json!({"playlistPanelRenderer": invalid}),
                "RDGMEMCMFH2exzjBeE_zAHHJOdxgVMWUJYt4Zs3Ko",
                "05VSCSna5WA"
            )
            .is_err());
        }
        assert!(mix_snapshot(&response, "RDother", "05VSCSna5WA").is_err());
        assert!(mix_snapshot(
            &response,
            "RDGMEMCMFH2exzjBeE_zAHHJOdxgVMWUJYt4Zs3Ko",
            "WUJYt4Zs3Ko"
        )
        .is_err());
    }

    #[test]
    fn playlist_pages_follow_the_continuation_token() {
        let fixture = playlist_fixture();
        let first = playlist_page_from(&fixture["first"], false).expect("first page");
        assert_eq!(first.scope, MusicCatalogScope::Catalog);
        assert_eq!(first.items.len(), 2);
        assert!(matches!(first.items[0], MusicCatalogItem::Track(_)));
        assert!(first.next_cursor.is_some());
        let second = playlist_page_from(&fixture["second"], true).expect("second page");
        assert_eq!(second.items.len(), 2);
        assert!(second.next_cursor.is_none());
    }

    #[tokio::test]
    async fn playlist_import_follows_every_track_page_and_reads_the_title() {
        let fixture = playlist_fixture();
        let second = fixture["second"].clone();
        let mut requested = Vec::new();
        let imported = playlist_import_pages(fixture["first"].clone(), |token| {
            requested.push(token);
            let page = second.clone();
            async move { Ok(page) }
        })
        .await
        .expect("playlist import");
        assert_eq!(requested, ["playlist-page-two"]);
        assert_eq!(
            imported.name,
            "Top 500 Songs of the 80s - Best Pop & Rock Music Playlist"
        );
        let ids: Vec<_> = imported
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect();
        assert_eq!(
            ids,
            ["oRdxUFDoQe0", "OMOGaugKpzs", "ejorQVy3m8E", "yG07WSu7Q9w"]
        );
        assert_eq!(imported.tracks[2].title, "Beds Are Burning");
    }

    #[test]
    fn linked_playlist_ids_reject_personal_mixes_and_normalize_browse_prefixes() {
        assert_eq!(
            import_browse_id("VLPLw-VjHDlEOgtH-Ce-dJzPOtIm5xTVC4t2").unwrap(),
            "VLPLw-VjHDlEOgtH-Ce-dJzPOtIm5xTVC4t2"
        );
        assert_eq!(
            import_browse_id("OLAK5uy_kShaSSQrHWMi").unwrap(),
            "VLOLAK5uy_kShaSSQrHWMi"
        );
        assert!(import_browse_id("RDCLAK5uy_playlist").is_ok());
        for id in [
            "RDAMVMoRdxUFDoQe0",
            "RDMM",
            "LM",
            "WL",
            "abc;echo secret",
            "not_a_playlist",
        ] {
            assert!(import_browse_id(id).is_err(), "{id}");
        }
    }

    #[tokio::test]
    async fn playlist_import_ignores_recommendations_and_accepts_a_valid_empty_shelf() {
        let fixture = playlist_fixture();
        let mut first = fixture["first"].clone();
        first["recommendations"] = json!({"musicShelfRenderer": {"contents": [
            fixture["second"]["onResponseReceivedActions"][0]["appendContinuationItemsAction"]["continuationItems"][0].clone()
        ]}});
        let imported = playlist_import_pages(first, |_| {
            let second = fixture["second"].clone();
            async move { Ok(second) }
        })
        .await
        .unwrap();
        assert_eq!(imported.tracks.len(), 4);
        let mut empty = fixture["first"].clone();
        empty["contents"]["twoColumnBrowseResultsRenderer"]["secondaryContents"]
            ["sectionListRenderer"]["contents"][0]["musicPlaylistShelfRenderer"]["contents"] =
            json!([]);
        let imported = playlist_import_pages(empty, |_| async {
            panic!("empty playlist must not request a continuation")
        })
        .await
        .unwrap();
        assert!(imported.tracks.is_empty());
    }

    #[tokio::test]
    async fn playlist_import_rejects_missing_song_arrays_instead_of_saving_a_partial_snapshot() {
        let fixture = playlist_fixture();
        let mut first = fixture["first"].clone();
        let shelf = &mut first["contents"]["twoColumnBrowseResultsRenderer"]["secondaryContents"]
            ["sectionListRenderer"]["contents"][0]["musicPlaylistShelfRenderer"];
        shelf.as_object_mut().unwrap().remove("contents");
        assert!(playlist_import_pages(first, |_| async { Ok(Value::Null) })
            .await
            .is_err());
        let mut second = fixture["second"].clone();
        second["onResponseReceivedActions"][0]["appendContinuationItemsAction"]
            .as_object_mut()
            .unwrap()
            .remove("continuationItems");
        assert!(playlist_import_pages(fixture["first"].clone(), |_| {
            let page = second.clone();
            async move { Ok(page) }
        })
        .await
        .is_err());
    }

    #[tokio::test]
    async fn playlist_import_rejects_malformed_tracks_and_continuations() {
        let fixture = playlist_fixture();
        for broken in [
            json!({"musicResponsiveListItemRenderer": {"playlistItemData": {"videoId": "oRdxUFDoQe0"}}}),
            json!({"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {}}}}),
            json!({"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": 42}}}}),
        ] {
            let mut first = fixture["first"].clone();
            first["contents"]["twoColumnBrowseResultsRenderer"]["secondaryContents"]
                ["sectionListRenderer"]["contents"][0]["musicPlaylistShelfRenderer"]["contents"] =
                json!([broken]);
            assert!(playlist_import_pages(first, |_| async { Ok(Value::Null) })
                .await
                .is_err());
        }
        let mut second = fixture["second"].clone();
        second["onResponseReceivedActions"][0]["appendContinuationItemsAction"]
            ["continuationItems"]
            .as_array_mut()
            .unwrap()
            .push(json!({"continuationItemRenderer": {}}));
        assert!(playlist_import_pages(fixture["first"].clone(), |_| {
            let page = second.clone();
            async move { Ok(page) }
        })
        .await
        .is_err());
    }

    #[tokio::test]
    async fn playlist_import_rejects_a_repeated_continuation() {
        let first = playlist_fixture()["first"].clone();
        let again = first.clone();
        let result = playlist_import_pages(first, |_| {
            let page = again.clone();
            async move { Ok(page) }
        })
        .await;
        assert!(result.unwrap_err().contains("repeated"));
    }

    #[tokio::test]
    async fn playlist_import_explains_unavailable_and_empty_playlists() {
        let missing = json!({"responseContext": {}, "trackingParams": "x", "microformat": {}});
        let error = playlist_import_pages(missing, |_| async { Ok(Value::Null) })
            .await
            .unwrap_err();
        assert!(error.contains("private, deleted or unavailable"));

        let mut empty = playlist_fixture()["first"].clone();
        empty["contents"]["twoColumnBrowseResultsRenderer"]
            .as_object_mut()
            .unwrap()
            .remove("secondaryContents");
        let error = playlist_import_pages(empty, |_| async { Ok(Value::Null) })
            .await
            .unwrap_err();
        assert!(error.contains("did not return"));
    }
}
