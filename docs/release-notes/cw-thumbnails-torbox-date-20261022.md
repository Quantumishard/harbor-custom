Harbor Custom 1.0.1 Beta — Continue Watching and TorBox fixes

This Windows x64 portable update remains synchronized with upstream v1.0.1-beta and retains the existing custom HDR Toys, subtitle, search, local catalog and episode-rating changes.

- Continue Watching captured frames now recover space from disposable caches when browser storage is full. A failed replacement keeps the previous frame.
- Captures remain accessible under both the original title ID and its canonical IMDb ID, including after restarting Harbor. The newest matching frame takes priority.
- A native capture that completes just after the exit timeout is still saved. A late capture cannot overwrite the next episode's image.
- The TorBox cloud page has a **Date added** selector: **Newest first** (default) or **Oldest first**. All completed torrents, Usenet and web downloads are sorted together by their creation time, across fetched pages. Missing or invalid dates appear last. The selected order is remembered locally.

Fully quit Harbor, including its tray instance. Extract the entire ZIP into a new folder and run `harbor.exe`; keep all included files together. Existing Harbor settings remain in AppData. Windows WebView2 is required.

Validation: 68 targeted regression tests passed, along with the TypeScript and changed-file formatting/lint checks. The release package is built on Windows and checked against the current production interface and per-file SHA-256 manifest. Live provider playback and Linux builds are not verified; the broader upstream suite has previously recorded unrelated fixture failures.
