// Display-coordinate and title-alias caches belong to the content owner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { animeTitleKeys, rememberAnimeTitle } from "../src/lib/anime-title-key.ts";
import { subscribeAnimeCwIds } from "../src/lib/anime-cw-ids.ts";
import { cardCoords, rememberCardCoords } from "../src/lib/cw-card-coords.ts";
import { cwCacheOwnerKey, syncCwCacheOwner } from "../src/lib/cw-derived-caches.ts";
import type { LibraryItem } from "../src/lib/stremio.ts";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage as unknown as Storage,
  configurable: true,
});

const roster = (
  activeId: string,
  profiles: Array<{ id: string; isPrimary?: boolean; shareStremioWith?: string | null }>,
) => storage.setItem("harbor.profiles.v1", JSON.stringify({ activeId, profiles }));

const session = (profileId: string, userId: string) =>
  storage.setItem(
    `harbor.auth.${profileId}`,
    JSON.stringify({ authKey: `token-${userId}`, user: { _id: userId, email: "" } }),
  );

const card = (videoId: string): LibraryItem =>
  ({ _id: "tt1", type: "series", state: { video_id: videoId } }) as LibraryItem;

const checkpoint = { videoId: "tt1:1:1", season: 1, episode: 1 };

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("a profile switch pairs each profile with its own Stremio account", () => {
  storage.clear();
  roster("a", [{ id: "a", isPrimary: true }, { id: "b" }, { id: "c", shareStremioWith: "a" }]);
  session("a", "acct-a");
  session("b", "acct-b");

  assert.equal(cwCacheOwnerKey(), "stremio|a|a|acct-a");
  roster("b", [{ id: "a", isPrimary: true }, { id: "b" }, { id: "c", shareStremioWith: "a" }]);
  assert.equal(cwCacheOwnerKey(), "stremio|b|b|acct-b");
  roster("c", [{ id: "a", isPrimary: true }, { id: "b" }, { id: "c", shareStremioWith: "a" }]);
  assert.equal(cwCacheOwnerKey(), "stremio|c|a|acct-a", "a shared profile uses its source session");

  // A missing session for the selected profile must not fall back to another
  // profile's account.
  storage.removeItem("harbor.auth.b");
  roster("b", [{ id: "a", isPrimary: true }, { id: "b" }]);
  assert.equal(cwCacheOwnerKey(), "stremio|b|b|signed-out");
});

test("a Nuvio account or slot change changes the owner", () => {
  storage.clear();
  storage.setItem("harbor.account-provider", "nuvio");
  storage.setItem(
    "harbor.nuvio.state.v1",
    JSON.stringify({ activeProfileIndex: 2, session: { user: { id: "acct-n" } } }),
  );
  assert.equal(cwCacheOwnerKey(), "nuvio|nuvio-2|nuvio.v2.acct-n.slot.2");

  storage.setItem(
    "harbor.nuvio.state.v1",
    JSON.stringify({ activeProfileIndex: 3, session: { user: { id: "acct-n" } } }),
  );
  assert.equal(cwCacheOwnerKey(), "nuvio|nuvio-3|nuvio.v2.acct-n.slot.3");

  storage.setItem(
    "harbor.nuvio.state.v1",
    JSON.stringify({ activeProfileIndex: 3, session: { user: { id: "acct-m" } } }),
  );
  assert.equal(cwCacheOwnerKey(), "nuvio|nuvio-3|nuvio.v2.acct-m.slot.3");
});

test("an owner change clears both caches and notifies once", async () => {
  storage.clear();
  roster("a", [{ id: "a", isPrimary: true }, { id: "b" }]);
  session("a", "acct-a");
  session("b", "acct-b");
  syncCwCacheOwner(); // adopt account A without clearing
  await flush();

  const item = card("tt1:1:1");
  rememberCardCoords(item, { season: 1, episode: 1 });
  assert.equal(rememberAnimeTitle("tt1", "Show A", checkpoint), true);

  let notifications = 0;
  const unsubscribe = subscribeAnimeCwIds(() => {
    notifications += 1;
  });
  try {
    roster("b", [{ id: "a", isPrimary: true }, { id: "b" }]);
    syncCwCacheOwner();
    await flush();

    assert.equal(cardCoords(item), undefined);
    assert.deepEqual(animeTitleKeys("tt1", checkpoint), []);
    assert.equal(notifications, 1);

    // The same owner does not clear or notify again.
    rememberCardCoords(item, { season: 2, episode: 2 });
    syncCwCacheOwner();
    syncCwCacheOwner();
    await flush();
    assert.deepEqual(cardCoords(item), { season: 2, episode: 2 });
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
  }
});

