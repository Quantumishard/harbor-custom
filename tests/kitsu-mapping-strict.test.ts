// @ts-expect-error Node test types are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside the browser tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are outside the browser tsconfig.
import test from "node:test";
import ts from "typescript";

function load(options: { request: () => Promise<unknown>; strictRequest: () => Promise<unknown> }) {
  const source = readFileSync(
    new URL("../src/lib/providers/kitsu-mapping.ts", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", code)((id: string) => {
    if (id === "./kitsu")
      return {
        kitsuMappingRequest: () => options.request(),
        kitsuMappingRequestStrict: () => options.strictRequest(),
      };
    assert.fail(`Unexpected import: ${id}`);
  }, exports);
  return exports as {
    kitsuExternalIds: (
      id: number,
      maxAge?: number,
      strict?: boolean,
    ) => Promise<{ anilist?: number; mal?: number } | null>;
  };
}

const doc = {
  data: [
    {
      type: "mappings",
      attributes: { externalSite: "anilist/anime", externalId: "5" },
      relationships: { item: { data: { type: "anime", id: "1" } } },
    },
  ],
  links: { next: null },
  meta: { count: 1 },
};

test("strict Kitsu mapping surfaces an outage instead of a missing mapping", async () => {
  const api = load({
    request: async () => null,
    strictRequest: async () => {
      throw new Error("kitsu unavailable");
    },
  });
  await assert.rejects(api.kitsuExternalIds(1, undefined, true), /unavailable/);
  // Ordinary callers keep the null they already handle.
  assert.equal(await api.kitsuExternalIds(1), null);
});

test("strict Kitsu mapping still treats a 404 as a confirmed absence", async () => {
  const api = load({ request: async () => null, strictRequest: async () => null });
  assert.equal(await api.kitsuExternalIds(2, undefined, true), null);
});

test("strict Kitsu mapping parses a complete answer", async () => {
  const api = load({ request: async () => doc, strictRequest: async () => doc });
  assert.deepEqual(await api.kitsuExternalIds(1, undefined, true), { anilist: 5 });
});
