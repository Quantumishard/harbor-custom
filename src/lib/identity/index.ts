import { clearIdentityCardCache } from "./card-grouping";
import { invokeIdentity, setIdentityInvoker } from "./client";
import { clearIdentityMisKeyCache } from "./mis-key";
import { clearVerifiedCwRepairs } from "./cw-repair";
import { identityEnabled, identityFlags } from "./flags";
import type { IdentityBundle, IdentityLookup, IdentityStatus } from "./types";

const LOOKUP_TTL_MS = 5 * 60_000;
const PROVISIONAL_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 2_000;

type CachedLookup = { at: number; value: IdentityLookup };

const lookupCache = new Map<string, CachedLookup>();
const bundleCache = new Map<string, { at: number; value: IdentityBundle }>();

function wallClock(): number {
  return Date.now();
}

function provisional(id: string): IdentityLookup {
  return { id, entry: null, title: null, provisional: true };
}

function cacheLookup(value: IdentityLookup): void {
  if (lookupCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest !== undefined) lookupCache.delete(oldest);
  }
  lookupCache.set(value.id, {
    at: wallClock(),
    value,
  });
}

function cachedLookup(id: string): IdentityLookup | null {
  const hit = lookupCache.get(id);
  if (!hit) return null;
  const ttl = hit.value.provisional ? PROVISIONAL_TTL_MS : LOOKUP_TTL_MS;
  if (wallClock() - hit.at > ttl) {
    lookupCache.delete(id);
    return null;
  }
  return hit.value;
}

export function clearIdentityCache(): void {
  lookupCache.clear();
  bundleCache.clear();
  // A pack swap changes card keys and retirement decisions too.
  clearIdentityCardCache();
  clearIdentityMisKeyCache();
  clearVerifiedCwRepairs();
}

/**
 * Resolve ids of the form `kitsu:49847` / `mal:61469`.
 *
 * This never throws and never blocks a render path: without the feature flag,
 * Tauri, or the downloaded pack, every id is returned as provisional and the
 * caller keeps today's behavior.
 */
export async function identifyBatch(ids: string[]): Promise<Map<string, IdentityLookup>> {
  const out = new Map<string, IdentityLookup>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = cachedLookup(id);
    if (hit) out.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return out;

  if (identityEnabled()) {
    const results = await invokeIdentity<IdentityLookup[]>("identity_lookup_batch", {
      ids: missing,
    });
    if (results) {
      for (const result of results) {
        cacheLookup(result);
        out.set(result.id, result);
      }
    }
  }
  for (const id of missing) {
    if (out.has(id)) continue;
    out.set(id, provisional(id));
  }
  return out;
}

export async function identityBundle(key: string): Promise<IdentityBundle | null> {
  const hit = bundleCache.get(key);
  if (hit && wallClock() - hit.at <= LOOKUP_TTL_MS) return hit.value;
  if (!identityEnabled()) return null;
  const bundle = await invokeIdentity<IdentityBundle | null>("identity_entry_bundle", { key });
  if (bundle) bundleCache.set(key, { at: wallClock(), value: bundle });
  return bundle;
}

export async function identityStatus(): Promise<IdentityStatus | null> {
  if (!identityEnabled()) return null;
  return invokeIdentity<IdentityStatus>("identity_status");
}

/** Fingerprint the installed pack, rather than its response's ready boolean.
 * A routine startup freshness check returns ready without replacing anything.
 */
function sameInstalledPack(a: IdentityStatus, b: IdentityStatus): boolean {
  return a.ready === b.ready && a.schema === b.schema &&
    a.packVersion === b.packVersion && a.upstreamSha256 === b.upstreamSha256 &&
    a.builtAt === b.builtAt && a.windows === b.windows;
}

/** Download and import the latest pack, or return the current status. */
export async function clearIdentityData(): Promise<IdentityStatus | null> {
  if (!identityEnabled()) return null;
  const status = await invokeIdentity<IdentityStatus>("identity_clear_data");
  if (status && !status.ready) clearIdentityCache();
  return status;
}

export async function ensureIdentityPack(force = false): Promise<IdentityStatus | null> {
  if (!identityEnabled()) return null;
  const before = await invokeIdentity<IdentityStatus>("identity_status");
  const status = await invokeIdentity<IdentityStatus>("identity_ensure_pack", { force });
  // Only a demonstrated install/swap may invalidate the persisted card keys.
  // When the status read is unavailable, do not guess that a fresh response
  // means the pack changed and split existing Continue Watching groups.
  if (before && status && !sameInstalledPack(before, status)) clearIdentityCache();
  return status;
}

/** Developer surface for shadow-mode inspection on an installed origin. */
export function installIdentityDebug(): void {
  if (typeof window === "undefined") return;
  const target = window as unknown as {
    __harborIdentity?: {
      flags: typeof identityFlags;
      status: typeof identityStatus;
      ensurePack: typeof ensureIdentityPack;
      clearData: typeof clearIdentityData;
      identifyBatch: typeof identifyBatch;
      bundle: typeof identityBundle;
      clearCache: typeof clearIdentityCache;
      setInvoker: typeof setIdentityInvoker;
    };
  };
  target.__harborIdentity = {
    flags: identityFlags,
    status: identityStatus,
    ensurePack: ensureIdentityPack,
    identifyBatch,
    bundle: identityBundle,
    clearData: clearIdentityData,
    clearCache: clearIdentityCache,
    setInvoker: setIdentityInvoker,
  };
}

export { identityEnabled, identityFlags, setIdentityFlags, resetIdentityFlags } from "./flags";
export { setIdentityInvoker } from "./client";
export type {
  IdentityAlias,
  IdentityBundle,
  IdentityFlags,
  IdentityLookup,
  IdentityRelated,
  IdentityStatus,
  IdentityWindow,
} from "./types";
