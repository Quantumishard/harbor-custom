import assert from "node:assert/strict";
import test from "node:test";
import { compactUsd } from "../src/lib/format-money.ts";

test("compactUsd divides each unit by its own scale", () => {
  // TMDB absolute dollars: the billions branch must not reuse the millions divisor.
  assert.equal(compactUsd(1_796_110_000), "$1.8B");
  assert.equal(compactUsd(2_500_000_000), "$2.5B");
  assert.equal(compactUsd(250_000_000), "$250M");
  assert.equal(compactUsd(750_000_000), "$750M");
  assert.equal(compactUsd(750_000), "$750K");
});

test("compactUsd ignores missing or empty values", () => {
  assert.equal(compactUsd(undefined), null);
  assert.equal(compactUsd(0), null);
  assert.equal(compactUsd(-5), null);
});
