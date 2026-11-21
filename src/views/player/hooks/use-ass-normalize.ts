import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { safeFetch } from "@/lib/safe-fetch";
import { decodeSubtitleBytes } from "@/lib/subtitles/encoding";
import { embeddedSubIndex, resolveReadableUrl } from "@/lib/subtitles/extract";
import { readNonNetworkSubtitleBytes } from "@/lib/subtitles/save-to-disk";
import { assScaleFromFactor, computeAssBaseFactorInfo } from "@/lib/player/ass-header";
import type { TrackInfo } from "@/lib/player/bridge";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The file mpv is actually playing is the best copy: prepared addon subtitles are
 * already a local ASS file, while the provider URL can need headers Harbor does not
 * have here and is another download. */
export function assNormalizeSource(track: TrackInfo): string | null {
  return track.externalFilename ?? track.url ?? null;
}

function isLocalPath(url: string): boolean {
  return (
    /^file:/i.test(url) ||
    /^[a-z]:[\\/]/i.test(url) ||
    url.startsWith("\\\\") ||
    url.startsWith("/")
  );
}

const MPV_ASS_HEADER_PROPERTY = "sub-ass-extradata";
const MPV_HEADER_ATTEMPTS = 3;
const MPV_HEADER_RETRY_MS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * mpv has already parsed the active ASS header (PlayResY and styles), so reading
 * it costs no extra file or network pass. It can be unavailable for a moment
 * while a new subtitle track is initialized, and older libmpv versions do not
 * expose it at all; the caller then falls back to reading the subtitle itself.
 *
 * `sub-ass-extradata` always describes the current primary track, so it is only
 * trustworthy while mpv's `sid` still points at the track being styled.
 */
export function sidMatchesTrack(sid: unknown, trackId: string): boolean {
  if (sid == null || sid === false) return false;
  return String(sid).trim() === trackId.trim();
}

async function readMpvAssHeader(expectedTrackId: string): Promise<string | null> {
  if (!isTauri()) return null;
  for (let attempt = 0; attempt < MPV_HEADER_ATTEMPTS; attempt++) {
    const [raw, sid] = await Promise.all([
      invoke<unknown>("mpv_get_property", { name: MPV_ASS_HEADER_PROPERTY }).catch(() => null),
      invoke<unknown>("mpv_get_property", { name: "sid" }).catch(() => null),
    ]);
    if (sidMatchesTrack(sid, expectedTrackId) && typeof raw === "string" && raw.trim()) {
      return raw;
    }
    if (attempt + 1 < MPV_HEADER_ATTEMPTS) await sleep(MPV_HEADER_RETRY_MS);
  }
  return null;
}

