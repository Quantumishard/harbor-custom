import { invokeIdentity } from "./client";
import { identityEnabled } from "./flags";
import type { IdentityCardHint, IdentityWindowOwner } from "./types";

/** Card hints for a batch of ids; null when the service is unavailable. */
export async function fetchCardHints(ids: string[]): Promise<IdentityCardHint[] | null> {
  if (!identityEnabled()) return null;
  return invokeIdentity<IdentityCardHint[]>("identity_card_hints", { ids });
}

/** Which work entries own a provider show/season. */
export async function fetchWindowOwners(
  show: { tvdb: number | null; tmdb: number | null },
  season: number,
): Promise<IdentityWindowOwner[]> {
  if (!identityEnabled()) return [];
  const owners = await invokeIdentity<IdentityWindowOwner[]>("identity_window_owners", {
    tvdb: show.tvdb,
    tmdb: show.tmdb,
    season,
  });
  return owners ?? [];
}
