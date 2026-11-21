import type {
  FaceWorkerPayload,
  FaceWorkerResponse,
  FaceWorkerResult,
} from "./face-worker-protocol";
import type { WireFace } from "./match";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
// Set when the worker has no WebGL (WebKitGTK) and detection runs here instead.
let mainDetector: {
  detector: import("@mediapipe/tasks-vision").FaceDetector;
  lib: typeof import("./face-detector");
} | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function rejectPending(reason: Error): void {
  for (const request of pending.values()) request.reject(reason);
  pending.clear();
}

function stopWorker(current: Worker, reason: Error): void {
  current.terminate();
  if (worker !== current) return;
  worker = null;
  readyPromise = null;
  mainDetector?.detector.close();
  mainDetector = null;
  rejectPending(reason);
}

function getWorker(): Worker {
  if (worker) return worker;
  const next = new Worker(new URL("./face-worker.ts", import.meta.url), {
    type: "module",
    name: "harbor-xray-face",
  });
  next.addEventListener("message", (event: MessageEvent<FaceWorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error));
  });
  next.addEventListener("error", () => {
    stopWorker(next, new Error("X-Ray face worker failed"));
  });
  next.addEventListener("messageerror", () => {
    stopWorker(next, new Error("X-Ray face worker returned an unreadable result"));
  });
  worker = next;
  return next;
}

function request<T extends keyof FaceWorkerPayload>(
  current: Worker,
  message: FaceWorkerPayload[T],
  transfer: Transferable[] = [],
): Promise<FaceWorkerResult[T]> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as FaceWorkerResult[T]),
      reject,
    });
    try {
      current.postMessage({ ...message, id }, transfer);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function ensureFaceEngine(): Promise<void> {
  if (readyPromise) return readyPromise;
  const current = getWorker();
  readyPromise = request<"ensure">(current, { type: "ensure" })
    .then(async (workerDetects) => {
      if (workerDetects) return;
      const lib = await import("./face-detector");
      const detector = await lib.createFaceDetector();
      if (worker !== current) {
        detector.close();
        throw new Error("X-Ray face worker stopped");
      }
      mainDetector = { detector, lib };
    })
    .catch((error) => {
      if (worker === current) stopWorker(current, error);
      throw error;
    });
  return readyPromise;
}

export function releaseFaceEngine(): void {
  if (!worker) {
    readyPromise = null;
    return;
  }
  stopWorker(worker, new Error("X-Ray face worker stopped"));
}

// The bitmap is still ours until it is transferred, so close it if startup fails.
async function readyWorker(bitmap: ImageBitmap): Promise<Worker> {
  try {
    await ensureFaceEngine();
    if (!worker) throw new Error("X-Ray face worker is unavailable");
    return worker;
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

function detectOnMain<T>(
  bitmap: ImageBitmap,
  run: (main: NonNullable<typeof mainDetector>) => T,
): T {
  try {
    if (!mainDetector) throw new Error("X-Ray face worker stopped");
    return run(mainDetector);
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

export async function scanFrame(bitmap: ImageBitmap): Promise<WireFace[]> {
  const current = await readyWorker(bitmap);
  if (!mainDetector) return request<"scan">(current, { type: "scan", bitmap }, [bitmap]);
  const faces = detectOnMain(bitmap, (m) => m.lib.detectScanFaces(m.detector, bitmap));
  if (faces.length === 0) {
    bitmap.close();
    return [];
  }
  return request<"embed-faces">(current, { type: "embed-faces", bitmap, faces }, [bitmap]);
}

export async function embedLargestFace(bitmap: ImageBitmap): Promise<number[] | null> {
  const current = await readyWorker(bitmap);
  if (!mainDetector)
    return request<"embed-largest">(current, { type: "embed-largest", bitmap }, [bitmap]);
  const face = detectOnMain(bitmap, (m) => m.lib.detectLargestFace(m.detector, bitmap));
  if (!face) {
    bitmap.close();
    return null;
  }
  const [embedded] = await request<"embed-faces">(
    current,
    { type: "embed-faces", bitmap, faces: [face] },
    [bitmap],
  );
  return embedded.embedding;
}
