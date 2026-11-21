import { identifyBatch, identityFlags } from "./index";
import { recordIdentityShadow } from "./shadow";

type ShadowItem = { _id?: string | null };

/**
 * Log-only observer used while the pack is validated on a real origin. It never
 * changes what is displayed and runs only when the shadow flag is enabled.
 */
export async function observeIdentityShadow(items: ShadowItem[]): Promise<void> {
  if (!identityFlags().shadow) return;
  const ids = [...new Set(items.map((item) => item._id).filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  const lookups = await identifyBatch(ids);
  const provisional: string[] = [];
  let resolved = 0;
  for (const lookup of lookups.values()) {
    if (lookup.provisional) provisional.push(lookup.id);
    else resolved += 1;
  }
  recordIdentityShadow({
    at: Date.now(),
    ids,
    resolved,
    provisional,
  });
}
