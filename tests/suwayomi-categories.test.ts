// @ts-expect-error Node test types are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside the browser tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are outside the browser tsconfig.
import test from "node:test";
import ts from "typescript";

function load(path: string, mocks: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/lib/manga/${path}.ts`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", js)((id: string) => {
    assert.ok(id in mocks, `Unexpected dependency: ${id}`);
    return mocks[id];
  }, exports);
  return exports;
}

function setup(
  mode: "rest" | "graphql",
  options: { failCategories?: boolean; failCategory?: boolean; failSources?: boolean; fallback?: "rest" | "graphql" } = {},
) {
  const calls: { path: string; query?: string; variables?: any }[] = [];
  const sources = [
    { id: "7", name: "English source", lang: "en" },
    { id: "9", name: "Japanese", lang: "ja" },
  ];
  const categories = [
    { id: 7, name: "Reread", order: 2 },
    { id: 0, name: "Default", order: 0 },
    { id: 3, name: "Empty", order: 1 },
  ];
  const manga = Array.from({ length: 65 }, (_, id) => ({
    id,
    title: `Saved ${id}`,
    sourceId: "9",
  }));
  const client = {
    server: { base: "https://server.example" },
    async getJson(path: string) {
      calls.push({ path });
      if (mode !== "rest" && options.fallback !== "rest") return null;
      if (path === "/api/v1/source/list") return mode === "rest" && options.failSources ? null : sources;
      if (path === "/api/v1/category") return options.failCategories ? null : categories;
      if (path.startsWith("/api/v1/category/"))
        return options.failCategory ? null : path.endsWith("/3") ? [] : [...manga, manga[0]];
      if (path.includes("/source/7/"))
        return { mangaList: [{ id: 99, title: "Source result" }], hasNextPage: false };
      throw new Error(`Unexpected REST path: ${path}`);
    },
    async postJson(path: string, body: any) {
      calls.push({ path, ...body });
      if (mode !== "graphql" && options.fallback !== "graphql") return null;
      const { query, variables } = body;
      if (query.includes("aboutServer")) return { data: { aboutServer: { version: "test" } } };
      if (query.includes("sources {")) return mode === "graphql" && options.failSources
        ? { errors: [{ message: "source list unavailable" }] }
        : { data: { sources: { nodes: sources } } };
      if (query.includes("categories {"))
        return options.failCategories
          ? { errors: [{}] }
          : { data: { categories: { nodes: categories } } };
      if (query.includes("category(id:"))
        return options.failCategory
          ? { data: { category: null } }
          : {
              data: {
                category: { mangas: { nodes: variables.id === 3 ? [] : [...manga, manga[0]] } },
              },
            };
      if (query.includes("fetchSourceManga"))
        return {
          data: {
            fetchSourceManga: { mangas: [{ id: 99, title: "Source result" }], hasNextPage: false },
          },
        };
      throw new Error(`Unexpected GraphQL query: ${query}`);
    },
  };
  const model = load("sources/suwayomi/model", {
    "@/lib/safe-fetch": {},
    "@/lib/manga/types": { mangaThrottle: () => (fn: () => unknown) => fn() },
    "./base-url": { normalizeSuwayomiBase: (base: string) => base },
    "./auth-registry": { registerSuwayomiAuth: () => {}, suwayomiAuthFor: () => undefined },
    "./server-message": { suwayomiServerMessage: () => null },
  });
  model.makeClient = () => client;
  const rest = load("sources/suwayomi/rest", { "./model": model });
  const graphql = load("sources/suwayomi/graphql", {
    "./model": model,
    "./server-message": { cleanServerMessage: (m: string) => m },
  });
  const transport = load("sources/suwayomi/transport", {
    "./model": model,
    "./rest": rest,
    "./graphql": graphql,
    "./auth-registry": { registerSuwayomiSourceBase: () => {} },
  });
  const provider = load("sources/suwayomi/provider", {
    "./model": model,
    "./rest": rest,
    "./graphql": graphql,
    "./transport": transport,
    "./api": {},
    "@/lib/manga/plugins/adapter": {},
    "@/lib/manga/lang-filter": {
      loadMangaLangFilter: () => ["en"],
      langFilterMatches: (_: unknown, lang: string) => lang === "en",
    },
    "./source-events": { subscribeSuwayomiSourcesChanged: () => {} },
  }).makeSuwayomiProvider(client.server.base);
  return { provider, calls, rest, graphql, transport, client };
}

for (const mode of ["rest", "graphql"] as const) {
  test(`${mode}: category zero, saved order and language-independent categories coexist with sources`, async () => {
    const { provider } = setup(mode);
    assert.deepEqual(await provider.tags(), [
      { id: "category:0", name: "Default", group: "Categories" },
      { id: "category:3", name: "Empty", group: "Categories" },
      { id: "category:7", name: "Reread", group: "Categories" },
      { id: "7", name: "English source", group: "Sources" },
    ]);
  });

  test(`${mode}: complete category, search and exhaustion never call the extension browse endpoint`, async () => {
    const { provider, calls } = setup(mode);
    const list = await provider.popular(0, "category:0");
    assert.equal(list.length, 65);
    assert.equal(list[0].id, "9~0");
    assert.equal(list[64].title, "Saved 64");
    assert.deepEqual(await provider.search("  SAVED 64  ", 0, "category:7"), [list[64]]);
    assert.deepEqual(await provider.popular(0, "category:3"), []);
    const before = calls.length;
    assert.deepEqual(await provider.popular(48, "category:0"), []);
    assert.deepEqual(await provider.search("Saved", 48, "category:0"), []);
    assert.deepEqual(await provider.popular(0, "category:bad"), []);
    assert.equal(calls.length, before);
    assert.ok(
      !calls.some(
        (call) => call.path.includes("/source/7/") || call.query?.includes("fetchSourceManga"),
      ),
    );
    assert.equal((await provider.popular(0, "7"))[0].title, "Source result");
    assert.equal((await provider.search("a", 0, "7"))[0].title, "Source result");
  });

  test(`${mode}: category failure does not remove source filters or masquerade as an empty category`, async () => {
    const { provider } = setup(mode, { failCategories: true, failCategory: true });
    assert.deepEqual(await provider.tags(), [
      { id: "7", name: "English source", group: "Sources" },
    ]);
    await assert.rejects(provider.popular(0, "category:7"));
  });
}

test("aggregate categories remain owned by their server, including duplicate category IDs", async () => {
  const first = { ...setup("rest").provider, id: "first" };
  const second = { ...setup("rest").provider, id: "second" };
  let foreignCalls = 0;
  const unrelated = {
    id: "unrelated",
    tags: async () => [],
    popular: async () => {
      foreignCalls++;
      return [];
    },
  };
  const { aggregateProvider, withProviderTag } = load("sources/aggregate", {
    "@/lib/manga/sources": { aggregateSubProviders: () => [first, second, unrelated] },
  });
  const tags = await aggregateProvider.tags();
  assert.ok(tags.some((tag: any) => tag.id === "first::category:0"));
  assert.ok(tags.some((tag: any) => tag.id === "second::category:0"));
  const list = await aggregateProvider.popular(0, "second::category:0");
  assert.equal(list.length, 65);
  assert.ok(list.every((m: any) => m.id.startsWith("second::")));
  assert.equal(foreignCalls, 0);
  assert.deepEqual(
    await withProviderTag(first, "second::category:0", () => {
      throw new Error("wrong server");
    }),
    [],
  );
  assert.equal(
    (await aggregateProvider.search("Saved 64", 0, "first::category:7"))[0].id,
    "first::9~64",
  );
});

test("failed Suwayomi source discovery does not cache category-only tags", async () => {
  for (const mode of ["rest", "graphql"] as const) {
    const { provider } = setup(mode, { failSources: true });
    await assert.rejects(provider.tags(), /suwayomi_(rest|graphql)_sources_unavailable/);
  }
});

test("source discovery falls back from REST to GraphQL and from GraphQL to REST", async () => {
  for (const mode of ["rest", "graphql"] as const) {
    const fallback = mode === "rest" ? "graphql" : "rest";
    const { client, transport, provider } = setup(mode, { failSources: true, fallback });
    const sources = await transport.loadSources(client, mode);
    assert.deepEqual(sources.map((source: { id: string }) => source.id), ["7", "9"]);
    assert.ok((await provider.tags()).some((tag: { id: string }) => tag.id === "7"));
  }
});

test("GraphQL source listing works without the optional isLocal schema field", async () => {
  const { graphql, client } = setup("graphql");
  const sources = await graphql.gqlSources({
    ...client,
    postJson: async (_path: string, { query }: { query: string }) => {
      assert.doesNotMatch(query, /isLocal/);
      return { data: { sources: { nodes: [
        { id: "0", name: "Local source", lang: "localsourcelang" },
        { id: "7", name: "English source", lang: "en" },
      ] } } };
    },
  });
  assert.deepEqual(sources.map((source: { isLocal: boolean }) => source.isLocal), [true, false]);
});

test("malformed source responses are errors, but an explicitly empty REST list is valid", async () => {
  const { rest, graphql, client } = setup("rest");
  await assert.rejects(rest.restSources({ ...client, getJson: async () => null }), /rest_sources_unavailable/);
  await assert.rejects(graphql.gqlSources({ ...client, postJson: async () => ({ errors: [{ message: "failure" }] }) }),
    /graphql_sources_unavailable/);
  assert.deepEqual(await rest.restSources({ ...client, getJson: async () => [] }), []);
});

test("language-filter refresh retains the last good extension filters while loading", () => {
  const file = readFileSync(new URL("../src/views/manga/manga-browse/filters.tsx", import.meta.url), "utf8");
  assert.match(file, /subscribeMangaLangFilter\(\(\) => load\(\)\)/);
  assert.match(file, /console\.warn\("\[manga\] filter list refresh failed", err\)/);
  assert.match(file, /retryTimer = window\.setTimeout\(\(\) => load\(undefined, true\), delay\)/);
});
