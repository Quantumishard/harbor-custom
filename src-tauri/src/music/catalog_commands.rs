use super::connector::MusicConnector;
use super::rows;
use super::{
    MusicAlbumRef, MusicArtistRef, MusicCatalogItem, MusicCatalogKind, MusicCatalogPage,
    MusicCatalogRow, MusicConnection, MusicPlaylistRef, MusicSearchResults, MusicStationRef,
};
use super::{MusicState, MusicTrack, MusicVideoStream};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const BROWSE_TIMEOUT: Duration = Duration::from_secs(12);

#[tauri::command]
pub async fn music_home_rows(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    refresh: bool,
) -> Result<Vec<MusicCatalogRow>, String> {
    // A tab signed into since the last load changes what the YouTube shelf contributes; rebuild
    // instead of serving rows that were cached from the anonymous view.
    let restored = super::connectors::youtube_music::auth::ensure(&app, false).await;
    if restored {
        rows::invalidate(&state.db, Some("youtube"))?;
    }
    if !refresh && !restored {
        let cached = rows::cached(&state.db, None)?;
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    let results = state.registry.browse_home(&app, BROWSE_TIMEOUT, None).await;
    let ordered = rows::order_rows(results);
    if !ordered.is_empty() {
        rows::store(&state.db, &ordered)?;
    }
    Ok(ordered)
}

#[tauri::command]
pub async fn music_library_rows(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    connector: String,
) -> Result<Vec<MusicCatalogRow>, String> {
    pick(state.inner(), &connector)?
        .library_rows(&app)
        .await
}

#[tauri::command]
pub async fn music_browse_connector(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    connector: String,
) -> Result<Vec<MusicCatalogRow>, String> {
    let target = pick(state.inner(), &connector)?;
    if !target.browsable() {
        return Err(target.unsupported("browsing"));
    }
    let results = state
        .registry
        .browse_home(&app, BROWSE_TIMEOUT, Some(&connector))
        .await;
    let mut errors = Vec::new();
    for (id, result) in &results {
        if let Err(error) = result {
            errors.push(format!("{id}: {error}"));
        }
    }
    let ordered = rows::order_rows(results);
    if ordered.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    if !ordered.is_empty() {
        rows::store(&state.db, &ordered)?;
    }
    Ok(ordered)
}

#[tauri::command]
pub async fn music_album_tracks(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    album: MusicAlbumRef,
) -> Result<Vec<MusicTrack>, String> {
    let connector = pick(state.inner(), &album.connector_id)?;
    let tracks = connector.album_tracks(&app, &album).await?;
    remember(state.inner(), tracks)
}

#[tauri::command]
pub async fn music_artist_rows(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    artist: MusicArtistRef,
) -> Result<Vec<MusicCatalogRow>, String> {
    let connector = pick(state.inner(), &artist.connector_id)?;
    tokio::time::timeout(BROWSE_TIMEOUT, connector.artist_rows(&app, &artist))
        .await
        .map_err(|_| "Artist discovery timed out".to_string())?
}

#[tauri::command]
pub async fn music_artist_top(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    artist: MusicArtistRef,
) -> Result<Vec<MusicTrack>, String> {
    let connector = pick(state.inner(), &artist.connector_id)?;
    let tracks = connector.artist_top(&app, &artist).await?;
    remember(state.inner(), tracks)
}

#[tauri::command]
pub async fn music_artist_catalog(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    artist: MusicArtistRef,
    kind: MusicCatalogKind,
    cursor: Option<String>,
) -> Result<MusicCatalogPage, String> {
    if cursor.as_ref().is_some_and(|value| value.len() > 32_768) {
        return Err("Artist catalog cursor is too large".into());
    }
    let connector = pick(state.inner(), &artist.connector_id)?;
    // Some providers first return an artist page with a link to its full collection.
    let page = tokio::time::timeout(
        Duration::from_secs(25),
        connector.artist_catalog(&app, &artist, kind, cursor.as_deref()),
    )
    .await
    .map_err(|_| "Artist catalog timed out".to_string())??;
    for item in &page.items {
        if let MusicCatalogItem::Track(track) = item {
            state.db.upsert_track(track)?;
        }
    }
    Ok(page)
}

#[tauri::command]
pub async fn music_catalog_playlist_tracks(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    playlist: MusicPlaylistRef,
) -> Result<Vec<MusicTrack>, String> {
    let connector = pick(state.inner(), &playlist.connector_id)?;
    let tracks = connector.playlist_tracks(&app, &playlist).await?;
    remember(state.inner(), tracks)
}

/// One page of a catalog playlist; `cursor` is the provider's continuation from the last page.
#[tauri::command]
pub async fn music_catalog_playlist_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    playlist: MusicPlaylistRef,
    cursor: Option<String>,
) -> Result<MusicCatalogPage, String> {
    let connector = pick(state.inner(), &playlist.connector_id)?;
    let page = connector
        .playlist_page(&app, &playlist, cursor.as_deref())
        .await?;
    let tracks = page
        .items
        .iter()
        .filter_map(|item| match item {
            MusicCatalogItem::Track(track) => Some(track.clone()),
            _ => None,
        })
        .collect();
    remember(state.inner(), tracks)?;
    Ok(page)
}

