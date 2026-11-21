import {
  activateMusicVideo,
  getMusicState,
  isMusicVideoActive,
  subscribeMusic,
  waitForMusicAudioReady,
} from "./player";
import {
  musicVideoStream,
  musicVideoStreamKey,
  prefetchMusicVideoStreams,
  setMusicVideoTargetResolver,
} from "./video";
import { primeMusicVideoHostPosition, releaseMusicVideoHostSource } from "./video-host";
import { createMusicVideoSurfaces, type HoldVideo } from "./video-surfaces";
import { searchMusicVideoPage } from "./video-pages";
import { clearMusicVideoSessionQuality } from "./video-quality";
import type { MusicTrack } from "./types";

/**
 * A queued song's own id is an audio upload; its "video" is a square art track. Video mode
 * resolves the official video for it instead, warmed while the previous song plays.
 */
setMusicVideoTargetResolver(async (track) => {
  // A result from the video list is already the video. Anything else that reaches a surface
  // as a video, including queues restored from before this lookup existed, is a song.
  if (track.videoSearch === false || track.connectorId !== "youtube") return null;
  // Bare "artist title" makes the provider answer with other songs by the act; naming the
  // kind of upload is what puts the official video first.
  const page = await searchMusicVideoPage(
    `${track.artist} ${track.title} music video`,
    false,
  ).catch(() => null);
  const fold = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const song = fold(track.title).split(" ").filter(Boolean);
  const isSong = (candidate: MusicTrack) => {
    const words = new Set(fold(candidate.title).split(" ").filter(Boolean));
    return song.length > 0 && song.every((word) => words.has(word));
  };
  const pick = page?.tracks.find(
    (candidate) => candidate.sourceId && candidate.sourceId !== track.sourceId && isSong(candidate),
  );
  const id = pick?.sourceId;
  return id ? { ...track, id, sourceId: id } : null;
});

/**
 * Leaving the watch page unmounts every surface, but the picture is a parked media element
 * rather than anything a screen owns, so the song simply keeps playing. Nothing bounds the gap:
 * the session ends when the music player stops treating this video as what is playing, which is
 * the only moment the picture has stopped being the thing the listener is hearing.
 */
const holdMusicVideo: HoldVideo = (release) => {
  const unsubscribe = subscribeMusic(() => {
    if (!isMusicVideoActive()) release();
  });
  if (!isMusicVideoActive()) release();
  return unsubscribe;
};

/** A picture the native side can resolve on its own. A catalog id has no provider to ask. */
function resolvableVideo(track: MusicTrack | null | undefined): track is MusicTrack {
  if (!track?.connectorId || track.connectorId === "catalog") return false;
  // YouTube audio tracks still have a video behind them, so warming those too makes opening the
  // picture pane a cache hit instead of another extractor run.
  return track.connectorId === "youtube"
    ? !!track.sourceId || !!track.id
    : track.mediaKind === "video";
}

/**
 * Resolution runs yt-dlp and costs seconds, and the song is audible for every one of them
 * because the engine loads with no pause set. Starting it when the track becomes current puts
 * the whole resolve alongside the audio load: playMusic publishes the new track before it
 * loads anything, so by the time a surface asks for the stream it is usually already cached.
 */
let warmedKey = "";
let warmedTrackKey = "";
function warmMusicVideoStream(track: MusicTrack | null | undefined): void {
  if (!resolvableVideo(track)) return;
  const key = musicVideoStreamKey(track);
  if (key === warmedKey) return;
  warmedKey = key;
  void musicVideoStream(track).catch(() => {});
}

/** Warm the videos behind the next songs while the current one plays. */
function warmQueuedVideos(): void {
  const state = getMusicState();
  const next = state.queue
    .slice(state.queueIndex + 1, state.queueIndex + 3)
    .filter((track) => track.mediaKind === "video");
  if (next.length > 0) prefetchMusicVideoStreams(next, next.length);
}

subscribeMusic(() => {
  const state = getMusicState();
  const key = state.current ? `${state.current.connectorId}:${state.current.id}` : "";
  if (key !== warmedTrackKey) {
    warmedTrackKey = key;
    // A quality chosen for one video lasts only for that video.
    clearMusicVideoSessionQuality();
  }
  warmMusicVideoStream(state.current);
  warmQueuedVideos();
});

export const musicVideoSurfaces = createMusicVideoSurfaces(async (track, signal) => {
  let controls: Awaited<ReturnType<typeof activateMusicVideo>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      releaseMusicVideoHostSource(musicVideoStreamKey(track));
      await controls?.release();
    })();
    return closing;
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    await close();
    return;
  }
  try {
    const primed = waitForMusicAudioReady(track);
    await musicVideoStream(track);
    if (signal.aborted) return;
    if (!(await primed)) throw new Error("Music source did not become ready");
    if (signal.aborted) return;
    controls = await activateMusicVideo(track.id);
    primeMusicVideoHostPosition(musicVideoStreamKey(track), controls.position);
    if (signal.aborted) await close();
  } catch (error) {
    await close();
    throw error;
  }
}, holdMusicVideo);
