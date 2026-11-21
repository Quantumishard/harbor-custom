import { invoke } from "@tauri-apps/api/core";
import { isSuwayomiServerUrl } from "@/lib/manga/sources/suwayomi/auth-registry";
import { readImageResponse } from "@/lib/context-image-policy";
import { createChapterImageCache, type ImagePriority } from "./chapter-image-cache-core";
import { resolveReaderImageHeaders } from "./image-request-headers";

type NativeImage = {
  ok: boolean;
  status: number;
  body: string;
  contentType?: string | null;
  headers?: Record<string, string>;
};

function decodeBase64(body: string): Uint8Array {
  const binary = atob(body.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const cache = createChapterImageCache(async (url, headers, timeoutMs) => {
  const response = await invoke<NativeImage>("harbor_fetch", {
    args: {
      url,
      method: "GET",
      headers,
      responseType: "base64",
      timeoutMs,
      maxResponseBytes: 32 * 1024 * 1024,
      allowLocalNetwork: isSuwayomiServerUrl(url),
      allowImageChallenge: true,
    },
  });
  if (!response.ok) throw new Error(`Image request failed: HTTP ${response.status}`);
  const type = response.headers?.["content-type"] || response.contentType || "";
  const image = await readImageResponse(new Response(decodeBase64(response.body), {
    status: response.status,
    headers: type ? { "content-type": type } : {},
  }));
  return image.blob;
});

export function chapterImageBlob(
  url: string,
  suppliedHeaders?: Record<string, string>,
  options: { priority?: ImagePriority; timeoutMs?: number; refresh?: boolean } = {},
): Promise<Blob> {
  return cache.fetch(url, resolveReaderImageHeaders(url, suppliedHeaders), options);
}

export function cachedChapterImage(
  url: string,
  suppliedHeaders?: Record<string, string>,
): Blob | undefined {
  return cache.peek(url, resolveReaderImageHeaders(url, suppliedHeaders));
}
