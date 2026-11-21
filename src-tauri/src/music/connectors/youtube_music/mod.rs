mod artist;
pub(crate) mod auth;
mod catalog;
#[cfg(test)]
mod clients;
mod fields;
mod innertube;
mod items;
mod parse;
#[cfg(test)]
mod player;
mod rows;
mod ytdlp;
mod video_page;

use super::super::connector::{ConnectorHealth, HealthCell, MusicConnector};
use super::super::{
    MusicAlbumRef, MusicArtistRef, MusicCatalogItem, MusicCatalogKind, MusicCatalogPage,
    MusicCatalogRow, MusicConnection, MusicPlaylistImport, MusicPlaylistRef, MusicSearchResults,
    MusicStationRef, MusicStream, MusicTrack, MusicVideoStream,
};
use async_trait::async_trait;

pub struct YouTubeMusicConnector {
    health: HealthCell,
    client: innertube::Client,
}

impl YouTubeMusicConnector {
    pub fn new() -> Self {
        Self {
            health: HealthCell::new(),
            client: innertube::Client::new(),
        }
    }

    fn record<T>(&self, result: &Result<T, String>) {
        self.health.set(match result {
            Ok(_) => ConnectorHealth::Healthy,
            Err(error) => classify_error(error),
        });
    }
}

#[async_trait]
impl MusicConnector for YouTubeMusicConnector {
    fn id(&self) -> &str {
        "youtube"
    }

    fn name(&self) -> &str {
        "YouTube Music"
    }

    async fn library_rows(&self, app: &tauri::AppHandle) -> Result<Vec<MusicCatalogRow>, String> {
        auth::ensure(app, false).await;
        if auth::current().is_none() {
            return Err("Sign in to YouTube Music to open its library".to_string());
        }
        let result = catalog::library_rows(&self.client, app).await;
        self.record(&result);
        result
    }

