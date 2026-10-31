# Harbor Custom — AIOMetadata TMDB-ID compatibility (October 31, 2026)

Build: `custom-bare-tmdb-20261031` (Windows x64).

AIOMetadata supplies TMDB-only titles using IDs such as `tmdb:1588457`, with the movie/series type in a separate field. Harbor previously recognized only `tmdb:movie:1588457` and `tmdb:tv:...` when loading full TMDB details. A recommendation could therefore show its supplied title and artwork but omit runtime, genres, credits, and other TMDB detail sections.

The detail loader now accepts bare numeric TMDB IDs and selects the movie or TV endpoint from the supplied media type. This applies to all affected movie and series entries, including titles without an IMDb entry. Existing scoped TMDB IDs and IMDb resolution retain their behavior. Invalid IDs and ambiguous types are rejected safely. The original addon IDs are retained for playback, metadata requests, and library identity.

All earlier customizations, thumbnail fixes, episode-number fallback fixes, and full-catalog title search are included. Existing HDR Toys files and settings remain in AppData.

Validation: 78 targeted checks passed. Changed files passed formatting/lint checks and TypeScript typecheck. The Windows executable and full portable archive are verified before publication. Live provider playback and Linux execution are not tested.

Fully quit Harbor, extract the entire ZIP into a new folder, and run harbor.exe.
