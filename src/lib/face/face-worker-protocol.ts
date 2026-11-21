import type { DetectedFace, WireFace } from "./match";

export type FaceWorkerPayload = {
  ensure: { type: "ensure" };
  scan: { type: "scan"; bitmap: ImageBitmap };
  "embed-largest": { type: "embed-largest"; bitmap: ImageBitmap };
  "embed-faces": { type: "embed-faces"; bitmap: ImageBitmap; faces: DetectedFace[] };
};

export type FaceWorkerRequest = FaceWorkerPayload[keyof FaceWorkerPayload] & { id: number };

export type FaceWorkerResult = {
  // Whether the worker detects faces itself (it needs WebGL for that).
  ensure: boolean;
  scan: WireFace[];
  "embed-largest": number[] | null;
  "embed-faces": WireFace[];
};

export type FaceWorkerResponse =
  | { id: number; ok: true; result: FaceWorkerResult[keyof FaceWorkerResult] }
  | { id: number; ok: false; error: string };
