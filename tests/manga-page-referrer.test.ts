import assert from "node:assert/strict";
import test from "node:test";
import { pageHeadersFor, toStrings } from "../src/lib/manga/plugins/adapter.ts";

test("CDN images retain source referrers without source credentials or private URL data", () => {
  const image = "https://cdn.example/page.jpg";
  assert.deepEqual(toStrings([image], "https://source.example/reader/42?token=private"), [image]);
  assert.deepEqual(pageHeadersFor(image), { referer: "https://source.example/" });
  toStrings(
    [
      {
        url: image,
        headers: {
          Referer: "https://source.example/reader/42",
          Cookie: "secret",
          Authorization: "secret",
        },
      },
    ],
    "https://source.example/",
  );
  assert.deepEqual(pageHeadersFor(image), { referer: "https://source.example/reader/42" });
  toStrings([image]);
  assert.equal(pageHeadersFor(image), undefined);
});
