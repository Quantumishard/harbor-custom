use std::io::BufRead;

use quick_xml::events::Event;
use quick_xml::Reader;
use rusqlite::{params, Connection};
use serde::Deserialize;

use crate::identity::db;

/// Compact scheme codes keep the identity table and its index small.
pub const SCHEME_ANIDB: i64 = 1;
pub const SCHEME_ANILIST: i64 = 2;
pub const SCHEME_KITSU: i64 = 3;
pub const SCHEME_MAL: i64 = 4;
pub const SCHEME_SIMKL: i64 = 5;

pub fn scheme_code(name: &str) -> Option<i64> {
    match name {
        "anidb" => Some(SCHEME_ANIDB),
        "anilist" => Some(SCHEME_ANILIST),
        "kitsu" => Some(SCHEME_KITSU),
        "mal" => Some(SCHEME_MAL),
        "simkl" => Some(SCHEME_SIMKL),
        _ => None,
    }
}

pub fn scheme_name(code: i64) -> &'static str {
    match code {
        SCHEME_ANIDB => "anidb",
        SCHEME_ANILIST => "anilist",
        SCHEME_KITSU => "kitsu",
        SCHEME_MAL => "mal",
        SCHEME_SIMKL => "simkl",
        _ => "unknown",
    }
}

/// The subset of the anime-offline-database entry shape the identity layer needs.
#[derive(Deserialize)]
struct RawEntry {
    #[serde(default)]
    sources: Vec<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(rename = "type", default)]
    media_type: Option<String>,
    #[serde(default)]
    episodes: Option<i64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    #[serde(rename = "relatedAnime")]
    related_anime: Vec<String>,
}

#[derive(Deserialize)]
struct RawMeta {
    #[serde(rename = "lastUpdate")]
    last_update: Option<String>,
    license: Option<serde_json::Value>,
}

#[derive(Debug, Default)]
pub struct ImportSummary {
    pub entries: usize,
    pub identities: usize,
    pub related_entries: usize,
    pub related_edges: usize,
}

pub fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE entries(
            entry INTEGER PRIMARY KEY,
            title TEXT,
            type TEXT,
            episodes INTEGER,
            status TEXT
        );
        CREATE TABLE identities(
            scheme INTEGER NOT NULL,
            id TEXT NOT NULL,
            entry INTEGER NOT NULL,
            PRIMARY KEY(scheme, id)
        );
        CREATE TABLE sources(
            url TEXT PRIMARY KEY,
            entry INTEGER NOT NULL
        );
        CREATE TABLE raw_related(
            entry INTEGER NOT NULL,
            url TEXT NOT NULL
        );
        CREATE TABLE related(
            entry INTEGER PRIMARY KEY,
            related_blob BLOB NOT NULL
        );
        CREATE TABLE windows(
            entry INTEGER NOT NULL,
            anidb INTEGER,
            tvdb INTEGER,
            tmdbtv INTEGER,
            tvdb_season INTEGER,
            tvdb_offset INTEGER,
            tmdb_season INTEGER,
            tmdb_offset INTEGER
        );
        CREATE TABLE meta(
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )
    .map_err(|error| format!("identity import: schema: {error}"))
}

/// Resolve a provider URL to `(scheme code, numeric id)`. Slug ids and sites we
/// do not use are ignored, not guessed.
pub fn parse_scheme(url: &str) -> Option<(i64, String)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/')?;
    let (scheme, prefix) = match host {
        "anidb.net" => (SCHEME_ANIDB, "anime/"),
        "anilist.co" => (SCHEME_ANILIST, "anime/"),
        "kitsu.app" => (SCHEME_KITSU, "anime/"),
        "myanimelist.net" => (SCHEME_MAL, "anime/"),
        "simkl.com" => (SCHEME_SIMKL, "anime/"),
        _ => return None,
    };
    let id = path.strip_prefix(prefix)?;
    let id = id.split(['/', '?', '#']).next()?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((scheme, id.to_string()))
}

fn license_to_string(value: Option<serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(text)) => Some(text),
        Some(serde_json::Value::Object(map)) => map
            .get("name")
            .and_then(|name| name.as_str())
            .map(str::to_string),
        _ => None,
    }
}

fn encode_ids(ids: &[i64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ids.len() * 4);
    for id in ids {
        out.extend_from_slice(&(*id as u32).to_le_bytes());
    }
    out
}

