import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/views/manga/manga-reader/flipbook.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function makeHarness({ responseStatuses = [200] } = {}) {
  const calls = [];
  const bitmapCalls = [];
  let fetchIndex = 0;
  let originals = 0;
  class VendorMain {
    async fetchAndCacheImage() {
      originals++;
      return { from: "original" };
    }
  }
  const module = { exports: {} };
  const window = { FLIPBOOK: { Main: VendorMain }, __TAURI_INTERNALS__: {} };
  const context = createContext({
    window, module, exports: module.exports, console, setTimeout, URL, Blob,
    createImageBitmap: async (blob, options) => {
      bitmapCalls.push({ blob, options });
      return { from: "native-image", size: blob.size };
    },
    require(name) {
      if (name === "./chapter-image-cache") {
        return {
          chapterImageBlob: async (...args) => {
            calls.push(args);
            const status = responseStatuses[Math.min(fetchIndex++, responseStatuses.length - 1)];
            if (status !== 200) throw new Error(`Image request failed: HTTP ${status}`);
            return new Blob(["bitmap-data"], { type: "image/png" });
          },
        };
      }
      if (name === "@/lib/manga/plugins/adapter") {
        return { pageHeadersFor: () => ({ Referer: "https://batcave.biz/" }) };
      }
      if (name === "./image-request-headers") {
        return {
          isBatcaveImageUrl: (value) => {
            try {
              const address = new URL(value);
              return address.protocol === "https:" && address.hostname === "img.batcave.biz";
            } catch {
              return false;
            }
          },
        };
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  new Script(compiled, { filename: "flipbook.transpiled.js" }).runInContext(context);
  return {
    guard: module.exports.guardPageLoaded, VendorMain, calls, bitmapCalls,
    get originals() { return originals; },
  };
}

test("vendor flipbook uses the shared reader image cache for a protected page", async () => {
  const h = makeHarness();
  h.guard();
  h.guard(); // patch is idempotent across remounts
  const vendor = new h.VendorMain();
  vendor.options = { bitmapResizeHeight: 2048, bitmapResizeQuality: "high" };
  const url = "https://img.batcave.biz/img/38567/273703/1234.jpg?s=signed";
  const [a, b] = await Promise.all([vendor.fetchAndCacheImage(url), vendor.fetchAndCacheImage(url)]);
  assert.equal(a.from, "native-image");
  assert.equal(a, b);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], url);
  assert.equal(h.calls[0][1].Referer, "https://batcave.biz/");
  assert.equal(h.bitmapCalls[0].options.resizeHeight, 2048);
  assert.equal(h.bitmapCalls[0].options.resizeQuality, "high");
  assert.equal(h.originals, 0);
  const other = await vendor.fetchAndCacheImage("https://other-source.example/1.jpg");
  assert.equal(other.from, "original");
  assert.equal(h.originals, 1);
});

test("vendor image cache removes a failed image promise so the same page can retry", async () => {
  const h = makeHarness({ responseStatuses: [403, 200] });
  h.guard();
  const vendor = new h.VendorMain();
  const url = "https://img.batcave.biz/img/38567/273703/5678.jpg?s=signed";
  await assert.rejects(vendor.fetchAndCacheImage(url), /HTTP 403/);
  const bitmap = await vendor.fetchAndCacheImage(url);
  assert.equal(bitmap.from, "native-image");
  assert.equal(h.calls.length, 2);
});
