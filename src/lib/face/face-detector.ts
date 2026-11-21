import { FilesetResolver, FaceDetector } from "@mediapipe/tasks-vision";
import type { Detection } from "@mediapipe/tasks-vision";
import { MIN_BOX_PX } from "./match";
import type { DetectedFace } from "./match";

const MP_WASM = "/mp-wasm";
const DETECTOR_MODEL = "/models/face/face_detection_full_range.tflite";
const MAX_FACES_PER_SCAN = 8;

export async function loadModel(url: string, what: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(`${what} could not be fetched from ${url}`);
  }
  if (!response.ok) throw new Error(`${what} is missing (${url} returned ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trim().toLowerCase();
  if (bytes.byteLength < 1024 || head.startsWith("<!doctype") || head.startsWith("<html")) {
    throw new Error(`${what} is missing from public${url}`);
  }
  return bytes;
}

// MediaPipe uploads every frame through WebGL, even on the CPU delegate.
// WebKitGTK has no WebGL in workers, so there the detector runs on the main thread.
export function workerHasWebGL(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export async function createFaceDetector(): Promise<FaceDetector> {
  const model = await loadModel(DETECTOR_MODEL, "The face detection model");
  let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  try {
    // In the ES module worker the classic MediaPipe loader relies on
    // importScripts(), which module workers reject; its fallback then imports
    // the script without publishing ModuleFactory to the worker global. Harbor
    // ships MediaPipe's module-worker runtime locally, so select it explicitly
    // instead of relaxing CSP or loading executable code remotely. The main
    // thread loads the classic runtime through a <script> tag, which is fine.
    fileset = await FilesetResolver.forVisionTasks(MP_WASM, typeof document === "undefined");
  } catch {
    throw new Error(`The MediaPipe runtime is missing from public${MP_WASM}`);
  }
  return FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: model, delegate: "CPU" },
    runningMode: "IMAGE",
    minDetectionConfidence: 0.5,
  });
}

function toDetectedFace(detection: Detection): DetectedFace | null {
  const box = detection.boundingBox;
  if (!box || detection.keypoints.length < 4) return null;
  return {
    box: { x: box.originX, y: box.originY, w: box.width, h: box.height },
    keypoints: detection.keypoints.map(({ x, y }) => ({ x, y })),
  };
}

export function detectScanFaces(detector: FaceDetector, bitmap: ImageBitmap): DetectedFace[] {
  return detector
    .detect(bitmap)
    .detections.map(toDetectedFace)
    .filter((f): f is DetectedFace => !!f && f.box.w >= MIN_BOX_PX && f.box.h >= MIN_BOX_PX)
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
    .slice(0, MAX_FACES_PER_SCAN);
}

export function detectLargestFace(
  detector: FaceDetector,
  bitmap: ImageBitmap,
): DetectedFace | null {
  let best: DetectedFace | null = null;
  for (const detection of detector.detect(bitmap).detections) {
    const face = toDetectedFace(detection);
    if (!face || face.box.w <= 0 || face.box.h <= 0) continue;
    if (!best || face.box.w * face.box.h > best.box.w * best.box.h) best = face;
  }
  return best;
}
