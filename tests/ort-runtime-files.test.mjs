import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isOrtRuntimeFile, listOrtRuntimeFiles } from "../scripts/ort-runtime-files.mjs";

test("static ONNX Runtime only requires the dynamic DirectML dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-ort-static-"));
  try {
    assert.throws(() => listOrtRuntimeFiles(root), /missing DirectML\.dll/);
    writeFileSync(join(root, "onnxruntime.dll"), "dynamic");
    assert.throws(() => listOrtRuntimeFiles(root), /missing DirectML\.dll/);
    rmSync(join(root, "onnxruntime.dll"));
    writeFileSync(join(root, "DirectML.dll"), "DirectML");
    assert.deepEqual(listOrtRuntimeFiles(root), ["DirectML.dll"]);
    writeFileSync(join(root, "onnxruntime.dll"), "dynamic");
    writeFileSync(join(root, "onnxruntime_providers_shared.dll"), "provider");
    assert.deepEqual(listOrtRuntimeFiles(root).sort(), [
      "DirectML.dll",
      "onnxruntime.dll",
      "onnxruntime_providers_shared.dll",
    ]);
    assert.equal(isOrtRuntimeFile("other.dll"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaging refuses missing or empty DirectML and optional runtime DLLs", () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-ort-invalid-"));
  try {
    writeFileSync(join(root, "DirectML.dll"), "");
    assert.throws(() => listOrtRuntimeFiles(root), /empty DirectML\.dll/);
    writeFileSync(join(root, "DirectML.dll"), "DirectML");
    writeFileSync(join(root, "onnxruntime.dll"), "");
    assert.throws(() => listOrtRuntimeFiles(root), /empty onnxruntime\.dll/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
