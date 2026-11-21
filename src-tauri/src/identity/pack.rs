use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

const RELEASE_URL: &str =
    "https://api.github.com/repos/cedya77/anime-offline-database/releases/tags/latest";
const PACK_ASSET: &str = "anime-offline-database.jsonl.zst";
const ANIME_LISTS_URL: &str =
    "https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-master.xml";

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: Option<u64>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    updated_at: String,
    assets: Vec<ReleaseAsset>,
}

pub struct DownloadedPack {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub version: String,
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Fetch the latest pack, verify the release asset SHA-256, and return the
/// compressed bytes. GitHub release assets redirect to a short-lived signed URL;
/// the redirect is followed immediately and the digest is checked afterwards.
pub async fn download_latest() -> Result<DownloadedPack, String> {
    let client = reqwest::Client::builder()
        .user_agent("Harbor anime identity pack")
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("identity pack: client: {error}"))?;

    let release = client
        .get(RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("identity pack: release request: {error}"))?
        .error_for_status()
        .map_err(|error| format!("identity pack: release status: {error}"))?
        .json::<Release>()
        .await
        .map_err(|error| format!("identity pack: release body: {error}"))?;

    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == PACK_ASSET)
        .ok_or_else(|| format!("identity pack: asset {PACK_ASSET} missing from release"))?;

    let expected = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "identity pack: release asset has no sha256 digest".to_string())?;

    let bytes = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|error| format!("identity pack: download: {error}"))?
        .error_for_status()
        .map_err(|error| format!("identity pack: download status: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("identity pack: download body: {error}"))?;

    if let Some(size) = asset.size {
        if bytes.len() as u64 != size {
            return Err(format!(
                "identity pack: size mismatch (expected {size}, got {})",
                bytes.len()
            ));
        }
    }

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = hex(&hasher.finalize());
    if sha256 != expected {
        return Err("identity pack: sha256 mismatch".to_string());
    }

    let stamp = asset
        .updated_at
        .clone()
        .unwrap_or_else(|| release.updated_at.clone());
    Ok(DownloadedPack {
        bytes: bytes.to_vec(),
        sha256,
        version: format!("{}@{stamp}", release.tag_name),
    })
}

/// Fetch the AniDB -> TVDB/TMDB window list. This is a best-effort companion
/// to the pack: a failure leaves identity lookups working with no windows.
pub async fn download_anime_lists() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Harbor anime identity pack")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("identity windows: client: {error}"))?;
    let bytes = client
        .get(ANIME_LISTS_URL)
        .send()
        .await
        .map_err(|error| format!("identity windows: request: {error}"))?
        .error_for_status()
        .map_err(|error| format!("identity windows: status: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("identity windows: body: {error}"))?;
    Ok(bytes.to_vec())
}

/// Stream-decompress the pack. zstd keeps this bounded: the caller sees a
/// `BufRead` and never materializes the uncompressed 61 MB document.
pub fn decode_zstd(bytes: &[u8]) -> Result<impl BufRead + '_, String> {
    let decoder = zstd::stream::read::Decoder::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("identity pack: zstd: {error}"))?;
    Ok(BufReader::new(decoder))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn round_trips_a_zstd_stream() {
        let payload = b"{\"lastUpdate\":\"x\"}\n{\"sources\":[]}\n";
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        encoder.write_all(payload).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut decoded = decode_zstd(&compressed).unwrap();
        let mut out = String::new();
        std::io::Read::read_to_string(&mut decoded, &mut out).unwrap();
        assert_eq!(out.as_bytes(), payload);
    }

    #[test]
    fn hex_encodes_lowercase() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
