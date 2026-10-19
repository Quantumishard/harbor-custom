HDR Toys subtitle-white correction

Keeps HDR Toys enabled for PQ HDR material while restoring native text-subtitle white. The pack deliberately retains PQ target metadata while its OUTPUT shaders emit SDR, so mpv's default PQ subtitle white appeared grey (148/255 in a synthetic GPU render). Scoped sub-hdr-peak=10000 restores SDR code white (255/255) for this pipeline; it does not request a 10,000-nit SDR display.

HDR Toys now bypasses SDR, HLG, and unprobed sources because the installed pack uses the PQ inverse transfer function. Disabling the pack or switching to SDR restores the exact mpv property values captured before activation. Native and forwarded playback use serialized property writes to prevent delayed enables from overtaking disables. Subtitle positioning, ASS style overrides and image-subtitle settings are not modified.

Verified with bundled mpv v0.41 GPU rendering, shader/restore/race tests, PGS compatibility tests, targeted lint and TypeScript checks. The actual playback scene still needs user confirmation. Fully quit Harbor, extract the complete portable ZIP into a fresh folder and run harbor.exe. Enable HDR Toys in Shaders and leave built-in HDR-to-SDR and RTX HDR off. No mpv.conf change is required; the existing blend-subtitles=no can remain.
