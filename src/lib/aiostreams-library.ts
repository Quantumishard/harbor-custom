import { invoke } from "@tauri-apps/api/core";
import { isPlayableVideoPath } from "@/lib/media-file";

export type AioConnection = {
  sessionId: string;
  baseUrl: string;
  remembered?: boolean;
  warning?: string;
};
export type AioFile = {
  name?: string;
  path?: string;
  index?: number;
  size: number;
  streamable?: boolean;
};
export type AioEntry = {
  nzbHash: string;
  name?: string;
  size?: number;
  status: string;
  addedAt: string;
  files: AioFile[];
};
export type AioPage = { entries: AioEntry[]; total: number };
export type AioFilters = {
  offset: number;
  query: string;
  status: string;
  sort: string;
  direction: string;
};

let connection: AioConnection | null = null;
let version = 0;
let restoring: Promise<AioConnection | null> | null = null;
export function currentAioConnection(): AioConnection | null {
  return connection;
}

export function aioDesktopAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function adopt(next: AioConnection, remember: boolean, attempt: number) {
  if (attempt !== version) {
    await invoke("aiostreams_disconnect", { sessionId: next.sessionId });
    throw new Error("The AIOStreams connection attempt was cancelled");
  }
  try {
    await invoke("aiostreams_remember", { sessionId: next.sessionId, remember });
    next.remembered = remember;
  } catch {
    next.warning =
      "Connected, but Harbor could not update the saved sign-in. Disconnect and retry if you want to remember or forget this instance.";
  }
  if (attempt !== version) {
    await invoke("aiostreams_disconnect", { sessionId: next.sessionId });
    throw new Error("The AIOStreams connection attempt was cancelled");
  }
  const previous = connection;
  connection = next;
  if (previous)
    void invoke("aiostreams_disconnect", { sessionId: previous.sessionId }).catch(() => {});
  return next;
}

export async function connectAio(
  baseUrl: string,
  username: string,
  password: string,
  remember = false,
) {
  const attempt = ++version;
  const next = await invoke<AioConnection>("aiostreams_connect", {
    baseUrlInput: baseUrl.trim(),
    username: username.trim(),
    password,
  });
  return adopt(next, remember, attempt);
}

export async function disconnectAio(expected?: AioConnection) {
  const previous = expected || connection;
  if (!expected || connection?.sessionId === expected.sessionId) {
    connection = null;
    version++;
  }
  try {
    if (!expected) await invoke("aiostreams_forget");
  } finally {
    if (previous) await invoke("aiostreams_disconnect", { sessionId: previous.sessionId });
  }
}

export const beginAioBrowserLogin = (baseUrl: string) =>
  invoke<string>("aiostreams_browser_begin", { baseUrlInput: baseUrl.trim() });

export const cancelAioBrowserLogin = (loginId: string) =>
  invoke<void>("aiostreams_browser_cancel", { loginId });

export async function finishAioBrowserLogin(loginId: string, remember = false) {
  const attempt = ++version;
  const next = await invoke<AioConnection>("aiostreams_browser_finish", { loginId });
  return adopt(next, remember, attempt);
}

export function restoreAioConnection(): Promise<AioConnection | null> {
  if (connection) return Promise.resolve(connection);
  if (restoring) return restoring;
  const attempt = version;
  restoring = invoke<AioConnection | null>("aiostreams_restore")
    .then(async (next) => {
      if (next && attempt !== version) {
        await invoke("aiostreams_disconnect", { sessionId: next.sessionId });
        return null;
      }
      if (next) {
        next.remembered = true;
        connection = next;
      }
      return next;
    })
    .finally(() => {
      restoring = null;
    });
  return restoring;
}

export async function listAio(connection: AioConnection, filters: AioFilters): Promise<AioPage> {
  const page = await invoke<AioPage>("aiostreams_library", {
    sessionId: connection.sessionId,
    request: { action: "list", ...filters },
  });
  if (!Array.isArray(page?.entries) || !Number.isFinite(page.total))
    throw new Error("AIOStreams returned an unsupported library response");
  return page;
}

export function aioFileSelector(file: AioFile): string | null {
  return file.path || (file.index !== undefined ? String(file.index) : file.name || null);
}

export function playableAioFiles(files: AioFile[]): AioFile[] {
  return files.filter(
    (file) =>
      file.streamable !== false &&
      aioFileSelector(file) !== null &&
      isPlayableVideoPath(file.name || file.path || ""),
  );
}

export async function aioFiles(connection: AioConnection, hash: string): Promise<AioFile[]> {
  const result = await invoke<{ files: AioFile[] }>("aiostreams_library", {
    sessionId: connection.sessionId,
    request: { action: "files", hash },
  });
  if (!Array.isArray(result?.files))
    throw new Error("AIOStreams returned an unsupported file list");
  return playableAioFiles(result.files);
}

export async function playAio(connection: AioConnection, hash: string, file: AioFile) {
  const selector = aioFileSelector(file);
  if (selector === null) throw new Error("This file has no playback selector");
  const result = await invoke<{ url: string; filename: string }>("aiostreams_library", {
    sessionId: connection.sessionId,
    request: { action: "play", hash, selector },
  });
  const url = new URL(result.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    !/^\/aiostreams\/[a-f0-9-]{36}$/.test(url.pathname)
  )
    throw new Error("AIOStreams returned an unexpected playback URL");
  return { ...result, url: url.href };
}
