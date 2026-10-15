# Harbor Custom

An unofficial personal snapshot of Harbor 0.9.132 with custom playback, subtitle, watchlist, dismissal, HDR, responsiveness, and AIOMetadata search changes. Preserved by Quantumishard on October 14, 2026. This is not an official Harbor release and carries no promise of continued upstream support.

## Windows download

Download the Windows x64 ZIP and `SHA256SUMS.txt` from [Releases](https://github.com/Quantumishard/harbor-custom/releases). Fully quit Harbor, extract the complete ZIP into a new folder, and run `harbor.exe`. Keep all accompanying runtime files together. Windows WebView2 is required. Back up existing Harbor data before using any build.

Latest packaged build: `custom-local-catalogs-imdb-detail-20261015`.

AIOMetadata catalogs with manifest IDs `aio-metadata` or `com.aio.metadata` can supply up to 100 results per catalog to main search. Movie and series rows containing those results retain up to 100 items through both merge passes. The addon must supply those results; this does not add pagination. Other addon limits remain as before.

## Local catalogs and detail IMDb ratings

Catalogs and Discover now offer **Account + device**, **Stremio account**, and **Local / no login** sources. While signed in, choose **Save account catalogs locally** before signing out. Local mode combines the remembered collection with device addons; use **Catalogs → Customize** to move or hide catalogs. The remembered addon definitions, genre filters, source choice, and local order are preserved per Harbor profile and included in addon backups. Catalog requests still depend on the addon provider. Successful empty account collections replace stale snapshots; network failures preserve the last usable snapshot.

The title detail IMDb badge now recognizes Cinemeta ratings as IMDb, uses matching full metadata, and can fetch a Cinemeta score independently of the title/description provider toggle. A TMDB score is never relabeled as IMDb. Existing rating visibility preferences are retained.

## Source and build information

This repository is a fresh snapshot of the existing customized working tree, including its source changes and local source tests. It is based on local commit `45f30a4e016ba0f161b1c45aa40107cf64a5d7fb` from October 7, 2026. Historical Git metadata, private app data, login sessions, provider keys, dependency caches, and build outputs are not part of this repository.

See [the preserved upstream README](README-UPSTREAM.md) for architecture and setup details, and [AGENTS.md](AGENTS.md) for contributor instructions. The upstream instructions may refer to services or downloads that are no longer available. The existing Windows release is preserved without rebuilding it during publication. An entirely offline rebuild is not yet verified.

Upstream GitHub workflows are preserved under `docs/upstream-workflows` as inactive reference files. Review and adapt them before enabling automation for this repository.

## Service availability

The desktop application still depends on external services for online features. Harbor-hosted sync, account/community features, relays, authentication proxies, update feeds, and downloaded assets can fail if their hosts disappear. Stremio login, catalog addons, metadata providers, and playback providers also have independent availability. A saved session or cached offline catalog does not establish that a fresh login or fresh catalog will work after shutdown.

## Licensing

Harbor source is distributed under the [MIT License](LICENSE), retaining the original copyright and permission notice. Bundled libraries, binaries, and assets retain their own licenses; see `src-tauri/THIRD-PARTY-NOTICES.txt` and the notices shipped with the Windows package. This repository supplies a player, not a media library or account access.
