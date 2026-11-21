import assert from "node:assert/strict";
import test from "node:test";
import { parseSize } from "../src/lib/streams/parser/parser-metadata.ts";
import { sortStreams } from "../src/lib/streams/source-sort.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

type Row = { id: string; size: number | null; seeders: number | null };

const row = (id: string, size: number | null, seeders: number | null = null): Row => ({
  id,
  size,
  seeders,
});

const ids = (rows: Row[]) => rows.map((r) => r.id);

test("default order returns the list untouched", () => {
  const rows = [row("a", 1), row("b", 3), row("c", 2)];
  assert.equal(sortStreams(rows, "default"), rows);
  assert.deepEqual(ids(rows), ["a", "b", "c"]);
});

test("largest first and smallest first sort by size", () => {
  const rows = [row("mid", 2 * GB), row("big", 20 * GB), row("small", 700 * MB)];
  assert.deepEqual(ids(sortStreams(rows, "size-desc")), ["big", "mid", "small"]);
  assert.deepEqual(ids(sortStreams(rows, "size-asc")), ["small", "mid", "big"]);
  assert.deepEqual(ids(rows), ["mid", "big", "small"], "input is not mutated");
});

test("sources without a size stay at the end in both directions", () => {
  const rows = [row("none", null), row("a", 5 * GB), row("zero", 0), row("b", 1 * GB)];
  assert.deepEqual(ids(sortStreams(rows, "size-desc")), ["a", "b", "none", "zero"]);
  assert.deepEqual(ids(sortStreams(rows, "size-asc")), ["b", "a", "none", "zero"]);
});

test("most seeders keeps zero-seeder sources ahead of unknown counts", () => {
  const rows = [row("unknown", 1, null), row("zero", 1, 0), row("many", 1, 812), row("few", 1, 3)];
  assert.deepEqual(ids(sortStreams(rows, "seeders-desc")), ["many", "few", "zero", "unknown"]);
});

test("equal values keep their original order", () => {
  const rows = [row("first", GB, 5), row("second", GB, 5), row("third", GB, 5)];
  assert.deepEqual(ids(sortStreams(rows, "size-desc")), ["first", "second", "third"]);
  assert.deepEqual(ids(sortStreams(rows, "size-asc")), ["first", "second", "third"]);
  assert.deepEqual(ids(sortStreams(rows, "seeders-desc")), ["first", "second", "third"]);
});

test("parseSize reads plain, comma-decimal and thousands-separated sizes", () => {
  assert.equal(parseSize("700MB"), 700 * MB);
  assert.equal(parseSize("12.5 GB"), Math.round(12.5 * GB));
  assert.equal(parseSize("Inception.2010.DUAL.BDRip.2,91Gb.XviD.avi"), Math.round(2.91 * GB));
  assert.equal(parseSize("12,5 GB"), Math.round(12.5 * GB));
  assert.equal(parseSize("1,024 MB"), 1024 * MB);
  assert.equal(parseSize("1,234.5 MB"), Math.round(1234.5 * MB));
  assert.equal(parseSize("1.5 TB"), Math.round(1.5 * 1024 ** 4));
});

test("parseSize reads European sizes with dot thousands and comma decimals", () => {
  assert.equal(parseSize("1.234,56 GB"), Math.round(1234.56 * GB));
  assert.equal(parseSize("💾 2.048,5 MB"), Math.round(2048.5 * MB));
  assert.equal(parseSize("1.234 GB"), Math.round(1.234 * GB), "a lone dot stays a decimal point");
});

test("parseSize does not start a thousands group inside a filename number", () => {
  assert.equal(parseSize("Movie.2024.123,45GB"), Math.round(123.45 * GB));
  assert.equal(parseSize("Movie.2024,123 MB"), 123 * MB);
});

test("parseSize prefers the addon's size field over a size in the release name", () => {
  assert.equal(parseSize("Movie.2010.1080p.1.0GB.x264\n💾 1.07 GB 👤 12"), Math.round(1.07 * GB));
  assert.equal(parseSize("Movie.800MB.mkv\n💾 594.75 MB"), Math.round(594.75 * MB));
});

test("parseSize uses the hint and returns null when there is no size", () => {
  assert.equal(parseSize("💾 1.07 GB", 42), 42);
  assert.equal(parseSize("Movie.2010.1080p.WEB-DL"), null);
});
