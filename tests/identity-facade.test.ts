import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  clearIdentityCache, clearIdentityData, ensureIdentityPack, identifyBatch, identityBundle,
} from "../src/lib/identity/index.ts";
import { identityCardKey, warmIdentityCards } from "../src/lib/identity/card-grouping.ts";
import { setIdentityInvoker } from "../src/lib/identity/client.ts";
import { resetIdentityFlags, setIdentityFlags } from "../src/lib/identity/flags.ts";
import {
  clearIdentityShadowLog,
  identityShadowLog,
  recordIdentityShadow,
} from "../src/lib/identity/shadow.ts";

function reset(): void {
  resetIdentityFlags();
  setIdentityInvoker(null);
  clearIdentityCache();
  clearIdentityShadowLog();
}

test("identifyBatch is provisional and offline when the feature flags are off", async () => {
  reset();
  let calls = 0;
  setIdentityInvoker(async () => {
    calls += 1;
    return [];
  });

  const result = await identifyBatch(["kitsu:49847"]);

  assert.equal(calls, 0);
  assert.equal(result.get("kitsu:49847")?.provisional, true);
  assert.equal(result.get("kitsu:49847")?.entry, null);
});

test("identifyBatch resolves, caches, and falls back for unknown ids", async () => {
  reset();
  setIdentityFlags({ pack: true });
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  setIdentityInvoker(async (command, args) => {
    calls.push({ command, args });
    return [
      { id: "kitsu:49847", entry: 7, title: "Steel Ball Run", provisional: false },
      { id: "mal:14719", entry: null, title: null, provisional: true },
    ];
  });

  const first = await identifyBatch(["kitsu:49847", "mal:14719", "tt2359704"]);
  assert.equal(first.get("kitsu:49847")?.entry, 7);
  assert.equal(first.get("mal:14719")?.provisional, true);
  assert.equal(first.get("tt2359704")?.provisional, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, { ids: ["kitsu:49847", "mal:14719", "tt2359704"] });

  const second = await identifyBatch(["kitsu:49847"]);
  assert.equal(second.get("kitsu:49847")?.entry, 7);
  assert.equal(calls.length, 1, "a resolved id is served from the hot cache");
});

test("a failing identity command degrades to provisional instead of throwing", async () => {
  reset();
  setIdentityFlags({ pack: true });
  setIdentityInvoker(async () => {
    throw new Error("tauri unavailable");
  });

  const result = await identifyBatch(["kitsu:49847"]);

  assert.equal(result.get("kitsu:49847")?.provisional, true);
});

test("identityBundle is null when disabled and returns the Rust bundle when enabled", async () => {
  reset();
  assert.equal(await identityBundle("kitsu:49847"), null);

  setIdentityFlags({ pack: true });
  setIdentityInvoker(async (command, args) => {
    assert.equal(command, "identity_entry_bundle");
    assert.deepEqual(args, { key: "kitsu:49847" });
    return {
      entry: 7,
      title: "Steel Ball Run",
      mediaType: "ONA",
      episodes: 1,
      aliases: [{ scheme: "kitsu", id: "49847" }],
      related: [{ entry: 3, title: "JoJo 2012" }],
      windows: [],
    };
  });

  const bundle = await identityBundle("kitsu:49847");
  assert.equal(bundle?.entry, 7);
  assert.equal(bundle?.related[0]?.title, "JoJo 2012");
});

test("shadow observations are bounded and never mutate behavior", () => {
  reset();
  for (let i = 0; i < 120; i++) {
    recordIdentityShadow({ at: i, ids: [`kitsu:${i}`], resolved: 0, provisional: [`kitsu:${i}`] });
  }
  const log = identityShadowLog();
  assert.equal(log.length, 100);
  assert.equal(log[0]?.at, 20);
});


test("routine fresh-pack check preserves card-group keys; a real pack replacement invalidates them", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  const base = {
    ready: true, dbBytes: 123456, packVersion: "pack-a", upstreamSha256: "hash-a",
    builtAt: 10_000, entries: 250, windows: 75, schema: 1,
  };
  let installed = base;
  let incoming = base;
  const seen: string[] = [];
  setIdentityInvoker(async (command: string, args: any) => {
    seen.push(command);
    if (command === "identity_status") return installed;
    if (command === "identity_ensure_pack") {
      installed = incoming;
      return installed;
    }
    if (command === "identity_card_hints") return args.ids.map((id: string) => ({
      id, entry: 1, title: "JoJo", mediaType: "TV",
      cardKey: "tvdb:262954", tvdb: 262954, tmdb: 45790,
      season: 1, offset: 0, provisional: false,
    }));
    throw new Error(`unexpected identity command ${command}`);
  });
  await warmIdentityCards([{ _id: "kitsu:49847" }]);
  assert.equal(identityCardKey("kitsu:49847"), "tvdb:262954");
  assert.equal((await ensureIdentityPack(false))?.ready, true);
  assert.equal(identityCardKey("kitsu:49847"), "tvdb:262954",
    "ready means the pack is usable, not necessarily replaced");
  assert.deepEqual(seen.slice(-2), ["identity_status", "identity_ensure_pack"]);

  incoming = { ...base, packVersion: "pack-b", upstreamSha256: "hash-b", builtAt: 20_000 };
  await ensureIdentityPack(true);
  assert.equal(identityCardKey("kitsu:49847"), null,
    "a confirmed install must clear stale provider-show grouping keys");
  reset();
});


test("identity pack removal serializes behind the same import lock as refresh", () => {
  const source = readFileSync(new URL("../src-tauri/src/identity/commands.rs", import.meta.url), "utf8");
  assert.match(source, /pub async fn identity_clear_data\(/);
  assert.match(source,
    /pub async fn identity_clear_data\([\s\S]*?let _import = state\.import\.lock\(\)\.await;[\s\S]*?state\s*\.conn\s*\.lock/);
  assert.match(source,
    /pub async fn identity_ensure_pack\([\s\S]*?let _import = state\.import\.lock\(\)\.await;/);
});


test("failed pack removal never invalidates still-installed card identities", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  setIdentityInvoker(async (command: string, args: any) => {
    if (command === "identity_card_hints") return args.ids.map((id: string) => ({
      id, entry: 1, title: "JoJo", mediaType: "TV",
      cardKey: "tvdb:262954", tvdb: 262954, tmdb: 45790,
      season: 1, offset: 0, provisional: false,
    }));
    if (command === "identity_clear_data") return null;
    throw new Error(`unexpected identity command ${command}`);
  });
  await warmIdentityCards([{ _id: "kitsu:49847" }]);
  assert.equal(identityCardKey("kitsu:49847"), "tvdb:262954");
  assert.equal(await clearIdentityData(), null);
  assert.equal(identityCardKey("kitsu:49847"), "tvdb:262954");
  reset();
});
