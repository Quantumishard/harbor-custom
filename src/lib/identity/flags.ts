import { IDENTITY_FLAG_DEFAULTS, type IdentityFlags } from "./types";

const KEY = "harbor.identity.flags.v1";
let override: IdentityFlags | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Feature flags stay off until the pack service has been verified on an origin. */
export function identityFlags(): IdentityFlags {
  if (override) return { ...override };
  const store = storage();
  if (!store) return { ...IDENTITY_FLAG_DEFAULTS };
  try {
    const raw = store.getItem(KEY);
    if (!raw) return { ...IDENTITY_FLAG_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<IdentityFlags>;
    return {
      pack: parsed?.pack === true,
      shadow: parsed?.shadow === true,
      cards: parsed?.cards === true,
    };
  } catch {
    return { ...IDENTITY_FLAG_DEFAULTS };
  }
}

export function setIdentityFlags(patch: Partial<IdentityFlags>): IdentityFlags {
  const next = { ...identityFlags(), ...patch };
  override = next;
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // In-memory override still works for this session.
  }
  return { ...next };
}

export function resetIdentityFlags(): void {
  override = null;
}

export function identityEnabled(): boolean {
  const flags = identityFlags();
  return flags.pack || flags.shadow || flags.cards;
}
