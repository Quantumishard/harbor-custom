# Harbor Custom — October 29, 2026

Build: `custom-thumbnails-title-search-20261029` (Windows x64, based on 1.0.1 beta).

- Continue Watching captures now also persist in a dedicated IndexedDB store, outside the small shared localStorage cache. Existing indexed captures migrate automatically. Title aliases, retention, and Clear thumbnails remain supported. Saved video frames take priority over the optional episode still.
- Episode strip, grid, and list layouts now try all distinct artwork candidates: TMDB still path, alternate still URL, then catalog thumbnail. Image failures no longer skip the alternate still. Grid cards retry when artwork updates. Aired/official TVDB episode orders retain matching TMDB artwork as their first candidate without changing episode numbering or metadata.
- Replaced the natural-language catalog filter with **Search this catalog by displayed title only**. Searches the entire selected catalog and genre using case-insensitive literal title matching. No AI requests, plot searches, or per-title metadata enrichment. Catalog pages are indexed once per open catalog/genre; subsequent queries reuse the index. Cancel, clear, network errors, repeated provider pages, and raw pagination offsets are handled.

## Verification

- TypeScript typecheck passed.
- Changed files passed formatting and lint checks.
- Targeted thumbnail, title-search, catalog, Continue Watching dismissal, and rewatch checks passed.
- The broader Continue Watching source-gate check has an existing failure: `shared CW: Simkl refresh does not require Trakt` expects false but receives undefined. Its test, harness, and source modules are unchanged by this update.
- Windows portable package is verified against its runtime-file manifest and embedded production interface.
- Live provider playback and Linux execution are not verified. The Linux build command was attempted on Windows and stopped because it invokes the Windows host toolchain rather than producing a Linux binary.

## Run

Fully quit Harbor, extract the entire portable ZIP into a new folder, and run `harbor.exe`. Keep the accompanying runtime files together. Existing Harbor data remains in its usual AppData location.