#[tauri::command]
pub async fn music_import_linked_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    connector_id: String,
    source_id: String,
) -> Result<super::library::MusicPlaylist, String> {
    let generation = state.db.generation()?;
    let connector = pick(state.inner(), &connector_id)?;
    let imported = connector.import_playlist(&app, &source_id).await?;
    super::library::import_linked_playlist(
        &state.db,
        generation,
        &connector_id,
        &source_id,
        &imported,
    )
}

#[tauri::command]
pub async fn music_sync_linked_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    playlist_id: String,
) -> Result<super::library::MusicPlaylist, String> {
    let generation = state.db.generation()?;
    let playlist = super::library::linked_playlist(&state.db, &playlist_id)?;
    let source = playlist.source.ok_or("This playlist is not linked")?;
    let connector = pick(state.inner(), &source.connector_id)?;
    let imported = connector.import_playlist(&app, &source.source_id).await?;
    super::library::sync_linked_playlist(
        &state.db,
        generation,
        &playlist_id,
        &source,
        &playlist.updated_at,
        &imported,
    )
}

#[tauri::command]
pub fn music_unlink_playlist(
    state: tauri::State<'_, MusicState>,
    playlist_id: String,
) -> Result<super::library::MusicPlaylist, String> {
    super::library::unlink_playlist(&state.db, &playlist_id)
}

#[tauri::command]
pub async fn music_station_tracks(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    station: MusicStationRef,
) -> Result<Vec<MusicTrack>, String> {
    let connector = pick(state.inner(), &station.connector_id)?;
    let tracks = connector.station_tracks(&app, &station).await?;
    remember(state.inner(), tracks)
}

#[tauri::command]
pub async fn music_search_typed(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    query: String,
    limit: usize,
    connector: Option<String>,
) -> Result<MusicSearchResults, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(MusicSearchResults::default());
    }
    if query.len() > 200 {
        return Err("Music search is too long".to_string());
    }
    let limit = limit.clamp(1, 40);
    let results = state
        .registry
        .search_typed(&app, query, limit, connector.as_deref())
        .await?;
    for track in &results.tracks {
        state.db.upsert_track(track)?;
    }
    Ok(results)
}

/// Exact video identities from YouTube Music's video-only search; no song rematching.
#[tauri::command]
pub async fn music_search_videos(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    query: String,
    limit: usize,
    interviews: Option<bool>,
) -> Result<Vec<MusicTrack>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.len() > 200 {
        return Err("Music search is too long".to_string());
    }
    let connector = pick(state.inner(), "youtube")?;
    tokio::time::timeout(
        if interviews.unwrap_or(false) { Duration::from_secs(28) } else { BROWSE_TIMEOUT },
        connector.search_videos(&app, query, limit.clamp(1, 48), interviews.unwrap_or(false)),
    )
    .await
    .map_err(|_| "Music video search timed out".to_string())?
}

/// One page of exact provider video identities and its continuation.
#[tauri::command]
pub async fn music_search_video_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    query: String,
    regular: bool,
    cursor: Option<String>,
) -> Result<super::MusicVideoPage, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 { return Err("Invalid music video search".into()); }
    tokio::time::timeout(
        Duration::from_secs(35),
        pick(state.inner(), "youtube")?.search_video_page(&app, query, regular, cursor.as_deref()),
    ).await.map_err(|_| "Music video search timed out".to_string())?
}

