import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { t } from "@/lib/i18n";
import { makeSafeTauriUnlisten } from "@/lib/tauri-unlisten";
import {
  initialPlayerSnapshot,
  type PlayerBridge,
  type PlayerCapabilities,
  type PlayerSnapshot,
  type PlayerSource,
} from "./bridge";

/** This tells Harbor when mpv has closed, so it leaves the player screen. */
export const EXTERNAL_PLAYER_CLOSED_EVENT = "harbor:external-player-closed";

/** How much time in "ms" Harbor has to start the next episode or go back to the title screen after mpv finishes. */
const LEAVE_AFTER_END_MS = 2000;

/** If mpv closes within the last 3 seconds of the playback, it counts as finished. */
const END_SLACK_SEC = 3;

export type ExternalMpvOptions = {
  /** Path to the mpv executable. If left empty then it uses mpv from PATH. */
  binary: string;
  /** Extra command line options for mpv. */
  args: string;
  title: string;
};

type ExternalPlayerState = {
  session: number;
  positionSec: number;
  durationSec: number;
  paused: boolean;
  buffering: boolean;
  loaded: boolean;
  eof: boolean;
  width: number;
  height: number;
  error: string | null;
  launchError: string | null;
};

/** Cuts the mpv options text into separate options at each space, but it keeps text inside quotes together. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/**
 * The bridge for the user's external mpv. Harbor's player screen will stay open in the
 * background, so resume, Stremio sync, watched marking and next episode all keep working.
 */
