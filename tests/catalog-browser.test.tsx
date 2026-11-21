import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import type { BrowseCatalog } from "../src/lib/catalog-browse";

function loadCatalogComponent(file: string, mocks: Record<string, unknown>) {
  const module = { exports: {} as any };
  const source = readFileSync(new URL(`../src/views/catalogs/${file}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  new Function("require", "module", "exports", outputText)(
    (name: string) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

test("catalog browsing preserves genre selection and pagination and resets on catalog/type changes", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const opened: any[] = [];
  const fetched: any[] = [];
  const mocks: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": jsx,
    "lucide-react": { ChevronDown: () => <svg /> },
    "@/components/icons/search-icon": { Search: () => <svg /> },
    "@/lib/i18n": { useT: () => (key: string) => key },
    "@/lib/session-state": {
      useSessionState: (_key: string, initial: unknown) => React.useState(initial),
    },
    "@/lib/view": { useView: () => ({ openGrid: (grid: any) => opened.push(grid) }) },
    "@/lib/catalog-browse": {
      catalogTypeLabelKey: (type: string) => ({ movie: "Movies", series: "Series" })[type],
      browseFetcher: (catalog: BrowseCatalog, genre: string | null) => async (page: number) => {
        fetched.push([catalog.key, genre, page]);
        return [];
      },
    },
  };
  const { CatalogBrowser } = loadCatalogComponent("catalog-browser.tsx", mocks);
  const catalog = (key: string, type: string, genres: string[]): BrowseCatalog => ({
    key,
    type,
    genres,
    name: key,
    id: key,
    addonName: "Addon",
    base: "https://example.test",
    genreExtra: genres.length ? "Genre" : null,
  });
  const catalogs = [
    catalog("Popular", "movie", ["Comedy"]),
    catalog("Latest", "movie", []),
    catalog("Shows", "series", ["Drama"]),
  ];
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (items: BrowseCatalog[]) =>
    React.act(() => root.render(<CatalogBrowser catalogs={items} />));
  const click = async (prefix: string) => {
    const button = [...dom.window.document.querySelectorAll("button")].find(
      (entry) =>
        entry.textContent?.startsWith(prefix) ||
        [...entry.querySelectorAll("span")].some((span) => span.textContent === prefix),
    );
    assert.ok(button, prefix);
    await React.act(() => button.click());
  };
  try {
    await render(catalogs);
    await click("Genre");
    await click("Comedy");
    await click("Browse");
    assert.equal(opened.at(-1).title, "Popular · Comedy");
    await opened.at(-1).fetcher(2);
    assert.deepEqual(fetched.at(-1), ["Popular", "Comedy", 2]);
    await click("Catalog");
    await click("Latest");
    assert.ok(
      ![...dom.window.document.querySelectorAll("button")].some((entry) =>
        entry.textContent?.startsWith("Genre"),
      ),
    );
    await click("Browse");
    await opened.at(-1).fetcher(1);
    assert.deepEqual(fetched.at(-1), ["Latest", null, 1]);
    await click("Type");
    await click("Series");
    await click("Browse");
    assert.equal(opened.at(-1).title, "Shows");
    await render([catalogs[0]]);
    await click("Browse");
    assert.equal(opened.at(-1).title, "Popular");
    await render([]);
    assert.equal(dom.window.document.querySelectorAll("button").length, 0);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
  }
});

test("Catalogs owns the browser alongside shelf management; Discover no longer mounts it", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../src/views/${path}`, import.meta.url), "utf8");
  assert.match(read("catalogs.tsx"), /<CatalogBrowser catalogs=\{catalogs\}/);
  assert.match(read("catalogs.tsx"), /<CatalogManageList/);
  assert.match(read("catalogs.tsx"), /<CatalogShelf/);
  assert.doesNotMatch(read("discover.tsx"), /CatalogBrowser|section-catalog/);
});

test("a catalog shelf shares in-flight pagination and advances past duplicate provider entries", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  const previousObserver = globalThis.IntersectionObserver;
  let intersect: (() => void) | undefined;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      intersect = () =>
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
    }
    observe() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IntersectionObserver: Observer,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const requests: Array<{
    page: number;
    offset?: number;
    resolve: (entries: { id: string }[]) => void;
  }> = [];
  const { CatalogShelf } = loadCatalogComponent("catalog-shelf.tsx", {
    react: React,
    "react/jsx-runtime": jsx,
    "@/components/feed-shelf": {
      FeedShelf: ({ items, onEndReached }: any) => (
        <button onClick={onEndReached}>
          {items?.map((item: { id: string }) => item.id).join(",")}
        </button>
      ),
    },
    "@/lib/anime-hide": { useHideAnimeMetas: (items: unknown) => items },
    "@/lib/view": { useView: () => ({ openGrid: () => {} }) },
    "@/lib/i18n": { useT: () => (key: string) => key },
    "@/lib/catalog-browse": {
      catalogTypeLabelKey: () => "Movies",
      browseFetcher: () => (page: number, offset?: number) =>
        new Promise<{ id: string }[]>((resolve) => requests.push({ page, offset, resolve })),
    },
  });
  const catalog: BrowseCatalog = {
    key: "test",
    type: "movie",
    genres: [],
    name: "Test",
    id: "test",
    addonName: "Addon",
    base: "https://example.test",
    genreExtra: null,
  };
  const root = createRoot(document.getElementById("root")!);
  const clickEnd = () => document.querySelector("button")?.click();
  const resolvePage = (index: number, ids: string[]) =>
    React.act(async () => {
      requests[index].resolve(ids.map((id) => ({ id })));
    });
  try {
    await React.act(() => root.render(<CatalogShelf catalog={catalog} />));
    await React.act(() => {
      intersect?.();
      intersect?.();
      clickEnd();
    });
    assert.deepEqual(
      requests.map(({ page, offset }) => [page, offset]),
      [[1, undefined]],
    );
    await resolvePage(0, ["a", "b"]);
    await React.act(() => {
      clickEnd();
      clickEnd();
    });
    assert.deepEqual(
      requests.map(({ page, offset }) => [page, offset]),
      [
        [1, undefined],
        [2, 2],
      ],
    );
    await resolvePage(1, ["b", "c", "c"]);
    assert.equal(document.querySelector("button")?.textContent, "a,b,c");
    await React.act(clickEnd);
    assert.equal(requests[2].page, 3);
    assert.equal(requests[2].offset, 5);
    await resolvePage(2, []);
    await React.act(clickEnd);
    assert.equal(requests[3].page, 3);
    assert.equal(requests[3].offset, 5);
    await React.act(() => root.render(<CatalogShelf catalog={{ ...catalog, key: "other" }} />));
    await React.act(() => intersect?.());
    await resolvePage(3, ["stale"]);
    await resolvePage(4, ["fresh"]);
    assert.equal(document.querySelector("button")?.textContent, "fresh");
  } finally {
    await React.act(() => root.unmount());
    globalThis.IntersectionObserver = previousObserver;
    dom.window.close();
  }
});
