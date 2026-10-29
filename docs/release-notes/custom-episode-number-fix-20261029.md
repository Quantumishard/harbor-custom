# Harbor Custom — Episode-list fix (October 29, 2026)

Build: `custom-episode-number-fix-20261029` (Windows x64).

Some shows, including Metropolis (2015), have no TMDB match for their IMDb ID. Cinemeta supplies their episodes using the `number` field, but Harbor checked only `episode` before showing its fallback episode list. The page consequently showed a description and no episodes, even after refresh.

Harbor now recognizes both numbering formats for every series, including mixed-format lists and specials. The per-season fallback uses the same episode grouping and sorting as the main episode list, retaining IDs, ratings, provider metadata, and explicit episode numbers. No title-specific mapping or ID override is used. All previous customizations, thumbnail fixes, and catalog title search are retained.

Validation: 58 targeted checks passed, including Metropolis-shaped metadata and rendered fallback rows. Changed files passed formatting/lint checks and TypeScript typecheck. The Windows executable and full portable archive are verified before publication. Live provider playback and Linux execution are not tested.

Fully quit Harbor, extract the entire ZIP into a new folder, and run harbor.exe.
