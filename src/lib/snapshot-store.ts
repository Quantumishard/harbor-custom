export type SavedFrame = { id: string; t: number; aliases?: string[]; image: string };

const frames = new Map<string, SavedFrame>();
const touched = new Set<string>();
let cleared = false;
let ready: Promise<void> | undefined;
let database: Promise<IDBDatabase> | undefined;
let writes = Promise.resolve();

function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("harbor-saved-frames", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("frames", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(Error("Saved frame storage unavailable"));
  }));
}

async function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("frames", mode);
    const request = work(tx.objectStore("frames"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? Error("Saved frame transaction failed"));
  });
}

function enqueue(work: () => Promise<unknown>): void {
  if (typeof indexedDB === "undefined") return;
  writes = writes
    .then(work)
    .then(() => undefined)
    .catch((error) => {
      console.warn("[snapshots] durable storage failed", error);
    });
}

export function hydrateSavedFrames(changed: () => void): void {
  if (ready || typeof indexedDB === "undefined") return;
  ready = transaction<SavedFrame[]>("readonly", (store) => store.getAll())
    .then((saved) => {
      if (!cleared)
        for (const frame of saved) {
          const current = frames.get(frame.id);
          if (!touched.has(frame.id) || (current && frame.t > current.t))
            frames.set(frame.id, frame);
        }
      changed();
    })
    .catch((error) => console.warn("[snapshots] durable load failed", error));
}

export function savedFrame(id: string): SavedFrame | undefined {
  let newest: SavedFrame | undefined;
  for (const frame of frames.values()) {
    if ((frame.id === id || frame.aliases?.includes(id)) && (!newest || frame.t >= newest.t))
      newest = frame;
  }
  return newest;
}

export function storeSavedFrame(frame: SavedFrame): void {
  const current = frames.get(frame.id);
  if (current && current.t > frame.t) return;
  touched.add(frame.id);
  frames.set(frame.id, frame);
  enqueue(async () => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("frames", "readwrite");
      const store = tx.objectStore("frames");
      const request = store.get(frame.id);
      request.onsuccess = () => {
        const previous = request.result as SavedFrame | undefined;
        if (!previous || previous.t <= frame.t) store.put(frame);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? Error("Saved frame write failed"));
    });
  });
}

export function savedFrameIds(): string[] {
  return [...frames.keys()];
}

export function pruneSavedFrames(cutoff: number): void {
  for (const [id, frame] of frames)
    if (frame.t < cutoff) {
      touched.add(id);
      frames.delete(id);
      enqueue(() => transaction("readwrite", (store) => store.delete(id)));
    }
}

export function clearSavedFrames(): void {
  cleared = true;
  frames.clear();
  enqueue(() => transaction("readwrite", (store) => store.clear()));
}
