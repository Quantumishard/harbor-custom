use rand::Rng;
use rand_distr::Alphanumeric;
use vergen_gitcl::{BuildBuilder, Emitter, GitclBuilder};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Harbor vendors this crate. Upstream derives these strings from the enclosing
    // git repository, so every commit rewrites .git/refs/heads/<branch> and makes
    // this script re-run with a new sha, date and random build id. That invalidated
    // librespot-core and with it metadata, audio and playback after every commit,
    // even a docs-only one. Debug builds keep stable values so the chain stays
    // cached; release builds embed the real metadata below.
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        println!("cargo:rerun-if-changed=build.rs");
        println!("cargo:rustc-env=VERGEN_GIT_SHA=dev");
        println!("cargo:rustc-env=VERGEN_GIT_COMMIT_DATE=unknown");
        println!("cargo:rustc-env=VERGEN_BUILD_DATE=unknown");
        println!("cargo:rustc-env=LIBRESPOT_BUILD_ID=harbor-dev");
        return Ok(());
    }

    let gitcl = GitclBuilder::default()
        .sha(true) // outputs 'VERGEN_GIT_SHA', and sets the 'short' flag true
        .commit_date(true) // outputs 'VERGEN_GIT_COMMIT_DATE'
        .build()?;

    let build = BuildBuilder::default()
        .build_date(true) // outputs 'VERGEN_BUILD_DATE'
        .build()?;

    Emitter::default()
        .add_instructions(&build)?
        .add_instructions(&gitcl)?
        .emit()
        .expect("Unable to generate the cargo keys!");
    let build_id = match std::env::var("SOURCE_DATE_EPOCH") {
        Ok(val) => val,
        Err(_) => rand::rng()
            .sample_iter(Alphanumeric)
            .take(8)
            .map(char::from)
            .collect(),
    };

    println!("cargo:rustc-env=LIBRESPOT_BUILD_ID={build_id}");
    Ok(())
}
