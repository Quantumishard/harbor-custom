import type { MetadataSourceChain } from "./metadata-sources";

type MetadataSettings = {
  addonOnlyMetadata?: boolean;
  searchTmdbTopMatch?: boolean;
  cinemetaEnabled?: boolean;
  metadataSources?: MetadataSourceChain;
};

const defaults: Readonly<MetadataSettings> = {};

// Cards, addon requests and meta lookups read these flags many times per render
// pass, and each read used to JSON.parse the whole settings blob. The parse is
// kept per raw string, so any change to the stored settings is still seen at once.
const parsedMirrors = new Map<string, { raw: string; value: Record<string, unknown> | null }>();

/**
 * Read a settings mirror from localStorage without importing the React settings provider.
 * An empty or unparseable mirror reads as absent, so every caller falls back to its defaults.
 */
export function readSettingsMirror(key = "harbor.settings"): Record<string, unknown> | null {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  if (!raw) return null;
  const cached = parsedMirrors.get(key);
  if (cached?.raw === raw) return cached.value;
  let value: Record<string, unknown> | null;
  try {
    const parsed: unknown = JSON.parse(raw);
    value =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    value = null;
  }
  parsedMirrors.set(key, { raw, value });
  return value;
}

/** Read the profile mirror without running settings migrations on the artwork path. */
export function readMetadataSettings(): Readonly<MetadataSettings> {
  try {
    return (readSettingsMirror() as MetadataSettings | null) ?? defaults;
  } catch {
    return defaults;
  }
}

export function addonOnlyMetadata(): boolean {
  return readMetadataSettings().addonOnlyMetadata === true;
}

export function useTmdbTopMatch(): boolean {
  return readMetadataSettings().searchTmdbTopMatch !== false;
}
