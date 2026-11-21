import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const isOrtRuntimeFile = (name) => /^(?:onnxruntime.*|DirectML)\.dll$/i.test(name);

// The pinned ort-sys 2.0.0-rc.10 Windows archive contains a large static
// onnxruntime.lib and DirectML.dll. It does not contain onnxruntime.dll.
// Keep any runtime DLLs from alternative archive layouts, but require the
// DirectML dependency imported by harbor.exe.
export function listOrtRuntimeFiles(coreReleaseDir) {
  const runtimeFiles = readdirSync(coreReleaseDir).filter(isOrtRuntimeFile);
  if (!runtimeFiles.some((name) => name.toLowerCase() === "directml.dll")) {
    throw new Error("Sidecar Core is missing DirectML.dll; rebuild the modular Shipyard core.");
  }
  for (const name of runtimeFiles) {
    if (statSync(join(coreReleaseDir, name)).size <= 0) {
      throw new Error(`Sidecar Core staged an empty ${name}`);
    }
  }
  return runtimeFiles;
}
