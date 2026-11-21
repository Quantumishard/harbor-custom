pub mod commands;
mod db;
mod import;
mod pack;

use std::sync::Mutex;

use rusqlite::Connection;

/// Desktop-only identity pack service. The SQLite connection is cached for the
/// read paths; the import mutex serializes weekly refreshes.
#[derive(Default)]
pub struct IdentityState {
    pub conn: Mutex<Option<Connection>>,
    pub import: tokio::sync::Mutex<()>,
}

#[cfg(test)]
mod live_tests {
    use std::time::Instant;

    use super::{import, pack};

    fn identity_entry(conn: &rusqlite::Connection, scheme: &str, id: &str) -> Option<i64> {
        let code = import::scheme_code(scheme)?;
        conn.query_row(
            "SELECT entry FROM identities WHERE scheme = ?1 AND id = ?2",
            rusqlite::params![code, id],
            |row| row.get(0),
        )
        .ok()
    }

    /// Manual smoke test against the live weekly release. Ignored by default
    /// because it downloads ~6 MB and must not run in CI.
    #[test]
    #[ignore = "downloads the live anime-offline-database release"]
    fn live_pack_import_smoke() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let started = Instant::now();
            let pack = pack::download_latest().await.expect("download pack");
            let windows_xml = pack::download_anime_lists().await.expect("download windows");
            let download_ms = started.elapsed().as_millis();

            let path = std::env::temp_dir().join(format!(
                "harbor-identity-live-{}.db",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            let import_started = Instant::now();
            let mut conn = rusqlite::Connection::open(&path).expect("open tmp db");
            conn.execute_batch(
                "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;",
            )
            .expect("pragmas");
            let reader = pack::decode_zstd(&pack.bytes).expect("decode zstd");
            let summary = import::import_jsonl(&mut conn, reader, &pack.version, &pack.sha256, 0)
                .expect("import pack");
            let windows = import::import_windows(&mut conn, &windows_xml).expect("import windows");
            let import_ms = import_started.elapsed().as_millis();
            let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);

            let sbr = identity_entry(&conn, "kitsu", "49847").expect("SBR entry");
            let jojo2012 = identity_entry(&conn, "mal", "14719").expect("JoJo 2012 entry");
            let tensei2 = identity_entry(&conn, "kitsu", "46917").expect("Tensei II entry");
            assert_ne!(sbr, jojo2012, "2012 and SBR must be different works");
            assert!(summary.entries > 30_000, "pack entries: {}", summary.entries);
            assert!(
                summary.related_entries > 10_000,
                "related entries: {}",
                summary.related_entries
            );
            assert!(
                summary.related_edges > 100_000,
                "related edges: {}",
                summary.related_edges
            );
            assert!(tensei2 > 0);
            // Anime-Lists maps ~7.5k of the pack's AniDB ids to a TVDB/TMDB
            // show; that is the measured window coverage, not a bug.
            assert!(windows > 5_000, "windows: {windows}");
            assert!(bytes < 25 * 1024 * 1024, "db bytes: {bytes}");

            let sbr_aliases: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM identities WHERE entry = ?1",
                    rusqlite::params![sbr],
                    |row| row.get(0),
                )
                .unwrap();
            println!(
                "identity smoke: download={download_ms}ms import={import_ms}ms db={:.1}MB entries={} identities={} related_entries={} related_edges={} sbr_aliases={} windows={}",
                bytes as f64 / 1_048_576.0,
                summary.entries,
                summary.identities,
                summary.related_entries,
                summary.related_edges,
                sbr_aliases,
                windows
            );
            drop(conn);
            let _ = std::fs::remove_file(&path);
        });
    }
}