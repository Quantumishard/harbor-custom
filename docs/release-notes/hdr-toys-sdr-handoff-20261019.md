HDR Toys: prevent grey subtitles after switching films

Fixes HDR Toys output settings surviving in the Windows native player after leaving an HDR film. This could make subtitles grey in the next SDR/1080p film until Harbor restarted. Player sessions that used shaders are now recreated when leaving playback, and pending shader-property updates are cancelled. Sessions without shaders retain the existing player reuse behavior.

Includes the previous HDR Toys white-subtitle correction. Keep HDR Toys enabled; no mpv.conf edits are needed. Subtitle positioning, PGS styling and user preferences are unchanged.

Verified with native GPU renders: stale SDR output reproduced grey at 148/255, while fresh SDR output rendered white at 255/255. Shader restoration/cancellation tests, subtitle compatibility tests, targeted lint, TypeScript checks and the Windows build passed. The user confirmed restarting fixed the symptom; this build's automatic handoff still needs confirmation on their films.

Fully quit Harbor once, extract the complete ZIP into a fresh folder, then run harbor.exe. This release is published only to the personal harbor-custom repository.
