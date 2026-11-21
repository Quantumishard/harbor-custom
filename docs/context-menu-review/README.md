# Context-menu browser examples

These are **after** examples from the 0.9.132 integration based on official
`3483ce88ed241a64d4e6d1dc6ebcee066196c85f`, captured at 1280 × 800 with the
default theme and scale. They are new captures, not earlier 0.9.127 evidence.

The browser used a fresh disposable guest context without imported accounts,
cookies or HARBOX data. Collection/list names, playback entries and viewer
artwork are synthetic. Catalog posters are public application content.

| Example                                        | What it shows                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Memberships](memberships-browser.png)         | Separate checked List and Collection destinations, designated collection artwork and a persistent open picker. |
| [Continue Watching](continue-card-browser.png) | Separate global continuation and clicked-card continuation/source/removal commands.                            |
| [Image viewer](image-viewer-browser.png)       | The selected 800 × 1200 synthetic artwork and image controls.                                                  |

Keyboard invocation, submenu scrolling, membership persistence after reload,
creation cancellation, distinct continuation identities and menu/viewer Escape
layering were exercised in the browser. Context-menu mouse events were
dispatched to actual application elements; real Shift+F10 and keyboard input
were also used. This is not native mouse, clipboard, filesystem, editing or
Tauri playback verification.

The captures establish appearance only. They span the interaction verification;
the subsequent Back-alias correction changes keyboard handling, not the pictured
markup. An opening-animation sample was observed, but no interaction recording
or comparable clean-official screenshot was obtained before host memory pressure
required stopping the browser and preview servers. Do not infer motion quality,
native parity, RTL, reduced-motion or performance results from these images.
