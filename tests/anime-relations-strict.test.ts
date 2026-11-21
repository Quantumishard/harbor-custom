// @ts-expect-error Node test types are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside the browser tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are outside the browser tsconfig.
import test from "node:test";
import ts from "typescript";

function load(request: (id: number) => Promise<unknown>) {
  const source = readFileSync(new URL("../src/lib/anilist/relations.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", code)((id: string) => {
    if (id === "./client")
      return { anilistRequest: (_q: string, vars: { id: number }) => request(vars.id) };
    if (id === "@/lib/providers/anime-mapping") return { kitsuToAnilist: async () => null };
    assert.fail(`Unexpected import: ${id}`);
  }, exports);
  return exports as {
    animeRelations: (id: number, opts?: { strict?: boolean }) => Promise<Array<{ id: number }>>;
  };
}

const sequelEdge = (id: number) => ({
  Media: {
    relations: {
      edges: [
        {
          relationType: "SEQUEL",
          node: {
            id,
            format: "TV",
            title: { english: `Sequel ${id}`, romaji: null, userPreferred: null },
          },
        },
      ],
    },
  },
});

test("strict traversal rejects when the root request fails", async () => {
  const api = load(async () => {
    throw new Error("network down");
  });
  await assert.rejects(api.animeRelations(100, { strict: true }), /unavailable/);
  // Best effort still answers an empty list.
  assert.deepEqual(await api.animeRelations(101), []);
});

test("strict traversal rejects when a franchise entry request fails", async () => {
  let call = 0;
  const api = load(async () => {
    call += 1;
    // Root resolves to one sequel; that sequel's own request then fails.
    if (call === 1) return sequelEdge(200);
    throw new Error("network down");
  });
  await assert.rejects(api.animeRelations(100, { strict: true }), /unavailable/);
});

test("strict traversal accepts a complete franchise walk", async () => {
  let call = 0;
  const api = load(async () => {
    call += 1;
    return call === 1 ? sequelEdge(200) : { Media: { relations: { edges: [] } } };
  });
  const relations = await api.animeRelations(100, { strict: true });
  assert.deepEqual(
    relations.map((r) => r.id),
    [200],
  );
});
