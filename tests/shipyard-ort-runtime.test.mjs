import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../scripts/shipyard-ort-runtime.ps1", import.meta.url));
const quote = (path) => `'${path.replaceAll("'", "''")}'`;
const run = (fn, releaseDir, fail = false) => {
  let output;
  try {
    output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `. ${quote(helper)}; ${fn} -ReleaseDir ${quote(releaseDir)}`,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
  } catch (error) {
    if (fail) return String(error.stderr ?? error.message);
    throw error;
  }
  if (fail) assert.fail(`${fn} should fail without DirectML.dll`);
  return output;
};

test(
  "Shipyard supports both ort-sys Cargo output layouts and packages real DLL copies",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "harbor-ort-copy-"));
    try {
      const releaseDir = join(scratch, "release");
      run("Initialize-OrtRuntimeDirectories", releaseDir);
      for (const base of [releaseDir, join(releaseDir, "build")]) {
        for (const subdir of ["examples", "deps"]) {
          assert.equal(existsSync(join(base, subdir)), true, `${base}/${subdir}`);
        }
      }

      const nestedRuntime = join(releaseDir, "build", "onnxruntime.dll");
      const nestedDirectML = join(releaseDir, "build", "DirectML.dll");
      writeFileSync(nestedRuntime, Buffer.from("ONNX runtime sample"));
      writeFileSync(nestedDirectML, Buffer.from("DirectML sample"));
      run("Stage-OrtRuntimeDlls", releaseDir);
      assert.equal(
        readFileSync(join(releaseDir, "onnxruntime.dll"), "utf8"),
        "ONNX runtime sample",
      );
      assert.equal(readFileSync(join(releaseDir, "DirectML.dll"), "utf8"), "DirectML sample");

      rmSync(nestedRuntime);
      rmSync(nestedDirectML);
      // Legacy Cargo layouts already place the runtime beside harbor.exe.
      run("Stage-OrtRuntimeDlls", releaseDir);
      assert.equal(
        readFileSync(join(releaseDir, "onnxruntime.dll"), "utf8"),
        "ONNX runtime sample",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "Shipyard accepts statically linked ONNX Runtime with only DirectML.dll",
  { skip: process.platform !== "win32" },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "harbor-ort-static-"));
    try {
      const releaseDir = join(scratch, "release");
      run("Initialize-OrtRuntimeDirectories", releaseDir);
      const nestedDirectML = join(releaseDir, "build", "DirectML.dll");
      writeFileSync(nestedDirectML, "DirectML sample");
      run("Stage-OrtRuntimeDlls", releaseDir);
      assert.equal(readFileSync(join(releaseDir, "DirectML.dll"), "utf8"), "DirectML sample");
      assert.equal(existsSync(join(releaseDir, "onnxruntime.dll")), false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "Shipyard refuses a missing or empty DirectML runtime",
  { skip: process.platform !== "win32" },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "harbor-ort-missing-"));
    try {
      const releaseDir = join(scratch, "release");
      run("Initialize-OrtRuntimeDirectories", releaseDir);
      const error = run("Stage-OrtRuntimeDlls", releaseDir, true);
      assert.match(error, /did not stage a valid DirectML\.dll/);
      writeFileSync(join(releaseDir, "DirectML.dll"), "");
      const emptyError = run("Stage-OrtRuntimeDlls", releaseDir, true);
      assert.match(emptyError, /did not stage a valid DirectML\.dll/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
