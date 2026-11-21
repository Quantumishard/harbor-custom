use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::identity::{db, import, pack, IdentityState};

const FRESH_FOR_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub id: String,
    pub entry: Option<i64>,
    pub title: Option<String>,
    pub provisional: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRef {
    pub scheme: String,
    pub id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedRef {
    pub entry: i64,
    pub title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRef {
    pub anidb: Option<i64>,
    pub tvdb: Option<i64>,
    pub tmdbtv: Option<i64>,
    pub tvdb_season: Option<i64>,
    pub tvdb_offset: Option<i64>,
    pub tmdb_season: Option<i64>,
    pub tmdb_offset: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryBundle {
    pub entry: i64,
    pub title: Option<String>,
    pub media_type: Option<String>,
    pub episodes: Option<i64>,
    pub aliases: Vec<AliasRef>,
    pub related: Vec<RelatedRef>,
    pub windows: Vec<WindowRef>,
}

fn split_key(raw: &str) -> Option<(&str, &str)> {
    let (scheme, id) = raw.split_once(':')?;
    if scheme.is_empty() || id.is_empty() {
        None
    } else {
        Some((scheme, id))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn identity_status(
    app: AppHandle,
    state: State<'_, IdentityState>,
) -> Result<db::IdentityStatus, String> {
    if let Ok(guard) = state.conn.lock() {
        if let Some(conn) = guard.as_ref() {
            return db::status(&app, Some(conn));
        }
    }
    db::status(&app, None)
}

/// Never promote a staged pack with no verified season windows. The old DB
/// remains installed and its freshness timestamp is not advanced.
fn require_imported_windows(count: usize) -> Result<(), String> {
    if count == 0 {
        Err("identity windows: no usable mappings; existing pack preserved".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn identity_ensure_pack(
    app: AppHandle,
    state: State<'_, IdentityState>,
    force: Option<bool>,
) -> Result<db::IdentityStatus, String> {
    let _import = state.import.lock().await;
    let force = force.unwrap_or(false);
    if !force {
        if let Ok(status) = db::status(&app, None) {
            if status.ready && status.schema == db::SCHEMA_VERSION {
                let fresh = status
                    .built_at
                    .map(|built| now_ms() - built < FRESH_FOR_MS)
                    .unwrap_or(false);
                // An older incomplete install without season windows cannot
                // be considered fresh for seven days; retry the companion.
                if fresh && status.windows > 0 {
                    return Ok(status);
                }
            }
        }
    }

    // Both sources are required for a coherent install. If Anime-Lists is
    // temporarily offline, preserve the previous working database rather than
    // replacing it with a new pack that has no season mappings for a week.
    let downloaded = pack::download_latest().await?;
    let windows_xml = pack::download_anime_lists().await?;
    let tmp = db::tmp_path(&app)?;
    db::ensure_dir(&app)?;
    if tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
    }

    let import_tmp = tmp.clone();
    let version = downloaded.version.clone();
    let sha256 = downloaded.sha256.clone();
    let bytes = downloaded.bytes;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(&import_tmp)
            .map_err(|error| format!("identity import: open tmp: {error}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;",
        )
        .map_err(|error| format!("identity import: pragmas: {error}"))?;
        let reader = pack::decode_zstd(&bytes)?;
        import::import_jsonl(&mut conn, reader, &version, &sha256, now_ms())?;
        let imported_windows = import::import_windows(&mut conn, &windows_xml)?;
        require_imported_windows(imported_windows)?;
        drop(conn);
        Ok(())
    })
    .await
    .map_err(|error| format!("identity import: task: {error}"))??;

    // Hold the connection lock across the swap so no query keeps the old file open.
    {
        let mut guard = state
            .conn
            .lock()
            .map_err(|_| "identity: db lock poisoned".to_string())?;
        *guard = None;
        db::install_new_db(&app, &tmp)?;
    }
    db::status(&app, None)
}

#[tauri::command]
pub fn identity_lookup_batch(
    app: AppHandle,
    state: State<'_, IdentityState>,
    ids: Vec<String>,
) -> Result<Vec<LookupResult>, String> {
    db::with_conn(&app, &*state, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT i.entry, e.title
                 FROM identities i
                 LEFT JOIN entries e ON e.entry = i.entry
                 WHERE i.scheme = ?1 AND i.id = ?2",
            )
            .map_err(|error| format!("identity lookup: prepare: {error}"))?;
        let mut out = Vec::with_capacity(ids.len());
        for raw in ids {
            let Some((scheme, id)) = split_key(&raw) else {
                out.push(LookupResult {
                    id: raw,
                    entry: None,
                    title: None,
                    provisional: true,
                });
                continue;
            };
            let Some(scheme_code) = import::scheme_code(scheme) else {
                out.push(LookupResult {
                    id: raw,
                    entry: None,
                    title: None,
                    provisional: true,
                });
                continue;
            };
            match stmt.query_row(params![scheme_code, id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
            }) {
                Ok((entry, title)) => out.push(LookupResult {
                    id: raw,
                    entry: Some(entry),
                    title,
                    provisional: false,
                }),
                Err(rusqlite::Error::QueryReturnedNoRows) => out.push(LookupResult {
                    id: raw,
                    entry: None,
                    title: None,
                    provisional: true,
                }),
                Err(error) => return Err(format!("identity lookup: query: {error}")),
            }
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn identity_entry_bundle(
    app: AppHandle,
    state: State<'_, IdentityState>,
    key: String,
) -> Result<Option<EntryBundle>, String> {
    let Some((scheme, id)) = split_key(&key) else {
        return Ok(None);
    };
    let Some(scheme_code) = import::scheme_code(scheme) else {
        return Ok(None);
    };
    db::with_conn(&app, &*state, |conn| {
        let entry: Option<i64> = match conn.query_row(
            "SELECT entry FROM identities WHERE scheme = ?1 AND id = ?2",
            params![scheme_code, id],
            |row| row.get(0),
        ) {
            Ok(entry) => Some(entry),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(format!("identity bundle: identity: {error}")),
        };
        let Some(entry) = entry else {
            return Ok(None);
        };

        let (title, media_type, episodes): (Option<String>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT title, type, episodes FROM entries WHERE entry = ?1",
                params![entry],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("identity bundle: entry: {error}"))?;

        let mut alias_stmt = conn
            .prepare("SELECT scheme, id FROM identities WHERE entry = ?1 ORDER BY scheme, id")
            .map_err(|error| format!("identity bundle: aliases: {error}"))?;
        let aliases = alias_stmt
            .query_map(params![entry], |row| {
                let code: i64 = row.get(0)?;
                Ok(AliasRef {
                    scheme: import::scheme_name(code).to_string(),
                    id: row.get(1)?,
                })
            })
            .map_err(|error| format!("identity bundle: aliases query: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("identity bundle: aliases rows: {error}"))?;

        let related_blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT related_blob FROM related WHERE entry = ?1",
                params![entry],
                |row| row.get(0),
            )
            .ok();
        let related_ids = related_blob
            .as_deref()
            .map(import::decode_ids)
            .unwrap_or_default();
        let mut title_stmt = conn
            .prepare("SELECT entry, title FROM entries WHERE entry = ?1")
            .map_err(|error| format!("identity bundle: related titles: {error}"))?;
        let mut related = Vec::with_capacity(related_ids.len());
        for related_entry in related_ids {
            let related_title = title_stmt
                .query_row(params![related_entry], |row| {
                    row.get::<_, Option<String>>(1)
                })
                .ok()
                .flatten();
            related.push(RelatedRef {
                entry: related_entry,
                title: related_title,
            });
        }

        let mut window_stmt = conn
            .prepare(
                "SELECT anidb, tvdb, tmdbtv, tvdb_season, tvdb_offset, tmdb_season, tmdb_offset
                 FROM windows WHERE entry = ?1",
            )
            .map_err(|error| format!("identity bundle: windows: {error}"))?;
        let windows = window_stmt
            .query_map(params![entry], |row| {
                Ok(WindowRef {
                    anidb: row.get(0)?,
                    tvdb: row.get(1)?,
                    tmdbtv: row.get(2)?,
                    tvdb_season: row.get(3)?,
                    tvdb_offset: row.get(4)?,
                    tmdb_season: row.get(5)?,
                    tmdb_offset: row.get(6)?,
                })
            })
            .map_err(|error| format!("identity bundle: windows query: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("identity bundle: windows rows: {error}"))?;

        Ok(Some(EntryBundle {
            entry,
            title,
            media_type,
            episodes,
            aliases,
            related,
            windows,
        }))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardHint {
    pub id: String,
    pub entry: Option<i64>,
    pub title: Option<String>,
    pub media_type: Option<String>,
    pub card_key: Option<String>,
    pub windows: Vec<WindowRef>,
    pub tvdb: Option<i64>,
    pub tmdb: Option<i64>,
    pub season: Option<i64>,
    pub offset: Option<i64>,
    pub provisional: bool,
}

/// Resolve row ids to a provider-show card key. The frontend combines this with
/// its existing catalog-to-entry mapping; missing data is provisional, not an error.
#[tauri::command]
pub fn identity_card_hints(
    app: AppHandle,
    state: State<'_, IdentityState>,
    ids: Vec<String>,
) -> Result<Vec<CardHint>, String> {
    db::with_conn(&app, &*state, |conn| {
        let mut identity = conn
            .prepare(
                "SELECT i.entry, e.title, e.type FROM identities i
                 LEFT JOIN entries e ON e.entry = i.entry
                 WHERE i.scheme = ?1 AND i.id = ?2",
            )
            .map_err(|error| format!("identity cards: prepare identity: {error}"))?;
        let mut window = conn
            .prepare(
                "SELECT tvdb, tmdbtv, tvdb_season, tvdb_offset FROM windows
                 WHERE entry = ?1 AND (tvdb IS NOT NULL OR tmdbtv IS NOT NULL)
                 ORDER BY CASE WHEN tvdb IS NOT NULL THEN 0 ELSE 1 END,
                          CASE WHEN tvdb_season IS NULL OR tvdb_season = 0 THEN 1 ELSE 0 END,
                          tvdb_season ASC
                 LIMIT 1",
            )
            .map_err(|error| format!("identity cards: prepare window: {error}"))?;
        let mut out = Vec::with_capacity(ids.len());
        for raw in ids {
            let Some((scheme, id)) = split_key(&raw) else {
                out.push(CardHint {
                    id: raw,
                    entry: None,
                    title: None,
                    media_type: None,
                    card_key: None,
                    windows: Vec::new(),
                    tvdb: None,
                    tmdb: None,
                    season: None,
                    offset: None,
                    provisional: true,
                });
                continue;
            };
            let Some(code) = import::scheme_code(scheme) else {
                out.push(CardHint {
                    id: raw,
                    entry: None,
                    title: None,
                    media_type: None,
                    card_key: None,
                    windows: Vec::new(),
                    tvdb: None,
                    tmdb: None,
                    season: None,
                    offset: None,
                    provisional: true,
                });
                continue;
            };
            let resolved = identity
                .query_row(params![code, id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .ok();
            let Some((entry, title, media_type)) = resolved else {
                out.push(CardHint {
                    id: raw,
                    entry: None,
                    title: None,
                    media_type: None,
                    card_key: None,
                    windows: Vec::new(),
                    tvdb: None,
                    tmdb: None,
                    season: None,
                    offset: None,
                    provisional: true,
                });
                continue;
            };
            let hint = window
                .query_row(params![entry], |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                })
                .ok();
            let (tvdb, tmdb, season, offset) = match hint {
                Some((tvdb, tmdb, season, offset)) => (tvdb, tmdb, season, offset),
                None => (None, None, None, None),
            };
            let card_key = match (tvdb, tmdb) {
                (Some(tvdb), _) => Some(format!("tvdb:{tvdb}")),
                (None, Some(tmdb)) => Some(format!("tmdb:tv:{tmdb}")),
                _ => None,
            };
            let mut windows_stmt = conn
                .prepare(
                    "SELECT anidb, tvdb, tmdbtv, tvdb_season, tvdb_offset, tmdb_season, tmdb_offset
                     FROM windows WHERE entry = ?1",
                )
                .map_err(|error| format!("identity cards: windows: {error}"))?;
            let windows = windows_stmt
                .query_map(params![entry], |row| {
                    Ok(WindowRef {
                        anidb: row.get(0)?,
                        tvdb: row.get(1)?,
                        tmdbtv: row.get(2)?,
                        tvdb_season: row.get(3)?,
                        tvdb_offset: row.get(4)?,
                        tmdb_season: row.get(5)?,
                        tmdb_offset: row.get(6)?,
                    })
                })
                .map_err(|error| format!("identity cards: windows query: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("identity cards: windows rows: {error}"))?;
            out.push(CardHint {
                id: raw,
                entry: Some(entry),
                title,
                media_type,
                card_key,
                windows,
                tvdb,
                tmdb,
                season,
                offset,
                provisional: false,
            });
        }
        Ok(out)
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOwner {
    pub entry: i64,
    pub title: Option<String>,
    pub media_type: Option<String>,
    pub tvdb: Option<i64>,
    pub tmdb: Option<i64>,
    pub season: Option<i64>,
    pub offset: Option<i64>,
}

/// Pair each catalog show id with its OWN provider season. TVDB S1 and TMDB
/// S6 on the same entry are not evidence that the entry owns TVDB S6.
const WINDOW_OWNER_SQL: &str = "SELECT w.entry, e.title, e.type, w.tvdb, w.tmdbtv,
            CASE WHEN ?1 IS NOT NULL AND w.tvdb = ?1 AND w.tvdb_season = ?3
                 THEN w.tvdb_season ELSE w.tmdb_season END,
            CASE WHEN ?1 IS NOT NULL AND w.tvdb = ?1 AND w.tvdb_season = ?3
                 THEN w.tvdb_offset ELSE w.tmdb_offset END
     FROM windows w
     LEFT JOIN entries e ON e.entry = w.entry
     WHERE ((?1 IS NOT NULL AND w.tvdb = ?1 AND w.tvdb_season = ?3)
         OR (?2 IS NOT NULL AND w.tmdbtv = ?2 AND w.tmdb_season = ?3))
     ORDER BY w.entry";

/// Which work entries own a provider show/season. Used to prove that a row's
/// checkpoint belongs to another anime entry before retiring/re-keying it.
#[tauri::command]
pub fn identity_window_owners(
    app: AppHandle,
    state: State<'_, IdentityState>,
    tvdb: Option<i64>,
    tmdb: Option<i64>,
    season: i64,
) -> Result<Vec<WindowOwner>, String> {
    db::with_conn(&app, &*state, |conn| {
        let mut stmt = conn
            .prepare(WINDOW_OWNER_SQL)
            .map_err(|error| format!("identity owners: prepare: {error}"))?;
        let rows = stmt
            .query_map(params![tvdb, tmdb, season], |row| {
                Ok(WindowOwner {
                    entry: row.get(0)?,
                    title: row.get(1)?,
                    media_type: row.get(2)?,
                    tvdb: row.get(3)?,
                    tmdb: row.get(4)?,
                    season: row.get(5)?,
                    offset: row.get(6)?,
                })
            })
            .map_err(|error| format!("identity owners: query: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("identity owners: rows: {error}"))?;
        Ok(rows)
    })
}
#[tauri::command]
pub async fn identity_clear_data(
    app: AppHandle,
    state: State<'_, IdentityState>,
) -> Result<db::IdentityStatus, String> {
    // Serialize removal with startup/forced pack refresh. Otherwise a download
    // already in flight could reinstall the pack after Remove reports success.
    let _import = state.import.lock().await;
    {
        let mut guard = state
            .conn
            .lock()
            .map_err(|_| "identity: db lock poisoned".to_string())?;
        *guard = None;
    }
    for path in [
        db::db_path(&app)?,
        db::tmp_path(&app)?,
        db::prev_path(&app)?,
    ] {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|error| format!("identity: delete {}: {error}", path.display()))?;
        }
    }
    db::status(&app, None)
}
#[cfg(test)]
mod refresh_integrity_tests {
    use super::{require_imported_windows, WINDOW_OWNER_SQL};
    use rusqlite::{params, Connection};

    #[test]
    fn rejects_partial_refresh_before_swapping_existing_database() {
        assert!(require_imported_windows(0).is_err());
        assert!(require_imported_windows(42).is_ok());
    }

    #[test]
    fn season_owner_requires_season_for_the_matching_catalog_provider() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entries (entry INTEGER PRIMARY KEY, title TEXT, type TEXT);
             CREATE TABLE windows (
                 entry INTEGER, tvdb INTEGER, tmdbtv INTEGER,
                 tvdb_season INTEGER, tmdb_season INTEGER,
                 tvdb_offset INTEGER, tmdb_offset INTEGER
             );
             INSERT INTO entries VALUES (1, 'TVDB first season', 'TV');
             INSERT INTO entries VALUES (2, 'TVDB sixth season', 'ONA');
             INSERT INTO windows VALUES (1, 262954, 45790, 1, 6, 0, 0);
             INSERT INTO windows VALUES (2, 262954, 45790, 6, 1, 0, 0);",
        )
        .unwrap();
        let mut query = conn.prepare(WINDOW_OWNER_SQL).unwrap();
        let mut owners = |tvdb: Option<i64>, tmdb: Option<i64>| -> Vec<i64> {
            query
                .query_map(params![tvdb, tmdb, 6], |row| row.get::<_, i64>(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(owners(Some(262954), None), vec![2]);
        assert_eq!(owners(None, Some(45790)), vec![1]);
        assert_eq!(owners(Some(262954), Some(45790)), vec![1, 2]);
    }
}
