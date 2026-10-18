# Harbor Custom

An unofficial personal snapshot of Harbor 0.9.132 with custom playback, subtitle, watchlist, dismissal, HDR, responsiveness, and AIOMetadata search changes. Preserved by Quantumishard on October 14, 2026. This is not an official Harbor release and carries no promise of continued upstream support.

## Windows download

Download the Windows x64 ZIP and `SHA256SUMS.txt` from [Releases](https://github.com/Quantumishard/harbor-custom/releases). Fully quit Harbor, extract the complete ZIP into a new folder, and run `harbor.exe`. Keep all accompanying runtime files together. Windows WebView2 is required. Back up existing Harbor data before using any build.

Latest packaged build: `custom-subtitle-style-revert-20261018`.

AIOMetadata catalogs with manifest IDs `aio-metadata` or `com.aio.metadata` can supply up to 100 results per catalog to main search. Movie and series rows containing those results retain up to 100 items through both merge passes. The addon must supply those results; this does not add pagination. Other addon limits remain as before.

## Natural-language catalog filters (2026-10-17)

AIOMetadata catalogs now offer **Filter this catalog** in the full catalog grid. Requests are interpreted once, then the backend scans catalog membership, applies metadata rules, sorts all matches and returns paginated results. Progress, missing-metadata counts and Clear are available in Harbor. **Stop and show results** stops a large scan and returns the sorted matches already checked, explicitly labeled as partial. Partial snapshots are cached for 30 minutes after their last use; ranking covers only the scanned portion. Requires the companion backend patch in `packaging/aiometadata/natural-catalog-filter.patch`; the user's server is already updated.

The added subtitle color and brightness overrides were reverted on October 18 after a PGS placement regression. Original subtitle styling/override behavior is restored. See [usage, verification and limitations](docs/release-notes/natural-catalog-filters-20261017.md).

## Semantic relevance correction (backend update, 2026-10-18)

Thematic filters now preserve the requested word sense and use the configured Gemini model to review lexical candidates. For example, **subterranean** refers to physical below-ground settings: American Mary's underground body-modification no longer qualifies, while The Descent and As Above, So Below pass the real-model regression test. This is a backend update compatible with the current Harbor download.

Purely factual filters keep their deterministic checks. Thematic candidates incur extra batched AI calls; positive and negative review decisions are cached for 30 minutes and scoped to account, model, intent and metadata. Stop snapshots stay fixed during in-flight reviews. Installations with the previous Stop backend can apply `packaging/aiometadata/semantic-relevance.patch`, then rebuild/restart AIOMetadata. First installations use the updated full companion patch. This improves candidate precision; broad lexical candidate retrieval can still miss titles whose metadata lacks relevant clues.

## Alternative filters (backend update, 2026-10-18)

Filters now support alternatives across different fields. For example, **southeast asian language or theme** accepts either a regional original language or a relevant regional theme; an English-language film can qualify through its theme. Shared year, rating and genre limits still apply to every branch, and sorting applies to the combined deduplicated results. Thematic branches retain AI relevance review. Up to six alternatives are supported; nested alternatives are not supported.

This is an AIOMetadata update; no new Harbor download is required. Existing semantic-review installations can apply `packaging/aiometadata/alternative-filters.patch`, then rebuild/restart AIOMetadata. New installations use the full companion patch. The planner and validator allow up to 64 clues per group to accommodate regional names and demonyms.

## Episode-rating recovery (source update, 2026-10-17)

Episode IMDb ratings are now saved locally, shown immediately when returning to a season, and retained if a provider fails. Empty responses can recover after a short backoff; requests have timeouts and missing badges retry automatically. The configured OMDb key remains private, and the existing API-limit handling is preserved. This repair is included in the October 17 packaged build.

TVDB ordering and story arcs now request IMDb ratings for the seasons actually displayed, independently of the main season selector. Cards and rows use matching season/episode coordinates, and multi-season lists fetch at most four seasons concurrently.

Badges still depend on provider coverage. OMDb may omit individual episode ratings even with a premium key; Harbor preserves available IMDb scores and does not invent missing ones or label TMDB scores as IMDb.

## Episode ratings and season return

Cinemeta episode cards and rows now use the configured OMDb key for episode IMDb ratings independently of the retired Harbor service. Desktop episode lists restore the last selected valid season when returning from episode selection, including after the detail view is recreated.

## Remembered search position

Search returns to the same scroll position when reopened or when using Back from a title. A different query, profile, mode, or filter starts at the top. Position memory lasts for the current Harbor session.

## Local catalogs and detail IMDb ratings

Catalogs and Discover now offer **Account + device**, **Stremio account**, and **Local / no login** sources. While signed in, choose **Save account catalogs locally** before signing out. Local mode combines the remembered collection with device addons; use **Catalogs → Customize** to move or hide catalogs. The remembered addon definitions, genre filters, source choice, and local order are preserved per Harbor profile and included in addon backups. Catalog requests still depend on the addon provider. Successful empty account collections replace stale snapshots; network failures preserve the last usable snapshot.

The title detail IMDb badge now recognizes Cinemeta ratings as IMDb, uses matching full metadata, and can fetch a Cinemeta score independently of the title/description provider toggle. A TMDB score is never relabeled as IMDb. Existing rating visibility preferences are retained.

## Source and build information

This repository is a fresh snapshot of the existing customized working tree, including its source changes and local source tests. It is based on local commit `45f30a4e016ba0f161b1c45aa40107cf64a5d7fb` from October 7, 2026. Historical Git metadata, private app data, login sessions, provider keys, dependency caches, and build outputs are not part of this repository.

See [the preserved upstream README](README-UPSTREAM.md) for architecture and setup details, and [AGENTS.md](AGENTS.md) for contributor instructions. The upstream instructions may refer to services or downloads that are no longer available. The custom Windows builds are rebuilt and packaged with the preserved runtime files. An entirely offline rebuild is not yet verified.

Upstream GitHub workflows are preserved under `docs/upstream-workflows` as inactive reference files. Review and adapt them before enabling automation for this repository.

## Service availability

The desktop application still depends on external services for online features. Harbor-hosted sync, account/community features, relays, authentication proxies, update feeds, and downloaded assets can fail if their hosts disappear. Stremio login, catalog addons, metadata providers, and playback providers also have independent availability. A saved session or cached offline catalog does not establish that a fresh login or fresh catalog will work after shutdown.

## Licensing

Harbor source is distributed under the [MIT License](LICENSE), retaining the original copyright and permission notice. Bundled libraries, binaries, and assets retain their own licenses; see `src-tauri/THIRD-PARTY-NOTICES.txt` and the notices shipped with the Windows package. This repository supplies a player, not a media library or account access.
