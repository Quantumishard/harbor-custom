import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorCode = readFileSync(path.join(root, "public/flipbook/js/flipbook.min.js"), "utf8");
const readerCode = readFileSync(path.join(root, "src/views/manga/manga-reader/book-view.tsx"), "utf8");

function vendorPrototypeOnHttpOrigin() {
  const scope = { console, document: {}, setTimeout, clearTimeout, location: { protocol: "http:" } };
  // In a classic browser script, top-level `var FLIPBOOK` is on `window`.
  scope.window = scope;
  scope.self = scope;
  new Script(vendorCode, { filename: "flipbook.min.js" }).runInContext(createContext(scope), {
    timeout: 2000,
  });
  assert.equal(typeof scope.FLIPBOOK.Main.prototype.loadPage, "function");
  return scope.FLIPBOOK.Main.prototype;
}

async function requestedImageUrl(proto, matchProtocol) {
  const originalUrl = "https://img.batcave.biz/img/38567/273703/page.jpg?token=example";
  let requested;
  const fake = {
    options: {
      pages: [{ src: originalUrl }],
      viewMode: "webgl",
      thumbTextureSize: 150,
      matchProtocol,
    },
    fetchAndCacheImage: async (url) => {
      requested = url;
      return { width: 1280, height: 960 };
    },
    pageLoaded: (_data, onLoaded) => onLoaded(),
  };
  await Promise.race([
    new Promise((resolve, reject) => {
      try {
        proto.loadPage.call(fake, 0, 2048, resolve);
      } catch (err) {
        reject(err);
      }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("vendor never finished loading page")), 1500)),
  ]);
  return requested;
}

test("vendor's default matchProtocol downgrades HTTPS images on Harbor's HTTP dev origin", async () => {
  const proto = vendorPrototypeOnHttpOrigin();
  assert.equal(
    await requestedImageUrl(proto, undefined),
    "http://img.batcave.biz/img/38567/273703/page.jpg?token=example",
  );
});

test("matchProtocol:false preserves HTTPS for image recovery, including signed query", async () => {
  const proto = vendorPrototypeOnHttpOrigin();
  assert.equal(
    await requestedImageUrl(proto, false),
    "https://img.batcave.biz/img/38567/273703/page.jpg?token=example",
  );
  assert.match(readerCode, /matchProtocol:\s*false/);
});
