import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

type QueueFixture = {
  id: string;
  meta: {
    id: string;
    name: string;
    type: "movie" | "series";
    poster?: string;
  };
  episode?: {
    season: number;
    episode: number;
    name?: string;
  };
  addedAt: number;
};

async function renderCard(queue: QueueFixture[], resumeItem: QueueFixture) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://fixture.invalid",
  });

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const empty = () => null;
  const dependencies = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": {
      ListVideo: empty,
      Play: empty,
      X: empty,
    },
    "@/hooks/use-start-queue": {
      useStartQueue: () => () => true,
    },
    "@/lib/i18n": {
      useT: () => (key: string) => key,
    },
    "@/lib/queue": {
      useQueue: () => queue,
      useQueueResumeItem: () => resumeItem,
      queueClear: () => {},
    },
    "./queue-continue-card.css": {},
    "./queue-clear-confirm": {
      QueueClearConfirm: empty,
    },
    "./queue-continue-title": {
      QueueContinueTitle: ({ text }: { text: string }) =>
        React.createElement("span", { "data-queue-title": "" }, text),
    },
  };

  const output = ts.transpileModule(
    readFileSync("src/components/queue-basket/queue-continue-card.tsx", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;

  const api: Record<string, React.ComponentType> = {};

  new Function("require", "exports", output)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name as keyof typeof dependencies];
  }, api);

  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);

  await React.act(() => root.render(React.createElement(api.QueueContinueCard)));

  return {
    dom,
    cleanup: async () => {
      await React.act(() => root.unmount());
      dom.window.close();
    },
  };
}

test("continue queue identifies the current episode and prioritizes its poster", async () => {
  const current: QueueFixture = {
    id: "current",
    meta: {
      id: "show",
      name: "The Show",
      type: "series",
      poster: "/current.jpg",
    },
    episode: {
      season: 2,
      episode: 3,
      name: "The Long Episode Title",
    },
    addedAt: 2,
  };

  const queue: QueueFixture[] = [
    {
      id: "previous",
      meta: {
        id: "previous",
        name: "Previous",
        type: "movie",
        poster: "/previous.jpg",
      },
      addedAt: 1,
    },
    current,
    {
      id: "next-a",
      meta: {
        id: "next-a",
        name: "Next A",
        type: "movie",
        poster: "/next-a.jpg",
      },
      addedAt: 3,
    },
    {
      id: "next-a-duplicate",
      meta: {
        id: "next-a-duplicate",
        name: "Next A Duplicate",
        type: "movie",
        poster: "/next-a.jpg",
      },
      addedAt: 4,
    },
    {
      id: "next-b",
      meta: {
        id: "next-b",
        name: "Next B",
        type: "movie",
        poster: "/next-b.jpg",
      },
      addedAt: 5,
    },
    {
      id: "next-c",
      meta: {
        id: "next-c",
        name: "Next C",
        type: "movie",
        poster: "/next-c.jpg",
      },
      addedAt: 6,
    },
    {
      id: "next-d",
      meta: {
        id: "next-d",
        name: "Next D",
        type: "movie",
        poster: "/next-d.jpg",
      },
      addedAt: 7,
    },
  ];

  const h = await renderCard(queue, current);

  try {
    const title = document.querySelector("[data-queue-title]");
    const currentPoster = document.querySelector(".queue-continue-card__poster--current img");
    const posterGroup = document.querySelector(".queue-continue-card__posters");
    const nextPosters = [
      ...document.querySelectorAll(
        ".queue-continue-card__poster:not(.queue-continue-card__poster--current) img",
      ),
    ].map((image) => image.getAttribute("src"));

    assert.equal(title?.textContent, "The Show · S2 E3 · The Long Episode Title");
    assert.equal(currentPoster?.getAttribute("src"), "/current.jpg");
    assert.equal(posterGroup?.getAttribute("data-next-count"), "3");
    assert.deepEqual(nextPosters, ["/next-a.jpg", "/next-b.jpg", "/next-c.jpg"]);

    const play = document.querySelector<HTMLButtonElement>(".queue-continue-card__play");
    assert.match(play?.getAttribute("aria-label") ?? "", /^Continue your watching queue\?/);
    assert.match(
      play?.getAttribute("aria-label") ?? "",
      /The Show · S2 E3 · The Long Episode Title/,
    );
  } finally {
    await h.cleanup();
  }
});
