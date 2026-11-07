# HDR Toys: consistent subtitle white without frame blending

PGS subtitles could look grey during playback and white while paused. Native render-pass diagnostics showed image subtitles placed after HDR Toys OUTPUT hooks on fresh frames, but before those hooks on cached paused redraws. Enabling display-synchronized interpolation forced the cached path and restored white, but added rendering work and dropped frames.

HDR Toys now temporarily selects separate subtitle composition (`blend-subtitles=no`) and sets SDR overlay white to PQ code white (`hdr-reference-white=10000`), alongside the existing text subtitle white correction. This is a code-value correction for HDR Toys' PQ-tagged SDR output, not a request for 10,000-nit screen brightness. Both settings are restored to their exact prior values when the pack is disabled or bypassed. SDR, HLG, unknown sources and conflicting HDR conversion modes continue to bypass the pack. The fix does not enable interpolation or change chroma filtering.

The user confirmed white PGS subtitles and the expected HDR picture with interpolation off and the original ewa_lanczossharp chroma filter restored. During a subsequent 20-second live playback interval, video advanced normally and dropped/decoder-dropped/delayed-frame counters did not increase. This does not guarantee zero frame drops on every source or machine. Tests cover exact restoration, source/conflict bypass and cancelled player updates.

The known-good external HDR Toys pack and exposure options are preserved. Use this custom executable; official Harbor builds do not include this change. The previous locally saved motion smoothing and bilinear chroma workaround should be removed for this build.
