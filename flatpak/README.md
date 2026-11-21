# Flatpak packaging

Harbor is built as `site.harbor.Harbor` against the pinned GNOME 49 SDK. mpv is
built in the sandbox, FFmpeg tools come from the SDK and use the codecs supplied
through the matching platform runtime, and yt-dlp is installed at a digest-pinned
version. No host multimedia tools are visible to the application.

Build locally with the runtimes listed in the manifest installed:

```sh
flatpak-builder --user --force-clean --state-dir=.flatpak-work/state --repo=.flatpak-work/repo .flatpak-work/build flatpak/site.harbor.Harbor.yml
flatpak build-bundle .flatpak-work/repo Harbor.flatpak site.harbor.Harbor
flatpak install --user Harbor.flatpak
```

The package intentionally grants no home or host filesystem access. File and
folder choices are made through the desktop portal. Runtime smoke tests should
cover Wayland and X11, AMD and NVIDIA, WebKit rendering, mpv hardware decode,
FFmpeg casting/transcoding, trailers, torrents, localhost playback, audio, deep
links, tray integration, Discord IPC, and portal-selected media/download paths.

To audit the sandbox, run `flatpak run --command=sh site.harbor.Harbor` and verify
that `/usr/bin/mpv`, `/usr/bin/ffmpeg`, and `/usr/bin/yt-dlp` do not exist; the
packaged commands must resolve under `/app/bin`.

## Updating JavaScript or Rust dependencies

After updating Harbor's version and lockfiles, refresh all Flatpak release
metadata and pinned dependency sources with:

```sh
flatpak/update-flatpak.sh
```

The script uses a pinned revision of
[`flatpak-builder-tools`](https://github.com/flatpak/flatpak-builder-tools).
Set `RELEASE_DATE=YYYY-MM-DD` when preparing a release for a date other than
today. Commit its output before running the Flatpak workflow.

The script also updates the pnpm archive URL and SHA-256 when `packageManager`
changes. Keep `--offline`, `--frozen-lockfile`, and `CARGO_NET_OFFLINE=true`;
removing them would hide a missing generated source until CI or a Flathub build.