pub fn decode_ids(blob: &[u8]) -> Vec<i64> {
    blob.chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as i64)
        .collect()
}

/// Stream the JSONL pack into a freshly created database.
///
/// The first line is dataset metadata; every following line is one work. Related
/// URLs are stored first and resolved in SQL once every source is known; the
/// resolved adjacency is then compressed into one little-endian u32 blob per
/// entry so the graph stays small on disk.
pub fn import_jsonl<R: BufRead>(
    conn: &mut Connection,
    mut reader: R,
    pack_version: &str,
    upstream_sha256: &str,
    built_at: i64,
) -> Result<ImportSummary, String> {
    create_schema(conn)?;

    let mut first = String::new();
    reader
        .read_line(&mut first)
        .map_err(|error| format!("identity import: read metadata line: {error}"))?;
    let meta: RawMeta = serde_json::from_str(first.trim())
        .map_err(|error| format!("identity import: metadata line: {error}"))?;
    let last_update = meta.last_update.unwrap_or_default();
    let license = license_to_string(meta.license).unwrap_or_default();

    let mut summary = ImportSummary::default();
    let tx = conn
        .transaction()
        .map_err(|error| format!("identity import: begin: {error}"))?;
    {
        let mut insert_entry = tx
            .prepare("INSERT INTO entries(entry, title, type, episodes, status) VALUES(?1,?2,?3,?4,?5)")
            .map_err(|error| format!("identity import: prepare entry: {error}"))?;
        let mut insert_identity = tx
            .prepare("INSERT OR IGNORE INTO identities(scheme, id, entry) VALUES(?1,?2,?3)")
            .map_err(|error| format!("identity import: prepare identity: {error}"))?;
        let mut insert_source = tx
            .prepare("INSERT OR IGNORE INTO sources(url, entry) VALUES(?1,?2)")
            .map_err(|error| format!("identity import: prepare source: {error}"))?;
        let mut insert_related = tx
            .prepare("INSERT INTO raw_related(entry, url) VALUES(?1,?2)")
            .map_err(|error| format!("identity import: prepare related: {error}"))?;

        let mut line = String::new();
        let mut entry: i64 = 0;
        loop {
            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|error| format!("identity import: read: {error}"))?;
            if read == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let raw: RawEntry = serde_json::from_str(trimmed)
                .map_err(|error| format!("identity import: entry {}: {error}", entry + 1))?;
            entry += 1;
            summary.entries += 1;
            insert_entry
                .execute(params![
                    entry,
                    raw.title,
                    raw.media_type,
                    raw.episodes,
                    raw.status
                ])
                .map_err(|error| format!("identity import: entry insert: {error}"))?;
            for url in &raw.sources {
                insert_source
                    .execute(params![url, entry])
                    .map_err(|error| format!("identity import: source insert: {error}"))?;
                if let Some((scheme, id)) = parse_scheme(url) {
                    insert_identity
                        .execute(params![scheme, id, entry])
                        .map_err(|error| format!("identity import: identity insert: {error}"))?;
                    summary.identities += 1;
                }
            }
            for url in &raw.related_anime {
                insert_related
                    .execute(params![entry, url])
                    .map_err(|error| format!("identity import: related insert: {error}"))?;
            }
        }
    }
    tx.commit()
        .map_err(|error| format!("identity import: commit rows: {error}"))?;

    conn.execute_batch(
        "
        CREATE INDEX raw_related_url ON raw_related(url);
        CREATE INDEX idx_windows_tvdb ON windows(tvdb, tvdb_season);
        CREATE INDEX idx_windows_entry ON windows(entry);
        ",
    )
    .map_err(|error| format!("identity import: indexes: {error}"))?;

    // Resolve related URLs to work entries, then compress the adjacency.
    let pairs: Vec<(i64, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT r.entry, s.entry
                 FROM raw_related r
                 JOIN sources s ON s.url = r.url
                 ORDER BY r.entry",
            )
            .map_err(|error| format!("identity import: prepare related join: {error}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|error| format!("identity import: related join: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("identity import: related rows: {error}"))?
    };
    summary.related_edges = pairs.len();
    {
        let mut insert_related = conn
            .prepare("INSERT OR REPLACE INTO related(entry, related_blob) VALUES(?1,?2)")
            .map_err(|error| format!("identity import: prepare related blob: {error}"))?;
        let mut index = 0;
        while index < pairs.len() {
            let entry = pairs[index].0;
            let mut ids = Vec::new();
            while index < pairs.len() && pairs[index].0 == entry {
                if pairs[index].1 != entry {
                    ids.push(pairs[index].1);
                }
                index += 1;
            }
            ids.sort_unstable();
            ids.dedup();
            if ids.is_empty() {
                continue;
            }
            summary.related_entries += 1;
            insert_related
                .execute(params![entry, encode_ids(&ids)])
                .map_err(|error| format!("identity import: related blob insert: {error}"))?;
        }
    }

    conn.execute_batch(
        "
        DROP TABLE raw_related;
        DROP TABLE sources;
        CREATE INDEX idx_identities_entry ON identities(entry);
        ",
    )
    .map_err(|error| format!("identity import: finalize: {error}"))?;

    let meta_rows = [
        ("schema", db::SCHEMA_VERSION.to_string()),
        ("pack_version", pack_version.to_string()),
        ("upstream_sha256", upstream_sha256.to_string()),
        ("built_at", built_at.to_string()),
        ("entries", summary.entries.to_string()),
        ("related_entries", summary.related_entries.to_string()),
        ("related_edges", summary.related_edges.to_string()),
        ("identity_count", summary.identities.to_string()),
        ("last_update", last_update),
        ("license", license),
    ];
    let mut insert_meta = conn
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?1, ?2)")
        .map_err(|error| format!("identity import: prepare meta: {error}"))?;
    for (key, value) in meta_rows {
        insert_meta
            .execute(params![key, value])
            .map_err(|error| format!("identity import: meta insert: {error}"))?;
    }
    conn.execute_batch("ANALYZE; VACUUM; PRAGMA optimize;")
        .map_err(|error| format!("identity import: optimize: {error}"))?;
    Ok(summary)
}

