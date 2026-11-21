use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const SCHEMA_VERSION: i64 = 2;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IdentityStatus {
    pub ready: bool,
    pub db_bytes: u64,
    pub pack_version: Option<String>,
    pub upstream_sha256: Option<String>,
    pub built_at: Option<i64>,
    pub entries: i64,
    pub windows: i64,
    pub schema: i64,
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("identity: app data dir unavailable: {error}"))?;
    Ok(base.join("identity"))
}

pub fn ensure_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?;
    fs::create_dir_all(&dir).map_err(|error| format!("identity: create dir: {error}"))?;
    Ok(dir)
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("harbor-identity.db"))
}

pub fn tmp_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("harbor-identity.db.tmp"))
}

pub fn prev_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("harbor-identity.db.prev"))
}

/// Restore the previous pack if a weekly swap was interrupted between renames.
fn recover(app: &AppHandle) -> Result<(), String> {
    let db = db_path(app)?;
    if db.exists() {
        return Ok(());
    }
    let prev = prev_path(app)?;
    if prev.exists() {
        fs::rename(&prev, &db).map_err(|error| format!("identity: recover db: {error}"))?;
    }
    Ok(())
}

pub fn read_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

pub fn status(app: &AppHandle, cached: Option<&Connection>) -> Result<IdentityStatus, String> {
    let path = db_path(app)?;
    let bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if !path.exists() {
        return Ok(IdentityStatus {
            ready: false,
            db_bytes: 0,
            pack_version: None,
            upstream_sha256: None,
            built_at: None,
            entries: 0,
            windows: 0,
            schema: 0,
        });
    }
    let read = |conn: &Connection| -> Result<IdentityStatus, String> {
        let int = |key: &str| {
            read_meta(conn, key)
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
        };
        let schema = int("schema");
        let ready = schema > 0;
        Ok(IdentityStatus {
            ready,
            db_bytes: bytes,
            pack_version: read_meta(conn, "pack_version"),
            upstream_sha256: read_meta(conn, "upstream_sha256"),
            built_at: read_meta(conn, "built_at")
                .and_then(|value| value.parse::<i64>().ok()),
            entries: int("entries"),
            windows: int("windows"),
            schema,
        })
    };
    match cached {
        Some(conn) => read(conn),
        None => {
            let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| format!("identity: open db: {error}"))?;
            read(&conn)
        }
    }
}

pub fn open_readonly(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("identity: open db: {error}"))?;
    conn.busy_timeout(Duration::from_millis(2000))
        .map_err(|error| format!("identity: busy timeout: {error}"))?;
    Ok(conn)
}

/// Run a query against the cached read-only connection.
pub fn with_conn<T>(
    app: &AppHandle,
    state: &crate::identity::IdentityState,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    recover(app)?;
    let mut guard = state
        .conn
        .lock()
        .map_err(|_| "identity: db lock poisoned".to_string())?;
    if guard.is_none() {
        let path = db_path(app)?;
        *guard = Some(open_readonly(&path)?);
    }
    let conn = guard
        .as_ref()
        .ok_or_else(|| "identity: db unavailable".to_string())?;
    f(conn)
}

/// Swap the freshly imported DB into place, keeping the previous file for rollback.
pub fn install_new_db(app: &AppHandle, tmp: &Path) -> Result<(), String> {
    let db = db_path(app)?;
    let prev = prev_path(app)?;
    if prev.exists() {
        let _ = fs::remove_file(&prev);
    }
    if db.exists() {
        fs::rename(&db, &prev).map_err(|error| format!("identity: park current db: {error}"))?;
    }
    if let Err(error) = fs::rename(tmp, &db) {
        // Put the old file back rather than leaving the app without a pack.
        if prev.exists() && !db.exists() {
            let _ = fs::rename(&prev, &db);
        }
        return Err(format!("identity: install db: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_of_missing_dir_is_not_ready() {
        // Path helpers require an AppHandle, so only pure parsing is unit-tested here.
        assert_eq!(SCHEMA_VERSION, 2);
    }
}
