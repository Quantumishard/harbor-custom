# Catalog filtering

## Catalog filters: TMDB title and year (2026-10-18)

Catalog filters on the AIOMetadata backend now use **TMDB metadata only, with no AI interpretation, semantic review, grounding, or token spending**. The main search bar is unchanged. Ordinary filter text is a literal title substring, matched against TMDB's localized and original titles with case/accent/punctuation normalization. A year constrains the original movie release or first series premiere.

Examples: `The Bear`, `The Bear 2023`, `2023`, `2023-`, `2020-2024`, `Bear since 2023`, `before 2020`, or `between 2020 and 2024`. Quote numeric titles (`"1917"`) or use `title:1917` to distinguish them from years. Append `sort:newest` or `sort:oldest` for global year ordering; default order follows the catalog. These are explicit title/year filters, not general natural-language thematic searches.

The backend scans only members of the selected catalog, uses cached TMDB details, and excludes unverified mappings from matches. Missing TMDB title/year evidence is counted as unknown. Stop returns a frozen sorted partial snapshot; results remain cached for 30 minutes after last use. Catalog-page and metadata failures still report errors without invoking AI fallback.

No Harbor download is required. The user's backend is updated. Existing installations at the October 18 11:44 version can apply `packaging/aiometadata/tmdb-title-year-filters.patch`, rebuild and restart AIOMetadata; new installations use `packaging/aiometadata/natural-catalog-filter.patch`. Older incremental patches in this directory are historical and should not be applied on top of this version. Tests reject AI module imports and cover parsing, metadata mapping, a 1,200-title scan, sorting, pagination, cache and Stop. No paid AI tests were run.

The earlier subtitle color/brightness overrides remain reverted after the PGS placement regression; this backend change does not alter playback or subtitle behavior.
