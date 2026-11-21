# Harbor Custom 1.0.2 Beta — November 6, 2026

This update merges the exact official `v1.0.2-beta` tag, commit `359dc317cba73e035d83a1384ba7b302341a5c2f`, into the personal custom build.

The update includes upstream playback queue, offline download, metadata priority, episode review, profile, subtitle, and platform improvements. It retains the custom Trakt-first More Like This feed, HDR Toys shader/subtitle handling and SDR handoff, AIOStreams library and Easynews NZB integration, AIOMetadata search coverage and bare TMDB IDs, cached episode IMDb ratings, local catalogs, catalog title search, persistent Continue Watching frames, grouped dismissals/Clear All, and TorBox date sorting.

Merge resolutions combine the new Nuvio and metadata flows with the custom catalog source selection, dismissal checkpoints, thumbnail fallbacks, original-language subtitle policy, and cached episode badges. Large alternate episode orders retain upstream visibility-based rating loading. The obsolete disk-cache-folder implementation is replaced by upstream's RAM-only buffer policy.

## Build reuse

The official Windows installer was downloaded without running it and verified against GitHub's published SHA-256: `5597f687dbdded370980eaf1cd680cfb514e05aaba4cd345d41c98ef4b004ec9`. Its runtime payload supplies the bundled media tools, libmpv, fonts, Extensions/Java runtime, game engine, and optional Music component. The Extensions bridge passed its protocol ping.

The changed interface and Windows app core are compiled for version 1.0.2 with Whisper support, using the existing compiler/package caches. No clean rebuild of all bundled runtimes is performed. Native dependencies that changed in the official lockfile must still be compiled as needed.

## Validation

- 257 targeted custom and upstream regression tests passed, covering recommendations, catalog/metadata identity, HDR Toys, thumbnails, dismissals, original audio/subtitles, episode ratings, queues, RAM buffering, finale detection, metadata priority, and Whisper setup.
- TypeScript typecheck and the native `cargo check` with Whisper support passed.
- Custom source checks found no errors. Existing warnings in the filename-control-character regex and search-result array allocation are unchanged in behavior.
- Release publication includes an embedded-interface verification report, a per-file portable archive checksum manifest, and uploaded-asset checksum verification.
- Live provider playback and Linux execution are not verified by this Windows build.

Download the **complete portable ZIP**, fully quit Harbor, and extract it into a new folder. Existing settings and HDR Toys files remain in AppData. All previous releases remain available as fallbacks.


