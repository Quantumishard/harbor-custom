use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
pub(super) struct SavedSession {
    version: u32,
    pub base: String,
    pub cookie: String,
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| "Saved sign-in is too large")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|_| "Windows could not protect or unlock the saved AIOStreams sign-in")?;
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}

#[cfg(not(windows))]
fn crypt(_bytes: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Err("Remembered AIOStreams sign-in is supported on Windows".into())
}

pub(super) fn read(root: &Path) -> Result<Option<SavedSession>, String> {
    let path = root.join("session.dpapi");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read saved AIOStreams sign-in".into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return Err("Saved AIOStreams sign-in is invalid. Please sign in again.".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Could not read saved AIOStreams sign-in")?;
    let protected = bytes
        .strip_prefix(b"HAIO1")
        .ok_or("Saved AIOStreams sign-in is invalid")?;
    let mut plain = crypt(protected, false)?;
    let result = serde_json::from_slice::<SavedSession>(&plain)
        .map_err(|_| "Saved AIOStreams sign-in is invalid".to_string());
    use zeroize::Zeroize;
    plain.zeroize();
    let saved = result?;
    if saved.version != 1 || saved.cookie.is_empty() {
        return Err("Saved AIOStreams sign-in is invalid".into());
    }
    Ok(Some(saved))
}

pub(super) fn write(root: &Path, base: &str, cookie: &str) -> Result<(), String> {
    use std::io::Write;
    use zeroize::Zeroize;
    let mut plain = serde_json::to_vec(&SavedSession {
        version: 1,
        base: base.into(),
        cookie: cookie.into(),
    })
    .map_err(|_| "Could not prepare saved AIOStreams sign-in")?;
    let protected = crypt(&plain, true);
    plain.zeroize();
    let protected = protected?;
    std::fs::create_dir_all(root).map_err(|_| "Could not save AIOStreams sign-in")?;
    let temporary = root.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "Could not save AIOStreams sign-in")?;
        file.write_all(b"HAIO1")
            .and_then(|_| file.write_all(&protected))
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save AIOStreams sign-in")?;
        drop(file);
        std::fs::rename(&temporary, root.join("session.dpapi"))
            .map_err(|_| "Could not replace saved AIOStreams sign-in")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub(super) fn remove(root: &Path) -> Result<(), String> {
    match std::fs::remove_file(root.join("session.dpapi")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not forget saved AIOStreams sign-in".into()),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn windows_session_storage_encrypts_updates_and_forgets() {
        let root = std::env::temp_dir().join(format!("harbor-aio-{}", uuid::Uuid::new_v4()));
        assert!(read(&root).unwrap().is_none());
        write(
            &root,
            "https://example.com/",
            "session=private-fixture-value",
        )
        .unwrap();
        let encrypted = std::fs::read(root.join("session.dpapi")).unwrap();
        assert!(!encrypted
            .windows(b"private-fixture-value".len())
            .any(|w| w == b"private-fixture-value"));
        assert_eq!(
            read(&root).unwrap().unwrap().cookie,
            "session=private-fixture-value"
        );
        write(&root, "https://example.com/", "session=updated").unwrap();
        assert_eq!(read(&root).unwrap().unwrap().cookie, "session=updated");
        std::fs::write(root.join("session.dpapi"), b"HAIO1invalid").unwrap();
        assert!(read(&root).is_err());
        remove(&root).unwrap();
        assert!(read(&root).unwrap().is_none());
        std::fs::remove_dir(root).unwrap();
    }
}
