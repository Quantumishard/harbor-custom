# Harbor Custom synchronized with v1.0.1-beta

Upstream: Harborofficial/Harbor tag `v1.0.1-beta`, commit `d862943d` (October 21, 2026).
Previous custom source: `de5a4233`, including the October 19 community backend and HDR Toys corrections.

This merge retains the personal subtitle/original-audio policies, Continue Watching duplicate dismissal and Clear All, fresh bookmark-state safeguards, HDR Toys PQ-only activation and SDR handoff, cached episode ratings and recovery, remembered navigation/search position, local catalogs, TorBox cloud library, TMDB-only catalog filtering, and 60-second search deadlines with the 100-result AIOMetadata allowance. Upstream chapter controls, season explorer, Nuvio account support, player recovery/continuation and Anime4K ordering are integrated rather than replaced by the old implementations.

The original snapshot recorded CRLF files without its prior Git history. A local temporary ancestry mapping to its verified upstream base `cd89561e` allowed a three-way merge; this release commit has the actual custom head and upstream release as its two parents. The mapping is not published. Source-only formatting differences are not custom behavior changes.

Verification:

- TypeScript check passed.
- Native Rust check passed.
- Production interface build passed (existing missing-artwork, chunk-size and mixed-import warnings remain).
- 131 targeted custom regression checks passed, including two explicit unreadable-bookmark-state cases. The final dismissal/cache reruns passed.
- Custom-file formatting and lint checks completed without errors; three existing warnings remain in unrelated retained custom code.
- The broad test run is not clean. All 11 failures in the ContinueCard dismissal/interaction fixtures also reproduce in the untouched upstream tag: missing fixture dependencies and existing persistence assertions. They are not reported as passing.
- Linux packaging is not verified on this Windows host.

Windows verification completed: the native release build passed, the rebuilt extension runtime answered its protocol ping, all 571 bundled JavaScript/CSS/HTML assets match the executable, and all 395 archived runtime files passed SHA-256 verification. The package is published as [custom-v1.0.1-beta-20261021](https://github.com/Quantumishard/harbor-custom/releases/tag/custom-v1.0.1-beta-20261021), with checksums and verification reports. Existing app data and the October 19 release are preserved.

Compiled application source: `ce297b118f2188f808ec8c56f1f31b046299de0e`. The release tag also includes the documentation and regression-fixture follow-up; application source is unchanged from that build commit. Repository-wide formatting is not clean (the untouched upstream tag also reports 4,794 formatting issues); unrelated files were not reformatted.
