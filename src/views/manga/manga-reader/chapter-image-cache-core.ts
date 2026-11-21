export type ImagePriority = "visible" | "near";

type CacheEntry = { blob: Blob; expiresAt: number };
type Job = { key: string; priority: ImagePriority; start: () => void };

/** Process-local, bounded cache of *compressed* chapter images, not decoded bitmaps. */
export function createChapterImageCache(
  load: (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<Blob>,
  limits: { maxBytes?: number; maxEntries?: number; maxConcurrent?: number; ttlMs?: number } = {},
) {
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 24;
  const maxConcurrent = limits.maxConcurrent ?? 4;
  const ttlMs = limits.ttlMs ?? 15 * 60_000;
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<Blob>>();
  const queue: Job[] = [];
  let occupiedBytes = 0;
  let running = 0;

  // Include headers to avoid treating different source sessions as the same image.
  const keyFor = (url: string, headers: Record<string, string>): string =>
    JSON.stringify([url, Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
      .sort(([a], [b]) => a.localeCompare(b))]);

  function getCached(key: string): Blob | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      occupiedBytes -= entry.blob.size;
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.blob;
  }

  function remember(key: string, blob: Blob): void {
    if (blob.size > maxBytes) return;
    const old = entries.get(key);
    if (old) occupiedBytes -= old.blob.size;
    entries.delete(key);
    entries.set(key, { blob, expiresAt: Date.now() + ttlMs });
    occupiedBytes += blob.size;
    while (entries.size > maxEntries || occupiedBytes > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      occupiedBytes -= entries.get(oldest)!.blob.size;
      entries.delete(oldest);
    }
  }

  function pump(): void {
    while (running < maxConcurrent && queue.length) {
      const index = queue.findIndex((job) => job.priority === "visible");
      const [job] = queue.splice(index < 0 ? 0 : index, 1);
      job.start();
    }
  }

  function fetch(
    url: string,
    headers: Record<string, string>,
    options: { priority?: ImagePriority; timeoutMs?: number; refresh?: boolean } = {},
  ): Promise<Blob> {
    const key = keyFor(url, headers);
    if (options.refresh) {
      const previous = entries.get(key);
      if (previous) {
        occupiedBytes -= previous.blob.size;
        entries.delete(key);
      }
    } else {
      const cached = getCached(key);
      if (cached) return Promise.resolve(cached);
    }
    const existing = pending.get(key);
    if (existing) {
      if (options.priority !== "near") {
        const job = queue.find((item) => item.key === key);
        if (job) job.priority = "visible";
        pump();
      }
      return existing;
    }

    let resolve!: (blob: Blob) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Blob>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.set(key, promise);
    const job: Job = {
      key,
      priority: options.priority ?? "visible",
      start: () => {
        running++;
        void Promise.resolve()
          .then(() => load(url, headers, options.timeoutMs ?? 30_000))
          .then((blob) => {
            remember(key, blob);
            resolve(blob);
          }, reject)
          .finally(() => {
            if (pending.get(key) === promise) pending.delete(key);
            running--;
            pump();
          });
      },
    };
    queue.push(job);
    pump();
    return promise;
  }

  return {
    fetch,
    peek: (url: string, headers: Record<string, string>): Blob | undefined => getCached(keyFor(url, headers)),
    clear: () => {
      entries.clear();
      occupiedBytes = 0;
    },
  };
}
