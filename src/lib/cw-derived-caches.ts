import {
  activeProfileId,
  isNuvioProviderActive,
  nuvioWatchedScope,
  stremioProfileId,
} from "@/lib/active-profile-id";
import { notifyAnimeCwIds } from "@/lib/anime-cw-ids";
import { clearAnimeTitleKeys } from "@/lib/anime-title-key";
import { clearCardCoords } from "@/lib/cw-card-coords";
import { privateCwProfileId } from "@/lib/cw-profile";

/**
 * Stable Stremio identity for the active source profile; never the auth token.
 *
 * shortcut: signInWithKey() stores a placeholder `stremio:<key prefix>` id when
 * the user lookup fails. It is treated as an owner here because the session is
 * still account-scoped, but it is not a verified Stremio user identity. Upgrade
 * when auth starts recording whether a user id is verified.
 */
function stremioAccountId(profileId: string): string | null {
  try {
    const raw = localStorage.getItem(`harbor.auth.${profileId}`);
    return raw ? (JSON.parse(raw)?.user?._id ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Cached display coordinates and title aliases are only valid for the account
 * that produced them. The source profile and its stored session are read
 * together so a profile switch can never pair one profile with another account.
 */
export function cwCacheOwnerKey(): string {
  const profile = privateCwProfileId() ?? activeProfileId();
  if (isNuvioProviderActive()) return `nuvio|${profile}|${nuvioWatchedScope()}`;
  const source = stremioProfileId() || "default";
  return `stremio|${profile}|${source}|${stremioAccountId(source) ?? "signed-out"}`;
}

let lastOwner: string | null = typeof window !== "undefined" ? cwCacheOwnerKey() : null;

/** Clear both caches once and notify anime consumers once when the owner changes. */
export function syncCwCacheOwner(): void {
  const owner = cwCacheOwnerKey();
  if (lastOwner === null) {
    lastOwner = owner;
    return;
  }
  if (owner === lastOwner) return;
  lastOwner = owner;
  clearCardCoords();
  clearAnimeTitleKeys();
  notifyAnimeCwIds();
}

const EVENTS = [
  "harbor:active-profile-changed",
  "harbor:profiles-updated",
  "harbor:nuvio-profile-changed",
  "harbor:nuvio-state-changed",
  "harbor:account-provider-changed",
  "harbor:stremio-account-changed",
];

if (typeof window !== "undefined") {
  for (const event of EVENTS) window.addEventListener(event, syncCwCacheOwner);
}