fn parse_optional_int(value: Option<&String>) -> Option<i64> {
    value.and_then(|text| text.trim().parse::<i64>().ok())
}

fn parse_optional_season(value: Option<&String>) -> Option<i64> {
    value
        .and_then(|text| text.trim().parse::<i64>().ok())
        .filter(|season| (0..=200).contains(season))
}

/// Import AniDB -> TVDB/TMDB provider windows from the Anime-Lists XML.
///
/// Anime-Lists declares no license; it is fetched at runtime, the same way the
/// existing episode-list path already uses it, and only the window fields are
/// stored. A malformed document leaves the pack's work/alias data intact with
/// no windows rather than failing the whole import.
pub fn import_windows(conn: &mut Connection, xml: &[u8]) -> Result<usize, String> {
    let mut reader = Reader::from_reader(std::io::Cursor::new(xml));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();

    let mut found = 0usize;
    let tx = conn
        .transaction()
        .map_err(|error| format!("identity windows: begin: {error}"))?;
    {
        let mut select_entry = tx
            .prepare("SELECT entry FROM identities WHERE scheme = ?1 AND id = ?2")
            .map_err(|error| format!("identity windows: prepare identity: {error}"))?;
        let mut insert = tx
            .prepare(
                "INSERT INTO windows(entry, anidb, tvdb, tmdbtv, tvdb_season, tvdb_offset, tmdb_season, tmdb_offset)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            )
            .map_err(|error| format!("identity windows: prepare insert: {error}"))?;

        loop {
            let event = reader
                .read_event_into(&mut buffer)
                .map_err(|error| format!("identity windows: xml: {error}"))?;
            match event {
                Event::Start(element) | Event::Empty(element)
                    if element.name().as_ref() == b"anime" =>
                {
                    let mut attrs = std::collections::HashMap::new();
                    for attribute in element.attributes().with_checks(false) {
                        let attribute = attribute
                            .map_err(|error| format!("identity windows: attribute: {error}"))?;
                        let key = String::from_utf8_lossy(attribute.key.as_ref()).to_string();
                        let value = attribute
                            .unescape_value()
                            .map_err(|error| format!("identity windows: value: {error}"))?
                            .to_string();
                        attrs.insert(key, value);
                    }
                    let Some(anidb) = attrs.get("anidbid").and_then(|id| id.parse::<i64>().ok())
                    else {
                        buffer.clear();
                        continue;
                    };
                    let entry = select_entry
                        .query_row(params![SCHEME_ANIDB, anidb.to_string()], |row| {
                            row.get::<_, i64>(0)
                        })
                        .ok();
                    let Some(entry) = entry else {
                        buffer.clear();
                        continue;
                    };
                    let tvdb = parse_optional_int(attrs.get("tvdbid"));
                    let tmdbtv = parse_optional_int(attrs.get("tmdbtv"));
                    if tvdb.is_none() && tmdbtv.is_none() {
                        buffer.clear();
                        continue;
                    }
                    insert
                        .execute(params![
                            entry,
                            anidb,
                            tvdb,
                            tmdbtv,
                            parse_optional_season(attrs.get("defaulttvdbseason")),
                            parse_optional_int(attrs.get("episodeoffset")),
                            parse_optional_season(attrs.get("tmdbseason")),
                            parse_optional_int(attrs.get("tmdboffset")),
                        ])
                        .map_err(|error| format!("identity windows: insert: {error}"))?;
                    found += 1;
                }
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
    }
    tx.commit()
        .map_err(|error| format!("identity windows: commit: {error}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('windows', ?1)",
        params![found.to_string()],
    )
    .map_err(|error| format!("identity windows: meta: {error}"))?;
    conn.execute_batch("ANALYZE; PRAGMA optimize;")
        .map_err(|error| format!("identity windows: optimize: {error}"))?;
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const FIXTURE: &str = r#"{"lastUpdate":"2026-11-15","license":{"name":"ODbL 1.0"}}
{"sources":["https://anidb.net/anime/19287","https://kitsu.app/anime/49847","https://myanimelist.net/anime/61469"],"title":"Steel Ball Run","type":"ONA","episodes":1,"status":"ONGOING","relatedAnime":["https://anidb.net/anime/9304"]}
{"sources":["https://anidb.net/anime/9304","https://kitsu.app/anime/7158","https://myanimelist.net/anime/14719"],"title":"JoJo 2012","type":"TV","episodes":26,"status":"FINISHED","relatedAnime":["https://anidb.net/anime/19287"]}
{"sources":["https://kitsu.app/anime/44586"],"title":"Unrelated ONA","type":"ONA","episodes":3,"status":"FINISHED","relatedAnime":[]}
"#;

    fn imported() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode = MEMORY;").unwrap();
        import_jsonl(&mut conn, Cursor::new(FIXTURE), "test", "sha", 0).unwrap();
        conn
    }

    #[test]
    fn parses_known_provider_urls_only() {
        assert_eq!(
            parse_scheme("https://kitsu.app/anime/49847"),
            Some((SCHEME_KITSU, "49847".to_string()))
        );
        assert_eq!(
            parse_scheme("https://myanimelist.net/anime/14719"),
            Some((SCHEME_MAL, "14719".to_string()))
        );
        assert_eq!(parse_scheme("https://anime-planet.com/anime/jojo"), None);
        assert_eq!(parse_scheme("notaurl"), None);
    }

    #[test]
    fn imports_works_identities_and_related_edges() {
        let conn = imported();
        let entries: i64 = conn
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .unwrap();
        let identities: i64 = conn
            .query_row("SELECT COUNT(*) FROM identities", [], |row| row.get(0))
            .unwrap();
        let related: i64 = conn
            .query_row("SELECT COUNT(*) FROM related", [], |row| row.get(0))
            .unwrap();
        assert_eq!(entries, 3);
        assert_eq!(identities, 7);
        assert_eq!(related, 2);
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT related_blob FROM related WHERE entry = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(decode_ids(&blob), vec![2]);
    }

    #[test]
    fn imports_anime_list_windows_for_known_anidb_ids() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode = MEMORY;").unwrap();
        import_jsonl(&mut conn, Cursor::new(FIXTURE), "test", "sha", 0).unwrap();
        let xml = r#"<?xml version="1.0"?><anime-list>
            <anime anidbid="19287" tvdbid="262954" defaulttvdbseason="6" episodeoffset="" tmdbtv="45790" tmdbseason="6" tmdboffset=""/>
            <anime anidbid="424242" tvdbid="999" defaulttvdbseason="1"/>
        </anime-list>"#;
        let count = import_windows(&mut conn, xml.as_bytes()).unwrap();
        assert_eq!(count, 1, "unknown anidb ids are skipped");
        let (tvdb, season): (i64, i64) = conn
            .query_row(
                "SELECT tvdb, tvdb_season FROM windows WHERE entry = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((tvdb, season), (262954, 6));
    }
}
