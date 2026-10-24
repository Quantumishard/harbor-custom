import { invoke } from "@tauri-apps/api/core";
import { restoreAioConnection } from "./aiostreams-library";

export async function playEasynewsNzb(url: string, sig: unknown, signal: AbortSignal) {
  if (signal.aborted) throw new Error("Playback cancelled");
  const connection = await restoreAioConnection();
  if (signal.aborted) throw new Error("Playback cancelled");
  if (!connection)
    throw new Error("Sign in under Library → AIOStreams first, then select NZB again.");
  const requestId = crypto.randomUUID();
  const cancel = () => {
    void invoke("aiostreams_easynews_cancel", { requestId }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invoke<{ url: string; filename: string }>("aiostreams_easynews_play", {
      sessionId: connection.sessionId,
      requestId,
      sourceUrl: url,
      sig: typeof sig === "string" ? sig : null,
    });
    if (signal.aborted) throw new Error("Playback cancelled");
    const target = new URL(result.url);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !target.port ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !/^\/aiostreams\/[a-f0-9-]{36}$/.test(target.pathname)
    )
      throw new Error("AIOStreams returned an unexpected playback URL");
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
