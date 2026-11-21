use std::collections::HashSet;

/// Long-lived public trackers used only when a stream brings none of its own.
///
/// The list is deliberately small. Every extra tracker can return peers that do
/// not have the torrent at all; those junk peers still complete handshakes and
/// occupy connection slots, which shows up as a large peer queue and a swarm
/// that never delivers a piece. Streams resolved by addons carry their own
/// `tr=` list, so this is a fallback rather than a session-wide announcement set.
pub const FALLBACK: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "http://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker-udp.gbitt.info:80/announce",
    "https://tracker.gcrenwp.top:443/announce",
    "https://tr.zukizuki.org:443/announce",
    "https://tracker.qu.ax:6969/announce",
];

pub fn fallback_trackers() -> Vec<String> {
    FALLBACK.iter().map(|tracker| tracker.to_string()).collect()
}

/// Session-wide fallback set for the Android engine; desktop adds trackers per
/// torrent instead.
#[cfg(any(target_os = "android", test))]
pub fn fallback_url_set() -> HashSet<url::Url> {
    FALLBACK
        .iter()
        .filter_map(|tracker| url::Url::parse(tracker).ok())
        .collect()
}

/// Prefer the trackers the source already carries; use the curated fallback only
/// when it has none. Entries are trimmed and de-duplicated.
pub fn with_fallback(trackers: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();
    for tracker in trackers {
        let tracker = tracker.trim();
        if !tracker.is_empty() && seen.insert(tracker.to_string()) {
            cleaned.push(tracker.to_string());
        }
    }
    if cleaned.is_empty() {
        fallback_trackers()
    } else {
        cleaned
    }
}

/// Splice trackers into a magnet URI as `tr=` params.
///
/// librqbit 8.1.1 does NOT honor `AddTorrentOptions.trackers` for magnet links:
/// only the magnet's own `tr=` params plus the session-wide tracker set are ever
/// announced (see session.rs `add_torrent`). So per-stream trackers passed via
/// options are silently dropped for magnets. When UDP (and therefore DHT) is
/// blocked, the magnet's HTTPS trackers are the only path to peers - if they only
/// arrive via the options list, they never get announced and the torrent sits at
/// 0 peers. Embedding them here guarantees the magnet parser picks them up.
///
/// No-op for non-magnet inputs. Trackers already declared in the magnet are not
/// duplicated. Strictly additive: it only ever appends trackers, so it cannot
/// remove any tracker the working path already relied on.
pub fn embed_into_magnet(magnet: &str, extra: &[String]) -> String {
    if !magnet.starts_with("magnet:") {
        return magnet.to_string();
    }
    let existing: HashSet<String> = url::Url::parse(magnet)
        .map(|u| {
            u.query_pairs()
                .filter(|(k, _)| k == "tr")
                .map(|(_, v)| v.into_owned())
                .collect()
        })
        .unwrap_or_default();
    let mut seen = existing;
    let mut out = magnet.to_string();
    let sep = if out.contains('?') { '&' } else { '?' };
    let mut first = true;
    for t in extra {
        let t = t.trim();
        if t.is_empty() || !seen.insert(t.to_string()) {
            continue;
        }
        out.push(if first { sep } else { '&' });
        first = false;
        out.push_str("tr=");
        out.push_str(&pct_encode(t));
    }
    out
}

/// Percent-encode a tracker URL for use as a magnet `tr=` query value. Encodes
/// everything outside the RFC 3986 unreserved set so reserved characters
/// (`:` `/` `&` `=` `?`) round-trip cleanly through `Url::query_pairs`.
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{embed_into_magnet, with_fallback, FALLBACK};

    #[test]
    fn keeps_source_trackers_and_does_not_add_fallback() {
        let trackers = with_fallback(vec![
            " udp://tracker.opentrackr.org:1337/announce ".into(),
            "udp://tracker.opentrackr.org:1337/announce".into(),
            "".into(),
        ]);
        assert_eq!(trackers.len(), 1);
        assert_eq!(trackers[0], "udp://tracker.opentrackr.org:1337/announce");
    }

    #[test]
    fn falls_back_only_when_the_source_has_no_trackers() {
        let fallback = with_fallback(vec![]);
        assert_eq!(fallback.len(), FALLBACK.len());
        assert_eq!(fallback[0], FALLBACK[0]);
    }

    #[test]
    fn embeds_fallback_trackers_into_a_bare_magnet() {
        let magnet = embed_into_magnet("magnet:?xt=urn:btih:abc", &with_fallback(vec![]));
        assert!(magnet.starts_with("magnet:?xt=urn:btih:abc&tr="));
        assert!(magnet.contains("udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"));
    }

    #[test]
    fn leaves_non_magnet_inputs_untouched() {
        assert_eq!(
            embed_into_magnet("https://example.test/a.torrent", &with_fallback(vec![])),
            "https://example.test/a.torrent"
        );
    }
}
