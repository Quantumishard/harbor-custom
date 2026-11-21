import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_FALLBACK_HEADERS, isBatcaveImageUrl, resolveReaderImageHeaders } from "../src/views/manga/manga-reader/image-request-headers.ts";

test("reader image fallback supplies Batcave Referer to every page, including cached URL-only entries", () => {
  for (const url of [
    "https://img.batcave.biz/img/30392/213263/page1.jpg?s=token",
    "https://batcave.biz/img/page2.jpg",
    "https://cdn.img.batcave.biz/img/page3.webp",
  ]) {
    const headers = resolveReaderImageHeaders(url, IMAGE_FALLBACK_HEADERS);
    assert.equal(headers.Referer, "https://batcave.biz/");
    assert.ok(headers["User-Agent"]);
  }
});

test("reader image fallback preserves explicit provider Referer and does not infer one for unrelated CDNs", () => {
  const custom = resolveReaderImageHeaders("https://img.batcave.biz/img/page.jpg", {
    Referer: "https://batcave.biz/chapter/example",
  });
  assert.equal(custom.Referer, "https://batcave.biz/chapter/example");
  const lowercase = resolveReaderImageHeaders("https://img.batcave.biz/img/page.jpg", {
    referer: "https://batcave.biz/",
  });
  assert.equal(lowercase.referer, "https://batcave.biz/");
  assert.equal(lowercase.Referer, undefined);
  const foreign = resolveReaderImageHeaders("https://cdn.unrelated.example/img/page.jpg");
  assert.equal(foreign.Referer, undefined);
  const spoofed = resolveReaderImageHeaders("https://batcave.biz.attacker.example/image.jpg");
  assert.equal(spoofed.Referer, undefined);
});

test("only Batcave image host gets the flipbook browser-recovery hook", () => { assert.equal(isBatcaveImageUrl("https://img.batcave.biz/img/chapter.jpg?s=token"), true); assert.equal(isBatcaveImageUrl("https://cdn.img.batcave.biz/img/chapter.jpg"), true); assert.equal(isBatcaveImageUrl("https://batcave.biz/engine/ajax/controller.php"), false); assert.equal(isBatcaveImageUrl("https://img.batcave.biz.evil.example/image.jpg"), false); assert.equal(isBatcaveImageUrl("http://img.batcave.biz/image.jpg"), false); });
