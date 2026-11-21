// A page's explicitly supplied headers always win. These defaults are only
// for reader images, not arbitrary fetches or provider API requests.
export const IMAGE_FALLBACK_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** Restrict the flipbook's native recovery hook to Batcave's image CDN. */
export function isBatcaveImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "img.batcave.biz" || parsed.hostname.endsWith(".img.batcave.biz"))
    );
  } catch {
    return false;
  }
}

export function resolveReaderImageHeaders(
  url: string,
  supplied: Record<string, string> = IMAGE_FALLBACK_HEADERS,
): Record<string, string> {
  const headers = { ...IMAGE_FALLBACK_HEADERS, ...supplied };
  const hasReferrer = Object.keys(headers).some((key) => key.toLowerCase() === "referer");
  if (hasReferrer) return headers;
  try {
    const target = new URL(url);
    // Batcave's signed image CDN serves a Google-style 403 without the site's
    // Referer. This site-specific fallback also covers cached chapter URLs
    // whose provider page-header metadata was lost. Do not guess arbitrary
    // third-party Referers for other sources.
    if (
      target.protocol === "https:" &&
      (target.hostname === "batcave.biz" || target.hostname.endsWith(".batcave.biz"))
    ) {
      headers.Referer = "https://batcave.biz/";
    }
  } catch {
    // Relative and malformed URLs retain the ordinary fallback headers.
  }
  return headers;
}
