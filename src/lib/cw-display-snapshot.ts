import { CW_FINISHED_RATIO, type LibraryItem } from "@/lib/stremio";

// Only verified display decisions are persisted. Never cache a grouped card's
// ownership, provider playback IDs, dismissals, or arbitrary metadata here.
const VERSION = 1;
const STORAGE_PREFIX = "harbor:cw:validated-display:v1:";
const ADVANCE_TTL_MS = 30 * 60_000;
const REMOVE_TTL_MS = 2 * 60_000;
const EXTRA_TTL_MS = 2 * 60_000;
const MAX_ITEMS = 150;

type DisplayState = {
  season: number;
  episode: number;
  videoId: string;
  upNext: boolean;
  waitingForAir: boolean;
  nextAirDate: string | null;
  providerMapping?: { imdbSeason: number; imdbEpisode: number };
};

type SavedDecision = {
  id: string;
  fingerprint: string;
  kind: "advance" | "remove";
  display?: DisplayState;
  // Preserve the original proof time when a partial row carries the decision.
  verifiedAt?: number;
};

type SavedExtra = {
  id: string;
  fingerprint: string;
  display: DisplayState;
};

type SavedSnapshot = {
  version: number;
  owner: string;
  savedAt: number;
  decisions: SavedDecision[];
  visibleCohort: string;
  extras: SavedExtra[];
};

export type CwRestoredDisplay = {
  advanced: Map<string, LibraryItem>;
  removed: Set<string>;
  extra: LibraryItem[];
};

type Store = Pick<Storage, "getItem" | "setItem">;

function canCacheDisplay(item: LibraryItem): boolean {
  if (item.type !== "series") return true;
  const offset = item.state?.timeOffset ?? 0;
  const duration = item.state?.duration ?? 0;
  // A paused episode needs current watched-state evidence before it can advance
  // or disappear. A snapshot only fingerprints the pause itself.
  return offset <= 0 || (duration > 0 && offset / duration >= CW_FINISHED_RATIO);
}

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Never write auth tokens or API keys into storage keys. This fingerprint is
 * an invalidation identifier, not an authentication or encryption mechanism.
 * Two independent 64-bit FNV-1a streams make accidental collisions unlikely.
 */
export function cwDisplayOwnerKey(parts: readonly unknown[]): string {
  let source: string;
  try {
    source = JSON.stringify(parts) ?? "";
  } catch {
    return "";
  }
  const mask = 0xffff_ffff_ffff_ffffn;
  const prime = 0x100000001b3n;
  let a = 0xcbf29ce484222325n;
  let b = 0x84222325cbf29ce4n;
  for (let i = 0; i < source.length; i++) {
    const point = BigInt(source.charCodeAt(i));
    a = ((a ^ point) * prime) & mask;
    b = ((b ^ point) * (prime + 2n)) & mask;
  }
  return [a, b].map((value) => value.toString(16).padStart(16, "0")).join("");
}

/**
 * Reuse only when the *source* checkpoint is identical. A newer played
 * episode, provider ID, or stored progress invalidates the old presentation.
 * Members are included to avoid replaying a merged/dismissible card against
 * a different set of source records.
 */
export function cwDisplayInputFingerprint(item: LibraryItem): string {
  const state = item.state;
  return cwDisplayOwnerKey([
    item._id,
    item.type,
    item.external ?? null,
    item.local ?? false,
    item.manualWatched ?? false,
    item.isAnime ?? false,
    item.upNext ?? false,
    item.caughtUp ?? false,
    item.waitingForAir ?? false,
    item.nextAirDate ?? null,
    item.removed ?? false,
    item.temp ?? false,
    item._mtime ?? null,
    item._ctime ?? null,
    state?.season ?? null,
    state?.episode ?? null,
    state?.video_id ?? null,
    state?.timeOffset ?? null,
    state?.duration ?? null,
    state?.lastWatched ?? null,
    state?.flaggedWatched ?? null,
    [...(item.altIds ?? [])].sort(),
    item.providerPlaybackIds ?? null,
    (item.cwMembers ?? []).map((member) => [
      member._id,
      member.external ?? null,
      member.state?.season ?? null,
      member.state?.episode ?? null,
      member.state?.video_id ?? null,
      member.state?.timeOffset ?? null,
      member.state?.lastWatched ?? null,
    ]),
  ]);
}

function cwVisibleCohort(items: readonly LibraryItem[]): string {
  return cwDisplayOwnerKey(items.map((item) => cwDisplayInputFingerprint(item)).sort());
}