/// Canonical YouTube titles for video ids. YouTube Music mislabels some official videos
/// (the one it calls "Smart (Slowed + Reverb ver.)" is titled "OFFICIAL MV" on
/// youtube.com), so the discovery list is corrected from YouTube's own metadata.
#[tauri::command]
pub async fn music_video_titles(
    ids: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    const MAX: usize = 24;
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if unique.len() >= MAX {
            break;
        }
        let valid = id.len() == 11
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
        if valid && !unique.contains(&id) {
            unique.push(id);
        }
    }
    if unique.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?;
    let mut tasks = Vec::with_capacity(unique.len());
    for id in unique {
        let client = client.clone();
        tasks.push(tokio::spawn(async move {
            let url = format!(
                "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}&format=json"
            );
            let Ok(response) = client.get(url).send().await else {
                return (id, None);
            };
            if !response.status().is_success() {
                return (id, None);
            }
            let Ok(value) = response.json::<serde_json::Value>().await else {
                return (id, None);
            };
            let Some(title) = value["title"].as_str() else {
                return (id, None);
            };
            let title: String = title.trim().chars().take(200).collect();
            (id, (!title.is_empty()).then_some(title))
        }));
    }
    let mut titles = std::collections::HashMap::new();
    for task in tasks {
        if let Ok((id, Some(title))) = task.await {
            titles.insert(id, title);
        }
    }
    Ok(titles)
}

/// The music video for a track, when its source has one. Playback itself runs through the
/// ordinary video player so the music pane inherits embedding, hardware decoding and geometry.
#[tauri::command]
pub async fn music_video_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    track: MusicTrack,
    max_height: Option<u32>,
) -> Result<MusicVideoStream, String> {
    let connector = track
        .connector_id
        .as_deref()
        .ok_or_else(|| "This track has no source to ask for a video".to_string())?;
    pick(state.inner(), connector)?
        .resolve_video(&app, &track, max_height)
        .await
}

#[tauri::command]
pub async fn music_connections(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
) -> Result<Vec<MusicConnection>, String> {
    // Picks up a YouTube Music tab the listener signed into since the last check, so the row
    // reports the account without a second sign-in.
    if super::connectors::youtube_music::auth::ensure(&app, true).await {
        // The Home cache still holds the anonymous shelves; the next Home load must rebuild them.
        rows::invalidate(&state.db, Some("youtube"))?;
    }
    // Avoid exposing librespot's immutable account ID in the Connections list.
    state.spotify.refresh_profile_display_name().await;
    Ok(state.registry.connections())
}

#[tauri::command]
pub async fn music_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    id: String,
    fields: HashMap<String, String>,
) -> Result<MusicConnection, String> {
    let connection = pick(state.inner(), &id)?.connect(&app, &fields).await?;
    // Signing in changes what this source contributes to Home, and the cached rows predate it.
    rows::invalidate(&state.db, Some(&id))?;
    Ok(connection)
}

#[tauri::command]
pub async fn music_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    id: String,
) -> Result<(), String> {
    pick(state.inner(), &id)?.disconnect(&app).await?;
    // The signed-in shelves no longer apply once the session is gone.
    rows::invalidate(&state.db, Some(&id))?;
    Ok(())
}

#[tauri::command]
pub async fn music_local_scan(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicState>,
    folder: String,
) -> Result<u32, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Choose a music folder to scan".to_string());
    }
    pick(state.inner(), "local")?.scan(&app, folder).await
}

fn pick(state: &MusicState, id: &str) -> Result<Arc<dyn MusicConnector>, String> {
    state
        .registry
        .get(id)
        .ok_or_else(|| format!("Unknown music connector: {id}"))
}

fn remember(state: &MusicState, tracks: Vec<MusicTrack>) -> Result<Vec<MusicTrack>, String> {
    for track in &tracks {
        state.db.upsert_track(track)?;
    }
    Ok(tracks)
}

#[tauri::command]
pub fn music_local_collection(
    state: tauri::State<'_, MusicState>,
    kind: String,
    query: String,
    offset: usize,
    limit: usize,
    artist_key: Option<String>,
) -> Result<super::connectors::local::LocalMusicPage, String> {
    super::connectors::local::collection_page(
        &state.db,
        &kind,
        &query,
        offset,
        limit,
        artist_key.as_deref(),
    )
}
