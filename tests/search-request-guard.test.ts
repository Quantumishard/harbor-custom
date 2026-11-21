// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { settleSearchSource } from "../src/lib/search-request-guard.ts";

test("stops waiting on an obsolete query even if its transport has no cancellation", async () => {
  const old = new AbortController();
  let resolveOld!: (value: string) => void;
  const request = new Promise<string>((resolve) => {
    resolveOld = resolve;
  });
  const pending = settleSearchSource(request, "discarded", 8000, old.signal);
  old.abort();
  assert.equal(await pending, "discarded");
  resolveOld("late result");
  assert.equal(
    await settleSearchSource(Promise.resolve("new result"), "discarded", 8000),
    "new result",
  );
});
