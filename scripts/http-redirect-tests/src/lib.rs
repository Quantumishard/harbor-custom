//! Standalone harness for the app's redirect helper.
//!
//! `src-tauri/src/http_redirect.rs` reaches into the Tauri crate for its add-on
//! target validator, so this harness compiles the same file with an equivalent
//! validator instead of pulling in the whole application. Keeping the helper's
//! tests runnable without a Tauri build is the point of this crate.

// Helpers the app calls from other native modules look unused from here.
#![allow(dead_code)]

pub mod http_fetch {
    use std::net::IpAddr;

    /// Mirrors the literal-address half of the app's validator: internal
    /// addresses are refused unless the caller explicitly allows them.
    pub async fn validate_target(url: &reqwest::Url, allow_local: bool) -> Result<(), String> {
        let Some(host) = url.host_str() else {
            return Ok(());
        };
        let literal = host.trim_start_matches('[').trim_end_matches(']');
        let Ok(ip) = literal.parse::<IpAddr>() else {
            return Ok(());
        };
        let internal = match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified() || v4.is_private(),
            IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
        };
        if internal && !allow_local {
            return Err(format!("blocked internal target: {host}"));
        }
        Ok(())
    }
}

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../src-tauri/src/http_redirect.rs"
));
