import { useSyncExternalStore } from "react";
import { activeScopedProfileId } from "./active-profile-id";
import { notifyTrackerStatusChanged } from "./tracker-status-events";
import {
  setContextWatchlist,
  type MediaActionResult,
  type UnsafeProviderPolicy,
} from "./media-context-actions";
import { clearWatchlistAggregate, type WatchlistInput } from "./watchlist";
import { isAuthenticated as anilistConnected } from "./anilist/session";
import { resolveAnilistMediaId } from "./anilist/sync";
import {
  deleteListEntry as deleteAnilistEntry,
  fetchListEntry as fetchAnilistEntry,
  saveListEntry as saveAnilistEntry,
} from "./anilist/mutations";
import { isAuthenticated as malConnected } from "./mal/session";
import {
  deleteListEntry as deleteMalEntry,
  fetchListEntry as fetchMalEntry,
  resolveMalMediaId,
  saveListEntry as saveMalEntry,
} from "./mal/mutations";

export type LibraryAddScope = "library" | "all";

export type LibraryActionInput = WatchlistInput & {
  animeId?: string | null;
};

export type LibraryActionResult = MediaActionResult & {
  scope: LibraryAddScope;
};

type ProviderOutcome = MediaActionResult["outcomes"][number];

const SCOPE_PREFIX = "harbor.libraryAddScope.v1.";
const scopeSubs = new Set<() => void>();
let scopeCache: { key: string; value: LibraryAddScope } | null = null;

function scopeKey(): string {
  return SCOPE_PREFIX + activeScopedProfileId();
}

function readScope(): LibraryAddScope {
  try {
    const key = scopeKey();
    if (scopeCache?.key === key) return scopeCache.value;
    const value = localStorage.getItem(key) === "all" ? "all" : "library";
    scopeCache = { key, value };
    return value;
  } catch {
    return "library";
  }
}

function notifyScope(): void {
  for (const listener of scopeSubs) listener();
}

export function subscribeLibraryAddScope(listener: () => void): () => void {
  scopeSubs.add(listener);
  return () => {
    scopeSubs.delete(listener);
  };
}

export function setLibraryAddScope(scope: LibraryAddScope): void {
  try {
    localStorage.setItem(scopeKey(), scope);
    scopeCache = { key: scopeKey(), value: scope };
    notifyScope();
  } catch {
    // A preference write failure should not block the action.
  }
}

export function readLibraryAddScope(): LibraryAddScope {
  return readScope();
}

export function useLibraryAddScope(): LibraryAddScope {
  return useSyncExternalStore(subscribeLibraryAddScope, readScope, () => "library");
}

function isAnimeInput(input: LibraryActionInput): boolean {
  return input.type === "anime" || /^(kitsu|mal|anilist|anidb):/.test(input.animeId ?? input.id);
}

const updated = (provider: string): ProviderOutcome => ({ provider, status: "updated" });

const unchanged = (provider: string, reason: string): ProviderOutcome => ({
  provider,
  status: "unsupported",
  reason,
});

const failed = (provider: string, reason?: string): ProviderOutcome => ({
  provider,
  status: "failed",
  reason,
});

async function additiveAnimeTrackers(
  input: LibraryActionInput,
  on: boolean,
): Promise<ProviderOutcome[]> {
  const id = input.animeId ?? input.id;
  const jobs: Array<Promise<ProviderOutcome>> = [];

  if (anilistConnected()) {
    jobs.push(
      (async () => {
        try {
          const mediaId = await resolveAnilistMediaId(id);
          if (mediaId == null) return unchanged("AniList", "AniList identity unavailable.");
          const info = await fetchAnilistEntry(mediaId, true);
          const entry = info.entry;
          if (on) {
            if (entry) return unchanged("AniList", "AniList already has a status.");
            await saveAnilistEntry({ mediaId, status: "PLANNING" });
            return updated("AniList");
          }
          if (!entry) return unchanged("AniList", "Not on AniList.");
          if (!(await deleteAnilistEntry(entry.id)))
            return failed("AniList", "AniList did not confirm removal.");
          return updated("AniList");
        } catch {
          return failed("AniList");
        }
      })(),
    );
  }

  if (malConnected()) {
    jobs.push(
      (async () => {
        try {
          const malId = await resolveMalMediaId(id);
          if (malId == null) return unchanged("MyAnimeList", "MyAnimeList identity unavailable.");
          const info = await fetchMalEntry(malId, true);
          const entry = info.entry;
          if (on) {
            if (entry) return unchanged("MyAnimeList", "MyAnimeList already has a status.");
            await saveMalEntry({ malId, status: "plan_to_watch" });
            return updated("MyAnimeList");
          }
          if (!entry) return unchanged("MyAnimeList", "Not on MyAnimeList.");
          if (!(await deleteMalEntry(malId)))
            return failed("MyAnimeList", "MyAnimeList did not confirm removal.");
          return updated("MyAnimeList");
        } catch {
          return failed("MyAnimeList");
        }
      })(),
    );
  }

  return Promise.all(jobs);
}

/** Save/remove through Harbor plus every connected tracker. Simkl existing statuses are never changed. */
export async function setLibraryMembership(
  input: LibraryActionInput,
  on: boolean,
  scope: LibraryAddScope,
  policy: UnsafeProviderPolicy = "skip",
): Promise<LibraryActionResult> {
  const base = await setContextWatchlist(input, on, policy);
  const localUpdated = base.outcomes.some(
    (outcome) => outcome.provider === "Harbor" && outcome.status === "updated",
  );
  if (!on && localUpdated) clearWatchlistAggregate(input);
  const localFailed = base.outcomes.some(
    (outcome) => outcome.provider === "Harbor" && outcome.status === "failed",
  );
  const extras =
    !localFailed && scope === "all" && isAnimeInput(input)
      ? await additiveAnimeTrackers(input, on)
      : [];
  const outcomes = [...base.outcomes, ...extras];
  if (
    outcomes.some(
      ({ provider, status }) =>
        status === "updated" &&
        (provider === "AniList" || provider === "MyAnimeList" || provider === "Simkl"),
    )
  ) {
    notifyTrackerStatusChanged();
  }
  return { ...base, scope, outcomes };
}

if (typeof window !== "undefined") {
  const onScopeReset = () => {
    scopeCache = null;
    notifyScope();
  };
  window.addEventListener("harbor:active-profile-changed", onScopeReset);
  window.addEventListener("harbor:profiles-updated", onScopeReset);
  window.addEventListener("harbor:nuvio-profile-changed", onScopeReset);
  window.addEventListener("harbor:nuvio-state-changed", onScopeReset);
}
