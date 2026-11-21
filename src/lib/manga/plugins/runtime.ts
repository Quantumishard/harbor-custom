import type { MangaProvider } from "../types";
import type { InstalledPlugin } from "./types";
import { PluginWorker, INTERACTIVE_PLUGIN_TIMEOUT_MS } from "./worker-host";
import { toSummaries, toSummary, toChapters, toStrings, toTags } from "./adapter";

const workers = new Map<string, PluginWorker>();
const sourceOrigins = new Map<string, string>();

function workerFor(p: InstalledPlugin, background = false): PluginWorker {
  const key = `${background ? "background:" : ""}${p.id}`;
  let w = workers.get(key);
  if (!w) {
    w = new PluginWorker(p, {
      httpPolicy: { background },
      callTimeoutMs: background ? undefined : INTERACTIVE_PLUGIN_TIMEOUT_MS,
      onHttpRequest: (url) => {
        if (sourceOrigins.has(key)) return;
        try {
          const source = new URL(p.baseUrl || url);
          if (source.protocol === "https:" || source.protocol === "http:")
            sourceOrigins.set(key, source.origin + "/");
        } catch {
          // Invalid source addresses never become image headers.
        }
      },
    });
    workers.set(key, w);
  }
  return w;
}

export function pluginProvider(p: InstalledPlugin, background = false): MangaProvider {
  const w = workerFor(p, background);
  const provider: MangaProvider = {
    id: p.id,
    name: p.name,
    requestTimeoutMs: background ? undefined : INTERACTIVE_PLUGIN_TIMEOUT_MS + 5_000,
    popular: (offset, tagId) => w.call("popular", [offset, tagId], 20_000).then(toSummaries),
    search: (query, offset, tagId) =>
      w.call("search", [query, offset, tagId], 20_000).then(toSummaries),
    detail: (id) => w.call("detail", [id], 20_000).then(toSummary),
    chapters: (id) => w.call("chapters", [id], 25_000).then(toChapters),
    pageUrls: (chapterId) =>
      w
        .call("pageUrls", [chapterId], 30_000)
        .then((value) =>
          toStrings(
            value,
            p.baseUrl || sourceOrigins.get(`${background ? "background:" : ""}${p.id}`),
          ),
        ),
  };
  if (p.hasTags) provider.tags = () => w.call("tags", [], 15_000).then(toTags);
  return provider;
}

export function warmPlugin(p: InstalledPlugin): void {
  void workerFor(p)
    .meta()
    .catch(() => {});
}

export function disposePlugin(id: string): void {
  for (const key of [id, `background:${id}`]) {
    workers.get(key)?.dispose();
    workers.delete(key);
    sourceOrigins.delete(key);
  }
}

export function disposeAllPlugins(): void {
  for (const w of workers.values()) w.dispose();
  workers.clear();
  sourceOrigins.clear();
}