    async fn search(
        &self,
        app: &tauri::AppHandle,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MusicTrack>, String> {
        let result = catalog::songs(&self.client, app, query, limit).await;
        self.record(&result);
        result
    }

    async fn search_videos(
        &self,
        app: &tauri::AppHandle,
        query: &str,
        limit: usize,
        interviews: bool,
    ) -> Result<Vec<MusicTrack>, String> {
        let result = if interviews { ytdlp::search_interviews(app, query, limit).await } else { catalog::videos(&self.client, app, query, limit, false).await };
        self.record(&result);
        result
    }

    async fn search_video_page(
        &self,
        app: &tauri::AppHandle,
        query: &str,
        regular: bool,
        cursor: Option<&str>,
    ) -> Result<crate::music::MusicVideoPage, String> {
        let result = video_page::search(&self.client, app, query, regular, cursor).await;
        self.record(&result);
        result
    }

    async fn search_typed(
        &self,
        app: &tauri::AppHandle,
        query: &str,
        limit: usize,
    ) -> Result<MusicSearchResults, String> {
        let (tracks, albums, artists, playlists) = tokio::join!(
            catalog::songs(&self.client, app, query, limit),
            catalog::albums(&self.client, app, query, limit),
            catalog::artists(&self.client, app, query, limit),
            catalog::playlists(&self.client, app, query, limit)
        );
        self.record(&tracks);
        let tracks = tracks?;
        let albums = albums.unwrap_or_default();
        let artists = artists.unwrap_or_default();
        let playlists = playlists.unwrap_or_default();
        let top = tracks
            .first()
            .cloned()
            .map(MusicCatalogItem::Track)
            .or_else(|| albums.first().cloned().map(MusicCatalogItem::Album))
            .or_else(|| artists.first().cloned().map(MusicCatalogItem::Artist));
        Ok(MusicSearchResults {
            top,
            tracks,
            albums,
            artists,
            playlists,
        })
    }

    async fn browse_home(&self, app: &tauri::AppHandle) -> Result<Vec<MusicCatalogRow>, String> {
        // A signed-in tab turns these same shelves into the listener's own home. Look for the
        // session once; without one the call stays anonymous exactly as before.
        auth::ensure(app, false).await;
        let signed_in = auth::current().is_some();
        let (home, charts, liked, playlists) = tokio::join!(
            catalog::home_rows(&self.client, app),
            catalog::chart_rows(&self.client, app),
            catalog::liked_row(&self.client, app, signed_in),
            catalog::library_playlists(&self.client, app, signed_in)
        );
        self.record(&home);
        let mut rows = Vec::new();
        // The account's own shelves lead the provider's home, matching the Spotify layout.
        if let Some(liked) = liked.ok().flatten() {
            rows.push(liked);
        }
        if let Some(playlists) = playlists.ok().flatten() {
            rows.push(playlists);
        }
        rows.extend(home?);
        if let Ok(charts) = charts {
            rows.extend(charts);
        }
        Ok(rows)
    }

    async fn album_tracks(
        &self,
        app: &tauri::AppHandle,
        album: &MusicAlbumRef,
    ) -> Result<Vec<MusicTrack>, String> {
        let result = catalog::album_tracks(&self.client, app, album).await;
        self.record(&result);
        result
    }

    async fn artist_top(
        &self,
        app: &tauri::AppHandle,
        artist: &MusicArtistRef,
    ) -> Result<Vec<MusicTrack>, String> {
        let result = catalog::artist_top(&self.client, app, artist).await;
        self.record(&result);
        result
    }

    async fn artist_catalog(
        &self,
        app: &tauri::AppHandle,
        artist: &MusicArtistRef,
        kind: MusicCatalogKind,
        cursor: Option<&str>,
    ) -> Result<MusicCatalogPage, String> {
        let result = artist::catalog(&self.client, app, artist, kind, cursor).await;
        self.record(&result);
        result
    }

    async fn playlist_tracks(
        &self,
        app: &tauri::AppHandle,
        playlist: &MusicPlaylistRef,
    ) -> Result<Vec<MusicTrack>, String> {
        let result = catalog::playlist_tracks(&self.client, app, playlist).await;
        self.record(&result);
        result
    }

    async fn playlist_page(
        &self,
        app: &tauri::AppHandle,
        playlist: &MusicPlaylistRef,
        cursor: Option<&str>,
    ) -> Result<MusicCatalogPage, String> {
        let result = catalog::playlist_page(&self.client, app, playlist, cursor).await;
        self.record(&result);
        result
    }

    async fn import_playlist(
        &self,
        app: &tauri::AppHandle,
        playlist_id: &str,
    ) -> Result<MusicPlaylistImport, String> {
        let result = catalog::import_playlist(&self.client, app, playlist_id).await;
        self.record(&result);
        result
    }

    async fn station_tracks(
        &self,
        app: &tauri::AppHandle,
        station: &MusicStationRef,
    ) -> Result<Vec<MusicTrack>, String> {
        let result = catalog::station_tracks(&self.client, app, station).await;
        self.record(&result);
        result
    }

    async fn resolve(
        &self,
        app: &tauri::AppHandle,
        track: &MusicTrack,
    ) -> Result<MusicStream, String> {
        // A cold start can begin playback before the Music home has restored the session; the
        // stream must not silently fall back to anonymous extraction in that window.
        auth::ensure(app, false).await;
        let result = catalog::stream(app, track).await;
        self.record(&result);
        result
    }

    async fn resolve_video(
        &self,
        app: &tauri::AppHandle,
        track: &MusicTrack,
        max_height: Option<u32>,
    ) -> Result<MusicVideoStream, String> {
        auth::ensure(app, false).await;
        catalog::video_stream(app, track, max_height).await
    }

    async fn connect(
        &self,
        app: &tauri::AppHandle,
        _fields: &std::collections::HashMap<String, String>,
    ) -> Result<MusicConnection, String> {
        let session = auth::session_from(app).await?;
        auth::set(session);
        auth::record_opt_in(app);
        self.health.set(ConnectorHealth::Healthy);
        Ok(self.connection())
    }

    async fn disconnect(&self, app: &tauri::AppHandle) -> Result<(), String> {
        auth::clear();
        auth::forget(app);
        Ok(())
    }

    fn set_health(&self, health: ConnectorHealth) {
        self.health.set(health);
    }

    fn health(&self) -> ConnectorHealth {
        self.health.get()
    }

    fn browsable(&self) -> bool {
        true
    }

    fn connection(&self) -> MusicConnection {
        let status = match self.health() {
            ConnectorHealth::Offline => "error",
            _ => "connected",
        };
        let mut connection = MusicConnection::new(
            "youtube",
            "YouTube Music",
            "streaming",
            status,
            &["search", "browse", "play"],
        )
        .anonymous();
        if let Some(session) = auth::current() {
            connection.account = Some(
                session
                    .account
                    .clone()
                    .unwrap_or_else(|| "YouTube Music".to_string()),
            );
            connection.detail = Some("Using your signed-in YouTube Music session".to_string());
        }
        connection
    }
}

fn classify_error(error: &str) -> ConnectorHealth {
    let lower = error.to_ascii_lowercase();
    if [
        "timed out",
        "timeout",
        "network",
        "connection",
        "dns",
        "resolve host",
        "offline",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        ConnectorHealth::Offline
    } else {
        ConnectorHealth::Degraded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_failures_take_the_connector_offline_and_others_degrade_it() {
        assert_eq!(
            classify_error("YouTube Music request failed: operation timed out"),
            ConnectorHealth::Offline
        );
        assert_eq!(
            classify_error("YouTube Music returned HTTP 400"),
            ConnectorHealth::Degraded
        );
    }

    #[test]
    fn the_connector_reports_browsing_alongside_search_and_playback() {
        let connection = YouTubeMusicConnector::new().connection();
        assert_eq!(connection.id, "youtube");
        assert_eq!(connection.kind, "streaming");
        assert_eq!(connection.status, "connected");
        assert_eq!(connection.capabilities, vec!["search", "browse", "play"]);
        assert!(connection.needs.is_empty());
    }
}
