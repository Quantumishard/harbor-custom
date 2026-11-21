import assert from "node:assert/strict";
import test from "node:test";
import type { FaceDetector } from "@mediapipe/tasks-vision";
import { detectLargestFace, detectScanFaces } from "@/lib/face/face-detector";

const kps = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.1 },
  { x: 0.15, y: 0.2 },
  { x: 0.15, y: 0.3 },
];

function detector(boxes: { w: number; h: number; points?: number }[]): FaceDetector {
  const detections = boxes.map(({ w, h, points = 4 }) => ({
    categories: [],
    boundingBox: { originX: 0, originY: 0, width: w, height: h, angle: 0 },
    keypoints: kps.slice(0, points),
  }));
  return { detect: () => ({ detections }) } as unknown as FaceDetector;
}

const bitmap = {} as ImageBitmap;

test("scan faces drop tiny boxes and missing keypoints, largest first, capped at 8", () => {
  const faces = detectScanFaces(
    detector([
      { w: 30, h: 300 },
      { w: 60, h: 60 },
      { w: 100, h: 100, points: 3 },
      { w: 90, h: 90 },
      ...Array.from({ length: 8 }, () => ({ w: 50, h: 50 })),
    ]),
    bitmap,
  );
  assert.equal(faces.length, 8);
  assert.deepEqual(faces[0].box, { x: 0, y: 0, w: 90, h: 90 });
  assert.deepEqual(faces[1].box, { x: 0, y: 0, w: 60, h: 60 });
  assert.equal(faces[0].keypoints.length, 4);
});

test("largest face ignores size floor but needs keypoints", () => {
  const face = detectLargestFace(
    detector([
      { w: 20, h: 20 },
      { w: 200, h: 200, points: 2 },
    ]),
    bitmap,
  );
  assert.deepEqual(face?.box, { x: 0, y: 0, w: 20, h: 20 });
  assert.equal(detectLargestFace(detector([]), bitmap), null);
});
