# HDR Toys: consistent compositing at the video frame rate

PGS could look grey during playback and white when paused. In libmpv's gpu-next renderer, fresh and cached paths place source subtitle overlays on opposite sides of OUTPUT shaders. HDR Toys emits SDR while retaining PQ target metadata, so this ordering changes subtitle white. Display-synchronized interpolation forced the cached path but added work at the display refresh rate and caused stutter.

The custom Windows player adds `force-render-cache`. It requests the same source-frame compositing path during play and pause at normal video timing. A no-op hook prevents libplacebo's trivial-frame optimization from bypassing that path; the hook does not produce a shader, texture or modified pixel. Harbor enables the option with `blend-subtitles=yes` only for active PQ HDR Toys playback on Windows. Exact original values restore when the pack is disabled or bypassed. Other platforms retain their existing behavior.

The original five HDR Toys shaders, exposure settings, main/chroma scaling filters, interpolation preference, video timing and subtitle placement are preserved. Existing text-white and HDR-to-SDR handoff fixes remain. Use the complete portable package, including the matching custom libmpv and its dependencies. No global mpv.conf subtitle override is required.

Source tests cover PQ/source/conflict gating, Windows-only activation, exact restoration and delayed-update cancellation. Runtime and fresh-start playback verification are recorded separately. No performance guarantee is made for arbitrary hardware or sources.
