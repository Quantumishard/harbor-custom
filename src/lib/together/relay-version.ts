export const REQUIRED_RELAY_VERSION = 11;
export const HARBOR_PUBLIC_RELAY = "wss://pub.harborcommunity.site";

export function migratePublicRelayUrl(url: string): string {
  return /^(?:(?:wss?|https?):\/\/)?pub\.harbor\.site\/?$/i.test(url.trim())
    ? HARBOR_PUBLIC_RELAY
    : url;
}

export function relayOutdated(version: number | null | undefined): boolean {
  return version == null || version < REQUIRED_RELAY_VERSION;
}

export function isPublicRelay(url: string): boolean {
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^(wss?|https?):\/\//, "")
    .replace(/\/.*$/, "");
  return host === "pub.harborcommunity.site";
}