export function createExternalMpvBridge(opts: ExternalMpvOptions): PlayerBridge {
  let snap: PlayerSnapshot = initialPlayerSnapshot();
  const listeners = new Set<(s: PlayerSnapshot) => void>();
  let host: HTMLElement | null = null;
  let notice: HTMLElement | null = null;
  let session = 0;
  let starting = false;
  // mpv can send updates before we get our ticket number, so we keep them here until it arrives.
  let early: Array<{ exit: boolean; s: ExternalPlayerState }> = [];
  let loadId = 0;
  let destroyed = false;
  let mediaTitle = opts.title;
  let pendingSubs: Array<{ url: string; lang?: string; title?: string }> = [];
  let unlisten: Array<() => void> = [];

  const emit = () => {
    const next: PlayerSnapshot = { ...snap };
    listeners.forEach((l) => l(next));
  };

  const command = (cmd: unknown[]) =>
    session
      ? invoke("external_player_command", { session, cmd })
      : Promise.reject(new Error("external mpv is not running"));

  const flushSubs = () => {
    const subs = pendingSubs;
    pendingSubs = [];
    // "auto" adds Harbor's subtitles to mpv's list without switching to them, so the user's own subtitle choice stays.
    for (const s of subs) {
      void command(["sub-add", s.url, "auto", s.title ?? s.lang ?? "", s.lang ?? ""]).catch(
        () => {},
      );
    }
  };

  const onState = (s: ExternalPlayerState) => {
    if (starting) early.push({ exit: false, s });
    if (s.session !== session) return;
    const wasLoaded = snap.firstFrameReady;
    if (s.error) {
      snap.status = "error";
      snap.errorCode = "source";
      snap.errorMessage = s.error;
    } else if (s.eof) {
      snap.status = "ended";
      if (s.durationSec > 0) s.positionSec = s.durationSec;
    } else if (!s.loaded) {
      snap.status = "loading";
    } else {
      snap.status = s.paused ? "paused" : "playing";
    }
    snap.positionSec = s.positionSec;
    snap.durationSec = s.durationSec;
    snap.buffering = s.buffering;
    snap.firstFrameReady = s.loaded;
    snap.videoWidth = s.width;
    snap.videoHeight = s.height;
    snap.videoSourceWidth = s.width;
    snap.videoSourceHeight = s.height;
    emit();
    if (s.loaded && !wasLoaded) {
      flushSubs();
      if (mediaTitle)
        void command(["set_property", "force-media-title", mediaTitle]).catch(() => {});
    }
  };

  /** When mpv can't start, show the real reason instead of blaming the video source. */
  const failLaunch = (detail: string) => {
    session = 0;
    snap.status = "paused";
    emit();
    void message(detail, { title: t("mpv could not start"), kind: "error" }).catch(() => {});
    window.dispatchEvent(new Event(EXTERNAL_PLAYER_CLOSED_EVENT));
  };

  const onExit = (s: ExternalPlayerState) => {
    if (starting) early.push({ exit: true, s });
    if (s.session !== session) return;
    if (s.launchError) {
      failLaunch(s.launchError);
      return;
    }
    if (snap.status !== "ended") onState(s);
    session = 0;
    if (snap.status === "error") return;
    if (snap.status !== "ended") {
      // mpv reports a real end before it quits. Closing it during the credits is the
      // viewer leaving, that will not start the next episode.
      const atEnd = snap.durationSec > 0 && snap.durationSec - snap.positionSec <= END_SLACK_SEC;
      if (!atEnd) {
        snap.status = "paused";
        emit();
        window.dispatchEvent(new Event(EXTERNAL_PLAYER_CLOSED_EVENT));
        return;
      }
      snap = { ...snap, status: "ended" };
      emit();
    }
    // With mpv gone the player view has nothing left to show. Harbor normally starts the
    // next episode or leaves by itself, but it stays when playback began near the end.
    const finishedLoad = loadId;
    window.setTimeout(() => {
      if (!destroyed && loadId === finishedLoad && session === 0) {
        window.dispatchEvent(new Event(EXTERNAL_PLAYER_CLOSED_EVENT));
      }
    }, LEAVE_AFTER_END_MS);
  };

  const ensureListening = async () => {
    if (unlisten.length) return;
    unlisten = [
      makeSafeTauriUnlisten(
        await listen<ExternalPlayerState>("external-player://state", (e) => onState(e.payload)),
      ),
      makeSafeTauriUnlisten(
        await listen<ExternalPlayerState>("external-player://exit", (e) => onExit(e.payload)),
      ),
    ];
    if (destroyed) unlisten.forEach((u) => u());
  };

  const renderNotice = () => {
    if (!host || notice) return;
    notice = document.createElement("div");
    notice.className =
      "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center text-white/80";
    const title = document.createElement("p");
    title.className = "text-[20px] font-semibold";
    title.textContent = t("Playing in your mpv");
    const sub = document.createElement("p");
    sub.className = "max-w-[48ch] text-[15px] text-white/60";
    sub.textContent = t(
      "Harbor keeps your progress in sync while it plays. Close mpv to come back here.",
    );
    notice.append(title, sub);
    host.appendChild(notice);
  };

  return {
    attach(h) {
      host = h;
      renderNotice();
    },
    detach() {
      notice?.remove();
      notice = null;
      host = null;
    },
    async load(src: PlayerSource) {
      const myLoad = ++loadId;
      mediaTitle = src.title ?? mediaTitle;
      session = 0;
      pendingSubs = (src.subtitles ?? [])
        .filter((s) => /^https?:\/\//i.test(s.url))
        .map((s) => ({ url: s.url, lang: s.lang }));
      snap = {
        ...snap,
        status: "loading",
        positionSec: 0,
        durationSec: 0,
        bufferedSec: 0,
        buffering: false,
        firstFrameReady: false,
        videoWidth: 0,
        videoHeight: 0,
        videoSourceWidth: 0,
        videoSourceHeight: 0,
        errorCode: null,
        errorMessage: null,
      };
      emit();
      try {
        await ensureListening();
        starting = true;
        early = [];
        const id = await invoke<number>("external_player_start", {
          args: {
            url: src.url,
            binary: opts.binary,
            startAtSec: src.startAtSec ?? null,
            startPaused: src.startPaused === true,
            title: mediaTitle,
            headers: src.headers ?? null,
            extraArgs: splitArgs(opts.args),
          },
        });
        if (destroyed || myLoad !== loadId) {
          void invoke("external_player_stop", { session: id }).catch(() => {});
          return;
        }
        session = id;
        starting = false;
        const replay = early.filter((e) => e.s.session === id);
        early = [];
        for (const e of replay) {
          if (e.exit) onExit(e.s);
          else onState(e.s);
        }
      } catch (e) {
        starting = false;
        early = [];
        if (myLoad !== loadId) return;
        failLaunch(e instanceof Error ? e.message : String(e));
      }
    },
    async play() {
      await command(["set_property", "pause", false]).catch(() => {});
    },
    pause() {
      void command(["set_property", "pause", true]).catch(() => {});
    },
    seek(sec) {
      void command(["seek", sec, "absolute"]).catch(() => {});
    },
    // Harbor doesn't change volume, tracks or picture, because the user's own mpv
    // settings and keys control them.
    setVolume() {},
    setMuted() {},
    setRate() {},
    setAudioTrack() {},
    setSubtitleTrack() {},
    setSecondarySubtitleTrack() {},
    setSubVisible() {},
    setSubDelay() {},
    setAudioDelay() {},
    setPanscan() {},
    setVideoZoom() {},
    setAspectOverride() {},
    setStretch() {},
    setVideoEq() {},
    setAnime4kShaders() {},
    async addSubtitle(url, lang, title) {
      if (!/^https?:\/\//i.test(url)) return false;
      pendingSubs.push({ url, lang, title });
      if (snap.firstFrameReady) flushSubs();
      return true;
    },
    getSelectedTrackCues: () => null,
    getSelectedTrackUrl: () => null,
    setAudioNormalize() {},
    setMediaInfo(info) {
      mediaTitle = info.title;
      if (snap.firstFrameReady) {
        void command(["set_property", "force-media-title", mediaTitle]).catch(() => {});
      }
    },
    async screenshot() {
      return { ok: false, error: "Take screenshots from your mpv window." };
    },
    setAbLoop() {},
    async requestPiP() {},
    async exitPiP() {},
    async requestFullscreen() {},
    async exitFullscreen() {},
    capabilities(): PlayerCapabilities {
      return {
        engine: "html5",
        external: true,
        pictureInPicture: false,
        airplay: false,
        chromecast: false,
        hdrPassthrough: false,
        hardwareDecode: true,
      };
    },
    subscribe(l) {
      listeners.add(l);
      l({ ...snap });
      return () => {
        listeners.delete(l);
      };
    },
    destroy() {
      // Only close our own mpv, because a newer player may have started a new one. If mpv
      // is still starting we don't have its ticket number yet, so load closes it once the
      // number arrives.
      const running = session;
      destroyed = true;
      loadId += 1;
      session = 0;
      listeners.clear();
      unlisten.forEach((u) => u());
      unlisten = [];
      notice?.remove();
      notice = null;
      host = null;
      if (running) void invoke("external_player_stop", { session: running }).catch(() => {});
    },
  };
}
