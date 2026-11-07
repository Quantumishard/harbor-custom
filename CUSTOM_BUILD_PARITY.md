# Custom 1.0.1 → 1.0.2 beta feature audit

Audit date: November 6, 2026. Build: `custom-1.0.2-beta-parity-20261106`.

Compared the latest released custom 1.0.1 (`custom-trakt-20261106`, commit `3721649852a9b0eaab485cf2681c2c9444c86cb5`) with the first custom 1.0.2 (`ece186c08f94304d07b2071369bce4d5741b8e46`) and official 1.0.2 (`359dc317cba73e035d83a1384ba7b302341a5c2f`).

## What went wrong

The upstream 1.0.2 changes deliberately simplified context menus. They removed image commands, restricted navigation and last-playback commands to page backgrounds, removed the player's Settings shortcut, and removed film/show sharing. The earlier upgrade retained the personal custom patches but also inherited these upstream removals. Preserving custom patches alone did not establish feature parity with the entire 1.0.1 interface; the earlier assurance was too broad.

The Media gallery's poster/logo/backdrop setters and saved artwork stores were **unchanged**, and the detail page still rendered Media. This does not establish which installed build the user saw or reproduce their exact missing-controls case. Two concrete availability gaps were found: empty provider gallery arrays hid the artwork tabs even when the title had current artwork, and the action buttons depended on pointer hover. An active tab could also become empty after a metadata refresh removed that category.

## Restored and improved

| Feature | Result |
| --- | --- |
| Per-title poster selection/reset | Existing persistence retained; available from the Media button and registered right-click menu. |
| Per-title logo selection/reset | Same; the current title/hero logo is included even when excluded from TMDB's alternatives. |
| Per-title backdrop selection/reset | Same; separate from the app-wide theme backdrop. |
| Theme backdrop selection | Retained and also available through the Media right-click menu. |
| Media tab availability | Existing title artwork supplements empty alternatives without requesting another provider. Duplicate URLs are removed. |
| Media refresh | Falls back to a populated tab when the selected category disappears. |
| Artwork keyboard/touch access | Action buttons appear on keyboard focus and remain visible on small screens. |
| View image | Restored the existing image viewer with its zoom, save, and supported copy controls. |
| Save/copy image | Restored; clipboard copy remains conditional on platform capability. |
| Copy/open image URL | Restored only when the existing public-URL policy allows sharing. Private credentials and local URLs remain excluded. |
| Expanded title/item menus | Restored Back, Settings, last playback, profile/navigation destinations, and Refresh where their normal capabilities allow. |
| Film/show sharing | Restored “Share as link.” |
| Player Settings | Restored. Stream/magnet copying and other playback tools remain available. |
| Music artwork saving | Restored for tracks, albums, artists, and playlists; retained 1.0.2's Play Next action. |
| Manga visible-page viewer | Restored page/spread commands and the image viewer; retained the current reader implementation. |

Image tools stay separate from title membership menus. Native text-field menus, profile/PIN restrictions, stale-session checks, and registered target ownership remain in place. New 1.0.2 queue actions, Drop Show, download preparation, watched-state updates, and membership guards were retained rather than replacing the context menu wholesale with the old implementation.

## Earlier custom features retained

These were checked against the latest 1.0.1 snapshot, not every historical customization (some older experiments had already been reverted before that release).