async function loadAssText(
  sourceUrl: string,
  track: TrackInfo,
  tracks: TrackInfo[],
  headers?: Record<string, string>,
): Promise<string | null> {
  if (track.external === true || track.url || track.externalFilename) {
    const raw = assNormalizeSource(track);
    if (!raw) return null;
    if (isLocalPath(raw)) {
      const bytes = await readNonNetworkSubtitleBytes(raw);
      return decodeSubtitleBytes(bytes, {});
    }
    const readable = await resolveReadableUrl(raw);
    if (!readable) return null;
    const res = await safeFetch(readable, { method: "GET" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return decodeSubtitleBytes(new Uint8Array(buf), {});
  }
  if (!isTauri()) return null;
  const streamIndex = embeddedSubIndex(tracks, track.id);
  return invoke<string>("subtitle_extract_ass", {
    source: sourceUrl,
    streamIndex,
    headers: headers ?? null,
  });
}

type AssTextLoader = (
  sourceUrl: string,
  track: TrackInfo,
  tracks: TrackInfo[],
  headers?: Record<string, string>,
) => Promise<string | null>;

export type AssFactorResolution = {
  factor: number;
  /** A header-only style guess that may still change after the full subtitle is read. */
  provisional: boolean;
};

/**
 * Resolves the ASS header factor for the selected track. A prepared external
 * subtitle is read from its local file first because that read is instant and
 * its dialogue events identify the dominant style precisely. Embedded tracks
 * use mpv's parsed header first: extracting the same header again with ffmpeg
 * from a remote video takes seconds, and until it finishes the subtitle is
 * drawn at the fallback size.
 *
 * A header-only style pick that is not a conventional dialogue name is applied
 * immediately as a provisional factor, then checked against the full subtitle's
 * dialogue events so an unusual release can still self-correct.
 */
export async function resolveAssBaseFactor(params: {
  sourceUrl: string | null;
  headers?: Record<string, string>;
  track: TrackInfo | null;
  tracks: TrackInfo[];
  loadText?: AssTextLoader;
  readMpvHeader?: (trackId: string) => Promise<string | null>;
  onProvisional?: (factor: number) => void;
  isCancelled?: () => boolean;
}): Promise<AssFactorResolution | null> {
  const { sourceUrl, headers, track, tracks } = params;
  if (!sourceUrl || !track) return null;
  const loadText = params.loadText ?? loadAssText;
  const readMpvHeader = params.readMpvHeader ?? readMpvAssHeader;
  const isCancelled = params.isCancelled ?? (() => false);
  const fromText = async () => {
    try {
      const text = await loadText(sourceUrl, track, tracks, headers);
      return text ? computeAssBaseFactorInfo(text) : null;
    } catch {
      // A missing prepared file or a failed extraction must not hide a header
      // mpv has already parsed.
      return null;
    }
  };

  const source = assNormalizeSource(track);
  const localExternal = track.external === true && source != null && isLocalPath(source);
  if (localExternal) {
    const exact = await fromText();
    if (exact) return { factor: exact.factor, provisional: false };
  }
  if (isCancelled()) return null;

  const header = await readMpvHeader(track.id);
  if (header) {
    const info = computeAssBaseFactorInfo(header);
    if (info) {
      if (!localExternal && !info.confident) {
        params.onProvisional?.(info.factor);
        const exact = await fromText();
        if (isCancelled()) return null;
        if (exact) return { factor: exact.factor, provisional: false };
        return { factor: info.factor, provisional: true };
      }
      return { factor: info.factor, provisional: !info.confident };
    }
  }
  if (localExternal) return null;
  if (isCancelled()) return null;
  const exact = await fromText();
  return exact ? { factor: exact.factor, provisional: false } : null;
}

export function useAssNormalize(params: {
  enabled: boolean;
  sourceUrl: string | null;
  headers?: Record<string, string>;
  track: TrackInfo | null;
  tracks: TrackInfo[];
  targetFontSize: number;
}): number | undefined {
  const { enabled, sourceUrl, headers, track, tracks, targetFontSize } = params;
  const cacheRef = useRef<Map<string, number>>(new Map());
  const liveRef = useRef({ sourceUrl, track, tracks, headers });
  liveRef.current = { sourceUrl, track, tracks, headers };
  const [factor, setFactor] = useState<number | null>(null);
  const key =
    enabled && sourceUrl && track
      ? `${sourceUrl}|${track.id}|${track.external ? 1 : 0}|${assNormalizeSource(track) ?? ""}`
      : "";

  useEffect(() => {
    if (!key) {
      setFactor(null);
      return;
    }
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      setFactor(cached);
      return;
    }
    setFactor(null);
    let cancelled = false;
    void (async () => {
      const live = liveRef.current;
      let result: AssFactorResolution | null = null;
      try {
        result = await resolveAssBaseFactor({
          sourceUrl: live.sourceUrl,
          headers: live.headers,
          track: live.track,
          tracks: live.tracks,
          isCancelled: () => cancelled,
          onProvisional: (factor) => {
            if (!cancelled) setFactor(factor);
          },
        });
      } catch {
        result = null;
      }
      if (cancelled) return;
      // A failed read can be transient (a slow stream, a restart), so only a
      // proven factor is cached and the next attempt can still resolve it.
      if (result != null && !result.provisional) cacheRef.current.set(key, result.factor);
      if (result == null) {
        console.warn(
          "[subtitle-style] could not resolve the ASS header; sizing falls back to a plain scale",
        );
      }
      setFactor(result?.factor ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return factor == null ? undefined : assScaleFromFactor(factor, targetFontSize);
}
