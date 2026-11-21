import assert from "node:assert/strict";
import test from "node:test";
import type { Addon } from "../src/lib/addons.ts";
import { addonBasesForOrigin } from "../src/lib/addons.ts";
import { fetchAddonStreams } from "../src/lib/streams/addons.ts";

const torrentio: Addon = {
  manifest: {
    id: "community.torrentio",
    name: "Torrentio",
    resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    types: ["movie"],
    idPrefixes: ["tt"],
  },
  transportUrl: "https://torrentio.example/manifest.json",
};

/** A plugin's stream addon, as the plugin layer appends it to the picker's list. Its URL cannot be
 *  parsed as an HTTP manifest, which is what used to take the whole batch down with it. */
const plugin: Addon = {
  manifest: {
    id: "plugin:k3j4.uhdmovies",
    name: "UHDMovies",
    resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt", "capstan:"] }],
    types: ["movie"],
    idPrefixes: ["tt", "capstan:"],
  },
  transportUrl: "harbor-plugin://plugin:k3j4.uhdmovies",
};

test("a plugin addon in the list keeps the other addons' streams", async () => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return new Response(
      JSON.stringify({ streams: [{ name: "1080p", url: "https://cdn.example/a" }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    const streams = await fetchAddonStreams(
      [torrentio, plugin],
      { type: "movie", ids: ["tt0137523"] },
      new AbortController().signal,
    );
    assert.equal(streams.length, 1, "the normal addon's stream survives the plugin being listed");
    assert.equal(streams[0].addonId, torrentio.manifest.id);
    assert.deepEqual(requested, ["https://torrentio.example/stream/movie/tt0137523.json"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a plugin addon in the list keeps a saved origin resolvable", () => {
  // The origin of any catalogue row carries a configuration key; matching it used to parse every
  // addon in the list, plugin URLs included, and throw before the picker could run.
  assert.deepEqual(
    addonBasesForOrigin([plugin], {
      id: "community.torrentio",
      name: "Torrentio",
      configurationKey: "a".repeat(64),
    }),
    [],
  );
  // A plugin row names its catalogue base, and the addon's own URL pins the same plugin.
  assert.deepEqual(
    addonBasesForOrigin([plugin], {
      id: "plugin:k3j4.uhdmovies",
      name: "UHDMovies",
      base: "harbor-plugin://plugin:k3j4.uhdmovies/provider",
    }),
    ["harbor-plugin://plugin:k3j4.uhdmovies/provider", plugin.transportUrl],
  );
});
