import { pageHeadersFor } from "@/lib/manga/plugins/adapter";
import { cachedChapterImage, chapterImageBlob } from "./chapter-image-cache";
import { isBatcaveImageUrl, IMAGE_FALLBACK_HEADERS } from "./image-request-headers";
import type { ImagePriority } from "./chapter-image-cache-core";
export { IMAGE_FALLBACK_HEADERS, resolveReaderImageHeaders } from "./image-request-headers";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const MEASURE_TIMEOUT_MS = 8000;

export async function fetchImageObjectUrl(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 30000,
  options: { priority?: ImagePriority; refresh?: boolean } = {},
): Promise<string> {
  const blob = await chapterImageBlob(url, headers, { timeoutMs, ...options });
  return URL.createObjectURL(blob);
}

function aspectOf(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalHeight / (img.naturalWidth || 1));
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export async function measureAspect(src?: string): Promise<number> {
  if (!src) return 1.4;
  const headers = pageHeadersFor(src) ?? IMAGE_FALLBACK_HEADERS;
  const cached = cachedChapterImage(src, headers);
  if (cached) {
    const objectUrl = URL.createObjectURL(cached);
    try {
      return (await aspectOf(objectUrl)) ?? 1.4;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  // Batcave chapter images reject ordinary <img> requests. Avoid that failed
  // attempt when the verified browser already owns the image session.
  if (!isTauri || !isBatcaveImageUrl(src)) {
    const direct = await aspectOf(src);
    if (direct != null) return direct;
  }
  if (!isTauri) return 1.4;
  let objectUrl: string | null = null;
  try {
    objectUrl = await fetchImageObjectUrl(src, headers, MEASURE_TIMEOUT_MS, { priority: "near" });
    return (await aspectOf(objectUrl)) ?? 1.4;
  } catch {
    return 1.4;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export async function detectWebtoon(urls: string[]): Promise<boolean> {
  if (!urls.length) return false;
  const samples = [urls[0], urls[Math.floor(urls.length / 2)]].filter(Boolean);
  const aspects = await Promise.all(samples.map((s) => measureAspect(s)));
  return Math.max(...aspects) >= 2.2;
}