test("a Stremio account change under the same profile clears both caches", async () => {
  storage.clear();
  roster("a", [{ id: "a", isPrimary: true }]);
  session("a", "acct-a");
  syncCwCacheOwner();
  await flush();

  const item = card("tt1:1:1");
  rememberCardCoords(item, { season: 1, episode: 1 });
  rememberAnimeTitle("tt1", "Show A", checkpoint);

  let notifications = 0;
  const unsubscribe = subscribeAnimeCwIds(() => {
    notifications += 1;
  });
  try {
    session("a", "acct-b");
    syncCwCacheOwner();
    await flush();

    assert.equal(cardCoords(item), undefined);
    assert.deepEqual(animeTitleKeys("tt1", checkpoint), []);
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
  }
});

test("a provider switch clears both caches", async () => {
  storage.clear();
  roster("a", [{ id: "a", isPrimary: true }]);
  session("a", "acct-a");
  syncCwCacheOwner();
  await flush();

  const item = card("tt1:1:1");
  rememberCardCoords(item, { season: 1, episode: 1 });
  rememberAnimeTitle("tt1", "Show A", checkpoint);
  let notifications = 0;
  const unsubscribe = subscribeAnimeCwIds(() => {
    notifications += 1;
  });
  try {
    storage.setItem("harbor.account-provider", "nuvio");
    storage.setItem(
      "harbor.nuvio.state.v1",
      JSON.stringify({ activeProfileIndex: 2, session: { user: { id: "acct-n" } } }),
    );
    syncCwCacheOwner();
    await flush();

    assert.equal(cardCoords(item), undefined);
    assert.deepEqual(animeTitleKeys("tt1", checkpoint), []);
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
  }
});

test("a Nuvio slot change clears both caches", async () => {
  storage.clear();
  storage.setItem("harbor.account-provider", "nuvio");
  storage.setItem(
    "harbor.nuvio.state.v1",
    JSON.stringify({ activeProfileIndex: 2, session: { user: { id: "acct-n" } } }),
  );
  syncCwCacheOwner();
  await flush();

  const item = card("tt1:1:1");
  rememberCardCoords(item, { season: 1, episode: 1 });
  rememberAnimeTitle("tt1", "Show A", checkpoint);
  let notifications = 0;
  const unsubscribe = subscribeAnimeCwIds(() => {
    notifications += 1;
  });
  try {
    storage.setItem(
      "harbor.nuvio.state.v1",
      JSON.stringify({ activeProfileIndex: 3, session: { user: { id: "acct-n" } } }),
    );
    syncCwCacheOwner();
    await flush();

    assert.equal(cardCoords(item), undefined);
    assert.deepEqual(animeTitleKeys("tt1", checkpoint), []);
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
  }
});

test("the owner handler listens to profile, provider and Stremio session events", () => {
  const owner = readFileSync("src/lib/cw-derived-caches.ts", "utf8");
  for (const event of [
    "harbor:active-profile-changed",
    "harbor:profiles-updated",
    "harbor:nuvio-profile-changed",
    "harbor:nuvio-state-changed",
    "harbor:account-provider-changed",
    "harbor:stremio-account-changed",
  ]) {
    assert.match(owner, new RegExp(event));
  }
  assert.match(owner, /clearCardCoords\(\)/);
  assert.match(owner, /clearAnimeTitleKeys\(\)/);
  assert.match(readFileSync("src/lib/auth.tsx", "utf8"), /harbor:stremio-account-changed/);
});
