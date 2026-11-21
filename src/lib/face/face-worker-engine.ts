import type { FaceDetector } from "@mediapipe/tasks-vision";
import * as ort from "onnxruntime-web/wasm";
import ortWasmUrl from "./ort/ort-wasm-simd-threaded.wasm?url";
import ortMjsUrl from "./ort/ort-wasm-simd-threaded.mjs?url";
import { align112, faceToTensor, mpKeypointsTo4pt } from "./align";
import {
  createFaceDetector,
  detectLargestFace,
  detectScanFaces,
  loadModel,
  workerHasWebGL,
} from "./face-detector";
import { l2normalize } from "./match";
import type { DetectedFace, WireFace } from "./match";

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
// X-Ray already runs in its own worker. Keeping ORT single-threaded prevents it
// from spawning nested workers that require cross-origin isolation in WebView2.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.simd = true;

const RECOGNIZER_MODEL = "/models/face/face_recognition_sface_2021dec_int8.onnx";

let detector: FaceDetector | null = null;
let session: ort.InferenceSession | null = null;
let readyPromise: Promise<boolean> | null = null;

async function boot(): Promise<boolean> {
  const inWorker = workerHasWebGL();
  const [nextDetector, recognizerModel] = await Promise.all([
    inWorker ? createFaceDetector() : null,
    loadModel(RECOGNIZER_MODEL, "The face recognition model"),
  ]);
  detector = nextDetector;
  session = await ort.InferenceSession.create(recognizerModel, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return inWorker;
}

// Resolves to whether face detection runs here; when false the main thread
// detects and sends the faces over with embedWorkerFaces.
export function ensureWorkerFaceEngine(): Promise<boolean> {
  if (!readyPromise) {
    readyPromise = boot().catch((error) => {
      readyPromise = null;
      detector = null;
      session = null;
      throw error;
    });
  }
  return readyPromise;
}

async function embedCanvas(canvas: OffscreenCanvas): Promise<Float32Array> {
  const currentSession = session as ort.InferenceSession;
  const input = new ort.Tensor("float32", faceToTensor(canvas), [1, 3, 112, 112]);
  try {
    const outputs = await currentSession.run({ [currentSession.inputNames[0]]: input });
    try {
      const output = outputs[currentSession.outputNames[0]];
      const embedding = Float32Array.from(output.data as ArrayLike<number>);
      return l2normalize(embedding);
    } finally {
      for (const output of Object.values(outputs)) output.dispose();
    }
  } finally {
    input.dispose();
  }
}

const MIN_FACES_PER_SCAN = 5;
const FACE_SCAN_BUDGET_MS = 220;

export async function embedWorkerFaces(
  bitmap: ImageBitmap,
  detected: DetectedFace[],
): Promise<WireFace[]> {
  const faces: WireFace[] = [];
  const startedAt = performance.now();
  for (const face of detected) {
    if (faces.length >= MIN_FACES_PER_SCAN && performance.now() - startedAt >= FACE_SCAN_BUDGET_MS)
      break;
    const points = mpKeypointsTo4pt(face.keypoints, bitmap.width, bitmap.height);
    const embedding = await embedCanvas(align112(bitmap, points));
    faces.push({ box: face.box, embedding: Array.from(embedding) });
  }
  return faces;
}

export async function scanWorkerFrame(bitmap: ImageBitmap): Promise<WireFace[]> {
  if (!detector) return [];
  return embedWorkerFaces(bitmap, detectScanFaces(detector, bitmap));
}

export async function embedWorkerLargestFace(bitmap: ImageBitmap): Promise<number[] | null> {
  if (!detector) return null;
  const face = detectLargestFace(detector, bitmap);
  if (!face) return null;
  const [embedded] = await embedWorkerFaces(bitmap, [face]);
  return embedded.embedding;
}
