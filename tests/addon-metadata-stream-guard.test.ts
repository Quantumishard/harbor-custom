import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { addonBaseUrl } from "../src/lib/addon-url.ts";
import type { Addon } from "../src/lib/addons.ts";
import { clearAddonStreamCache, fetchAddonStreams } from "../src/lib/streams/addons.ts";

const metadata: Addon = {
  manifest: {
    id: "com.linvo.cinemeta",
    name: "Cinemeta",
    resources: ["catalog", "meta", "addon_catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
  },
  transportUrl: "https://v3-cinemeta.strem.io/manifest.json",
};

const streams: Addon = {
  manifest: {
    id: "com.example.streams",
    name: "Streams",
    resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    types: ["movie"],
    idPrefixes: ["tt"],
  },
  transportUrl: "https://stream.example/manifest.json",
};

async function request(
  forced: Array<{ base: string; id: string }> | undefined,
): Promise<{ hits: string[]; failed: string[] }> {
  const original = globalThis.fetch;
  const hits: string[] = [];
  let failed: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    hits.push(String(input));
    return new Response(
      JSON.stringify({ streams: [{ name: "1080p", url: "https://cdn.example/x" }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    clearAddonStreamCache();
    await fetchAddonStreams(
      [metadata, streams],
      { type: "movie", ids: ["tt0480249"] },
      new AbortController().signal,
      undefined,
      (progress) => {
        failed = (progress.failures ?? []).map((f) => f.name);
      },
      undefined,
      undefined,
      forced,
    );
  } finally {
    globalThis.fetch = original;
    clearAddonStreamCache();
  }
  return { hits, failed };
}

test("metadata-only addons are never asked for streams", async () => {
  const { hits, failed } = await request(undefined);
  assert.deepEqual(failed, []);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /stream\.example/);
});

test("a metadata origin cannot force a stream query to itself", async () => {
  const forced = [{ base: addonBaseUrl(metadata.transportUrl), id: "tt0480249" }];
  const { hits, failed } = await request(forced);
  assert.deepEqual(failed, []);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /stream\.example/);
});
