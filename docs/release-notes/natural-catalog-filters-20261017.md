# Harbor: natural-language catalog filters and subtitle color

Extract the entire portable ZIP into a new folder, close other Harbor copies, and run **harbor.exe**. Keep its bundled files together. It uses your existing Harbor settings and profiles.

## Catalog filters

1. Open **Catalogs** and choose **View all** on an AIOMetadata catalog, or browse a catalog through Discover.
2. Enter a request in **Filter this catalog** and select **Apply**.
3. Wait for the scan to complete. The explanation shows the interpreted rules, total matches, and titles excluded because required metadata was unavailable.
4. Use **Clear** to return to ordinary browsing. The existing genre selector can narrow the selected catalog before applying a natural-language filter.

Examples:

- `Movies since 2020, rated at least 7, most IMDb votes first`
- `Documentaries under 100 minutes, newest first`
- `True crime documentaries since 2023, most IMDb votes first`
- `English-language movies from the 1990s, highest IMDb rating first`

The AI interprets the request once. The server checks the selected catalog's pages and applies the rules; it does not generate a list of suggested titles. Existing account-level exclusions remain in effect. Subject requests match literal plot/keyword phrases and synonyms, so their accuracy depends on the source metadata.

Supported rules: release-year bounds, minimum IMDb rating/votes, runtime bounds in minutes, required/excluded genres, original languages, movie/series types, subject phrases/exclusions, and catalog/vote/rating/release-date sorting. Requests requiring unsupported data may be rejected. A Gemini API key in AIOMetadata is required for interpretation.

Large catalogs can take several minutes on the first scan. Existing provider and metadata caches are reused. Completed filter results are held in server memory for 30 minutes after their last use; restarting the server clears them. Reapply an expired filter. Scans reaching 5,000 pages, 100,000 titles, or 30 minutes fail instead of claiming partial results are complete. There are at most 12 retained filter jobs. Cancelling in Harbor stops waiting; an already-started server scan can finish and cache its results.

## Subtitle color

Styled text subtitles now use the selected text color and opacity by default, including opaque white, while retaining their file's fonts and layout. HDR subtitle reference brightness is set to 300 nits. Disable **Settings → Player → Styled (ASS) subtitles → Use text color for styled subtitles** to restore original file colors. Inline animation/color commands and image-based subtitles can still retain their authored appearance.

The subtitle property tests passed, including color-channel and transparency conversion, opt-out, layout/scale preservation, and immediate reapplication. Actual playback on your display still needs visual confirmation.

## Verification

- AIOMetadata backend build and isolated filter tests passed, including a complete 60-page/1,200-title scan, global sorting, pagination, cache reuse, account/catalog isolation, and failure handling.
- A live filter on the Western subset of B Horror scanned four titles and returned four matches for a year/rating-sort request; ordinary catalog browsing was unchanged.
- Harbor TypeScript verification and targeted lint checks passed.
- 29 existing catalog/subtitle regression tests passed.
- The broad repository check reports existing formatting issues across thousands of files; unrelated files were left alone.
- Windows package verification details are recorded separately after building. Linux was not built on this Windows host.

The backend update is deployed. Personal account data and API keys are not included in this package or the accompanying change patches.