function validDisplay(display: DisplayState | undefined): display is DisplayState {
  return !!(
    display &&
    Number.isInteger(display.season) &&
    display.season >= 0 &&
    Number.isInteger(display.episode) &&
    display.episode >= 0 &&
    typeof display.videoId === "string" &&
    typeof display.upNext === "boolean" &&
    typeof display.waitingForAir === "boolean" &&
    (!display.waitingForAir ||
      (typeof display.nextAirDate === "string" && display.nextAirDate.length > 0)) &&
    (display.nextAirDate === null || typeof display.nextAirDate === "string") &&
    (display.providerMapping === undefined ||
      (Number.isInteger(display.providerMapping.imdbSeason) &&
        display.providerMapping.imdbSeason >= 1 &&
        Number.isInteger(display.providerMapping.imdbEpisode) &&
        display.providerMapping.imdbEpisode >= 1))
  );
}

/** A disk snapshot may change appearance, never the record to dismiss. */
function applyDisplay(item: LibraryItem, display: DisplayState): LibraryItem {
  if (!item.state) return item;
  return {
    ...item,
    state: {
      ...item.state,
      season: display.season,
      episode: display.episode,
      video_id: display.videoId,
      timeOffset: 0,
      flaggedWatched: 0,
    },
    upNext: display.upNext,
    cwVerifiedProviderMapping: display.providerMapping,
    waitingForAir: display.waitingForAir || undefined,
    nextAirDate: display.nextAirDate ?? undefined,
  };
}

