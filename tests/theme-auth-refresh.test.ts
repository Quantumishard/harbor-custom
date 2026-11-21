import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function harness() {
  const values = new Map<string, string>();
  let failSessionWrites = false;
  const view = new EventTarget();
  Object.assign(globalThis, {
    window: view,
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
    },
  });
  const select = (id) => {
    values.set(
      "harbor.profiles.v1",
      JSON.stringify({ activeId: id, profiles: [{ id: "a", isPrimary: true }, { id: "b" }] }),
    );
    view.dispatchEvent(new Event("harbor:profiles-updated"));
  };
  select("a");
  const pending: Array<(response: Response) => void> = [];
  const dependencies = {
    "@/lib/config/endpoints": { HARBOR_API_BASE: "https://fixture.invalid" },
    "@/lib/safe-fetch": {
      safeFetch: async () => new Promise<Response>((resolve) => pending.push(resolve)),
    },
    "@/lib/storage-recovery": {
      persistCritical: (key: string, value: string) => {
        if (failSessionWrites) return false;
        values.set(key, value);
        return true;
      },
    },
  };
  const output = ts.transpileModule(
    readFileSync(new URL("../src/lib/theme-auth.ts", import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  );
  const exports = {};
  new Function("require", "exports", output.outputText)((name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  const auth = exports as typeof import("../src/lib/theme-auth.ts");
  const login = (id: string) =>
    auth.applyAuthResult({
      token: `fixture-access-${id}`,
      refresh: `fixture-refresh-${id}`,
      user: { id, username: id, handle: id },
    });
  const resolve = (index, name) =>
    pending[index](
      Response.json({ token: `fixture-renewed-${name}`, refresh: `fixture-rotated-${name}` }),
    );
  return {
    auth,
    select,
    login,
    resolve,
    pending,
    values,
    blockSessionWrites: (blocked: boolean) => {
      failSessionWrites = blocked;
    },
  };
}

test("a failed durable write rejects Harbor login instead of losing the session on restart", () => {
  const h = harness();
  h.blockSessionWrites(true);
  assert.throws(() => h.login("author-a"), /Could not save your Harbor sign-in/);
  assert.equal(h.auth.currentAuthor(), null);
  assert.equal(h.values.has("harbor.theme-session.a"), false);

  h.blockSessionWrites(false);
  h.login("author-a");
  assert.equal(JSON.parse(h.values.get("harbor.theme-session.a")!).user.id, "author-a");
  h.auth.reloadSession(true);
  assert.equal(h.auth.currentAuthor()?.id, "author-a");
});

test("a refresh cannot claim success when its rotated credentials failed to persist", async () => {
  const h = harness();
  h.login("author-a");
  const refresh = h.auth.refreshToken();
  h.blockSessionWrites(true);
  h.resolve(0, "author-a");
  assert.equal(await refresh, false);
  assert.equal(h.auth.authToken(), "fixture-access-author-a");
  assert.equal(JSON.parse(h.values.get("harbor.theme-session.a")!).refresh, "fixture-refresh-author-a");
});

test("a token refresh cannot apply an old profile's credentials to a newly active account", async () => {
  const h = harness();
  h.login("author-a");
  const refresh = h.auth.refreshToken();
  h.select("b");
  h.login("author-b");
  h.resolve(0, "old-a");
  assert.equal(await refresh, false);
  assert.equal(h.auth.authToken(), "fixture-access-author-b");
  assert.equal(h.auth.currentAuthor()?.id, "author-b");
  assert.equal(
    JSON.parse(h.values.get("harbor.theme-session.a")!).token,
    "fixture-renewed-old-a",
    "rotation is retained only in the unchanged origin profile",
  );
});

test("refresh deduplicates one session but does not share another profile's in-flight request", async () => {
  const h = harness();
  h.login("author-a");
  const a = h.auth.refreshToken();
  const sameA = h.auth.refreshToken();
  assert.equal(h.pending.length, 1, "concurrent callers share the transport request");
  h.select("b");
  h.login("author-b");
  const b = h.auth.refreshToken();
  assert.equal(h.pending.length, 2);
  h.resolve(0, "a");
  assert.equal(await a, false);
  assert.equal(await sameA, false);
  const sameB = h.auth.refreshToken();
  assert.equal(
    h.pending.length,
    2,
    "old completion cannot clear the new session's pending refresh",
  );
  h.resolve(1, "b");
  assert.equal(await b, true);
  assert.equal(await sameB, true);
  assert.equal(h.auth.authToken(), "fixture-renewed-b");
});

test("a harmless author metadata update preserves a valid refresh", async () => {
  const h = harness();
  h.login("author-a");
  const pending = h.auth.refreshToken();
  h.auth.applyAvatarUrl("https://fixture.invalid/avatar.png");
  h.resolve(0, "a");
  assert.equal(await pending, true);
  assert.equal(h.auth.authToken(), "fixture-renewed-a");
  assert.equal(h.auth.currentAuthor()?.avatar, "https://fixture.invalid/avatar.png");
});

test("a new login for the same author invalidates the earlier refresh", async () => {
  const h = harness();
  h.login("author-a");
  const pending = h.auth.refreshToken();
  h.auth.applyAuthResult({
    token: "fixture-new-login",
    refresh: "fixture-new-refresh",
    user: { id: "author-a", username: "author-a", handle: "author-a" },
  });
  h.resolve(0, "old");
  assert.equal(await pending, false);
  assert.equal(h.auth.authToken(), "fixture-new-login");
});