| Area | Features checked | Evidence |
| --- | --- | --- |
| Recommendations | Trakt-first More Like This on desktop, mobile, Big Picture, and end screen; provider fallback and title filtering | Source integration and Trakt regression tests |
| Search | AIOMetadata result handling, bare TMDB IDs, full-catalog displayed-title search, search/page scroll restoration | Source comparison and custom/search tests |
| Metadata | Bare numeric TMDB movie/show identity, IMDb/TMDB labels, Cinemeta detail ratings | Source comparison and metadata tests |
| Episodes | Cached/retried IMDb ratings, season return, alternate/story-arc seasons, alternate numbering/file resolution | Rating, ordered-episode, pipeline, and file tests |
| Catalogs | Source selector, account/device versus Stremio versus local sources, local/no-login catalogs, per-profile ordering and snapshots | Source comparison and local catalog tests |
| Continue Watching | Persistent frames, canonical-alias frame selection, artwork fallbacks, grouped dismissals and Clear All | Snapshot, dismissal, source comparison, and regression tests |
| Stream services | AIOStreams authenticated library and sign-in path; Easynews NZB integration; redirect handling | Source comparison, AIOStreams and Easynews tests |
| TorBox | Combined torrent/Usenet/web date-added sorting | Source comparison and TorBox tests |
| HDR/shaders | HDR Toys subtitle white, shader state and SDR handoff, shader-used-session recreation | Source comparison and HDR/shader tests; no live playback claim |
| Tracks/subtitles | Original-language audio, English fallback for foreign originals, secondary text subtitle selection/style compatibility | Source comparison and subtitle/audio tests |
| Library safety | Temporary-entry/bookmark handling, membership scope, watchlist and dismissed-progress behavior | Context, synchronization, and dismissal tests |
| Navigation | Retained root tabs, catalog navigation, episode/chapter navigation alongside new 1.0.2 features | Source comparison and navigation/chapter tests |

## Moved or replaced, rather than missing

| Old interface | 1.0.2 equivalent / decision |
| --- | --- |
| Nuvio profile editor in Account settings | Uses the shared profile picker. Create/edit, avatars, PIN verification/change/removal, and primary transfer have corresponding current implementations. |
| Manual Harbor-to-Nuvio slot mapping | Replaced by separate account providers and direct Nuvio profiles. **User chose to keep 1.0.2 account separation.** |
| Old disk-cache folder and full-file buffering | Replaced by memory buffering. **User chose to keep 1.0.2 memory buffering.** Old disk-cache settings are not restored. |
| Award tabs toggle | Replaced by award display choices (tabs/badge/none), including legacy setting migration and separate poster/TV card controls. |
| Continue last watched | Renamed “Resume last watched”; continuation and completed-playback confirmation remain. Expanded access restored. |
| Download deletion button | Uses the shared deletion/confirmation component, with receipt/file capability handling. |
| Spotify browsing setup | Expanded into separate browsing authorization/status and audio pairing rather than removed. |
| Game completion estimates | HowLongToBeat lookup with the existing IGDB fallback. |
| Discover catalog browser | Moved into the Catalogs directory; source selection and custom catalog search retained. |
| Detail hero backdrop component | Replaced by the current detail hero/image-resource implementation, with the saved title-artwork stores retained. |
| Native Extensions commands | Routed through `native_module_call` to the bundled Extensions module rather than the removed in-process Capstan file. |
| Cloudflare reporting callback | Replaced by the current verified browser/session flow; no old callback restored. |

## Scope and verification limits

The source audit compared 5,101 old and 5,285 new TypeScript/TSX files outside translation dictionaries, checked removed literal interface labels/action IDs, settings changes, deleted/renamed components, and native command changes (594 versus 608 recognized command definitions). Literal inventory helps locate losses; it is not a proof that every dynamic interface state or external service behaves correctly.

Validation for this restoration: **441 selected regression tests passed**, including rendered production menu tests and a production Media-gallery test that exercises set/reset, persistent storage, right-click registration, current-artwork fallback, and tab removal. Changed-file formatting/lint checks passed without source warnings. TypeScript and packaged-interface verification are recorded with the release artifacts.

No Rust playback implementation was changed by this restoration. The Windows application must still be incrementally linked to embed the updated interface; existing compiler caches and the verified official 1.0.2 runtime payload are reused. A clean rebuild of all runtimes is unnecessary.

Live provider playback, the user's installed application's exact state, and Linux execution were not tested. Missing artwork cannot be invented when no provider supplies it; addon-only metadata mode continues to respect that setting. Native clipboard/filesystem behavior depends on the host platform. This report distinguishes source/test parity from live-service verification.