export function saveCwDisplaySnapshot(
  owner: string,
  items: readonly LibraryItem[],
  advanced: ReadonlyMap<string, LibraryItem>,
  removed: ReadonlySet<string>,
  options: {
    store?: Store | null;
    now?: number;
    library?: readonly LibraryItem[];
    extra?: readonly LibraryItem[];
    // A failed metadata lookup is not proof that the previous display is wrong.
    unresolvedIds?: ReadonlySet<string>;
  } = {},
): void {
  const store = options.store === undefined ? storage() : options.store;
  // Initial hydration often runs a valid but empty pass before the library or
  // external providers arrive. Do not erase the last verified presentation.
  if (!store || !owner || items.length > MAX_ITEMS) return;
  if (items.length === 0 && !options.library?.length) return;
  const decisions: SavedDecision[] = [];
  for (const item of items) {
    if (!canCacheDisplay(item)) continue;
    const fingerprint = cwDisplayInputFingerprint(item);
    if (removed.has(item._id)) {
      decisions.push({ id: item._id, fingerprint, kind: "remove" });
      continue;
    }
    const output = advanced.get(item._id);
    if (
      !output?.state ||
      output.state.video_id == null ||
      output.upNext !== true ||
      output.state.timeOffset !== 0
    )
      continue;
    const { season, episode, video_id } = output.state;
    if (!Number.isInteger(season) || !Number.isInteger(episode) || season! < 0 || episode! < 0)
      continue;
    // A timer without a verified air date is not a display decision.
    if (output.waitingForAir === true && !output.nextAirDate) continue;
    decisions.push({
      id: item._id,
      fingerprint,
      kind: "advance",
      display: {
        season: season!,
        episode: episode!,
        videoId: video_id,
        upNext: output.upNext === true,
        waitingForAir: output.waitingForAir === true,
        nextAirDate: output.nextAirDate ?? null,
        providerMapping: output.cwVerifiedProviderMapping,
      },
    });
  }
  const now = options.now ?? Date.now();
  // A partial hydration pass can arrive before Simkl (or another source).
  // Carry only decisions for absent/unresolved inputs, never those already
  // reconsidered successfully by the live worker. Keep their original proof
  // timestamp so repeated partial passes cannot extend the validity window.
  try {
    const json = store.getItem(STORAGE_PREFIX + owner);
    if (json) {
      const previous = JSON.parse(json) as SavedSnapshot;
      if (
        previous.version === VERSION &&
        previous.owner === owner &&
        Number.isFinite(previous.savedAt) &&
        previous.savedAt <= now &&
        Array.isArray(previous.decisions)
      ) {
        const present = new Map(items.map((item) => [item._id, item]));
        const retained = new Set(decisions.map((decision) => decision.id));
        for (const decision of previous.decisions.slice(0, MAX_ITEMS)) {
          if (decisions.length >= MAX_ITEMS) break;
          if (!decision || typeof decision.id !== "string" || retained.has(decision.id)) continue;
          const input = present.get(decision.id);
          if (input && (!canCacheDisplay(input) || !options.unresolvedIds?.has(decision.id)))
            continue;
          if (
            decision.kind !== "remove" &&
            (decision.kind !== "advance" || !validDisplay(decision.display))
          )
            continue;
          const verifiedAt = decision.verifiedAt ?? previous.savedAt;
          const ttl = decision.kind === "remove" ? REMOVE_TTL_MS : ADVANCE_TTL_MS;
          if (!Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > ttl) continue;
          decisions.push({ ...decision, verifiedAt });
          retained.add(decision.id);
        }
      }
    }
  } catch {
    // Corrupt/legacy storage must never prevent the live display from saving.
  }
  const extras: SavedExtra[] = [];
  if (options.extra?.length && options.library?.length) {
    const present = new Set(items.map((item) => item._id));
    const byId = new Map(options.library.map((item) => [item._id, item]));
    for (const output of options.extra.slice(0, MAX_ITEMS)) {
      const source = byId.get(output._id);
      if (
        !source?.state ||
        !canCacheDisplay(source) ||
        present.has(output._id) ||
        output.upNext !== true
      )
        continue;
      if (!output.state || output.state.timeOffset !== 0 || output.waitingForAir) continue;
      const season = output.state.season;
      const episode = output.state.episode;
      if (!Number.isInteger(season) || !Number.isInteger(episode) || season! < 0 || episode! < 0)
        continue;
      // Only exact, already-aired resurface coordinates; timers are not cached.
      if (output.state.video_id !== output._id + ":" + season + ":" + episode) continue;
      const aired = output.nextAirDate ? Date.parse(output.nextAirDate) : NaN;
      if (Number.isFinite(aired) && aired > now) continue;
      extras.push({
        id: output._id,
        fingerprint: cwDisplayInputFingerprint(source),
        display: {
          season: season!,
          episode: episode!,
          videoId: output.state.video_id,
          upNext: true,
          waitingForAir: false,
          nextAirDate: output.nextAirDate ?? null,
        },
      });
    }
  }
  const snapshot: SavedSnapshot = {
    version: VERSION,
    owner,
    savedAt: now,
    decisions,
    visibleCohort: cwVisibleCohort(items),
    extras,
  };
  try {
    store.setItem(STORAGE_PREFIX + owner, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded, private mode, or unavailable storage: live CW still works.
  }
}

export function restoreCwDisplaySnapshot(
  owner: string,
  items: readonly LibraryItem[],
  options: { store?: Store | null; now?: number; library?: readonly LibraryItem[] } = {},
): CwRestoredDisplay {
  const result: CwRestoredDisplay = {
    advanced: new Map<string, LibraryItem>(),
    removed: new Set<string>(),
    extra: [],
  };
  const store = options.store === undefined ? storage() : options.store;
  if (!owner || !store || items.length > MAX_ITEMS) return result;
  try {
    const json = store.getItem(STORAGE_PREFIX + owner);
    if (!json) return result;
    const saved = JSON.parse(json) as SavedSnapshot;
    const now = options.now ?? Date.now();
    if (
      saved.version !== VERSION ||
      saved.owner !== owner ||
      !Number.isFinite(saved.savedAt) ||
      saved.savedAt > now ||
      now - saved.savedAt > ADVANCE_TTL_MS ||
      !Array.isArray(saved.decisions) ||
      saved.decisions.length > MAX_ITEMS
    )
      return result;
    const eligible = new Map(items.map((item) => [item._id, item]));
    for (const decision of saved.decisions) {
      if (
        typeof decision?.id !== "string" ||
        typeof decision.fingerprint !== "string" ||
        (decision.kind !== "advance" && decision.kind !== "remove")
      )
        continue;
      const input = eligible.get(decision.id);
      if (
        !input?.state ||
        !canCacheDisplay(input) ||
        cwDisplayInputFingerprint(input) !== decision.fingerprint
      )
        continue;
      if (decision.kind === "remove") {
        const verifiedAt = decision.verifiedAt ?? saved.savedAt;
        if (Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= REMOVE_TTL_MS) {
          result.removed.add(decision.id);
        }
      } else if (validDisplay(decision.display)) {
        const verifiedAt = decision.verifiedAt ?? saved.savedAt;
        if (
          Number.isFinite(verifiedAt) &&
          verifiedAt <= now &&
          now - verifiedAt <= ADVANCE_TTL_MS
        ) {
          result.advanced.set(decision.id, applyDisplay(input, decision.display));
        }
      }
    }
    // Resurfaced cards are a provisional display only. New provider/alias
    // records or a changed playback checkpoint invalidate the cached cohort.
    if (
      options.library &&
      now - saved.savedAt <= EXTRA_TTL_MS &&
      saved.visibleCohort === cwVisibleCohort(items) &&
      Array.isArray(saved.extras) &&
      saved.extras.length <= MAX_ITEMS
    ) {
      const byId = new Map(options.library.map((item) => [item._id, item]));
      for (const extra of saved.extras) {
        if (typeof extra?.id !== "string" || typeof extra.fingerprint !== "string") continue;
        if (eligible.has(extra.id) || !validDisplay(extra.display)) continue;
        const input = byId.get(extra.id);
        if (
          !input?.state ||
          !canCacheDisplay(input) ||
          cwDisplayInputFingerprint(input) !== extra.fingerprint
        )
          continue;
        if (extra.display.waitingForAir) continue;
        const date = extra.display.nextAirDate ? Date.parse(extra.display.nextAirDate) : NaN;
        if (Number.isFinite(date) && date > now) continue;
        result.extra.push(applyDisplay(input, extra.display));
      }
    }
  } catch {
    // Malformed or unsupported cache must not block normal CW rendering.
  }
  return result;
}
