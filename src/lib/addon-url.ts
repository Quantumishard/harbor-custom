/** Keep transport query parameters separate from Stremio resource paths. */
export function addonBaseUrl(transportUrl: string): string {
  // A plugin addon is served by the app, not over HTTP: its transport URL is already the key
  // every lookup uses, and `plugin:` in the authority is not a valid host:port pair for URL.
  if (transportUrl.startsWith("harbor-plugin://")) return transportUrl;
  const url = new URL(transportUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json\/?$/i, "").replace(/\/+$/, "");
  url.hash = "";
  return url.toString().replace(/^(https?:\/\/[^/?#]+)\/(?=[?#]|$)/, "$1");
}

/** resourcePath is an already encoded, relative Stremio resource path. */
export function addonResourceUrl(transportUrl: string, resourcePath: string): string {
  const url = new URL(addonBaseUrl(transportUrl));
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${resourcePath.replace(/^\/+/, "")}`;
  return url.toString();
}
