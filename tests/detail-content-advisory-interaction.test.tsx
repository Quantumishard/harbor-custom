import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import {
  loadDetailCustomization,
  moveSection,
  orderedSectionKeys,
  resetDetailCustomization,
  saveDetailCustomization,
  toggleSectionHidden,
} from "../src/lib/detail-customization.ts";

// Load the real components and resolver with isolated network and context mocks.
function load(path: string, dependencies: Record<string, unknown>) {
  const compiled = ts.transpileModule(
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected import from ${path}: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

test("a hidden Content Advisory on a TMDB title can be shown, with no IMDb requests until expansion", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.invalid" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  localStorage.setItem(
    "harbor.detailLayout",
    JSON.stringify({ order: [], hidden: ["parentsGuide"] }),
  );
  localStorage.removeItem("harbor.content-advisory.keep-expanded");

  let resolveImdb!: (id: string | null) => void;
  const imdbAnswer = new Promise<string | null>((resolve) => (resolveImdb = resolve));
  let imdbLookups = 0;
  const guideFetches: string[] = [];
  let resolveGuide!: (guide: null) => void;
  const guideAnswer = new Promise<null>((resolve) => (resolveGuide = resolve));
  const icon = () => null;
  const icons = new Proxy({}, { get: () => icon });
  const translator = { useT: () => (key: string) => key };
  const settings = {
    useSettings: () => ({
      settings: { tmdbKey: "fixture-tmdb-key", contentAdvisoryTheme: "monochrome" },
    }),
  };
  const customization = {
    loadDetailCustomization,
    moveSection,
    orderedSectionKeys,
    resetDetailCustomization,
    saveDetailCustomization,
    toggleSectionHidden,
  };
  const imdbResolver = load("src/views/play-picker/use-imdb-id.ts", {
    react: React,
    "@/lib/cinemeta": {
      narrowMediaType: () => "movie",
      isAddonNativeMeta: () => false,
    },
    "@/lib/providers/anime-kitsu-addon": { animeKitsuMeta: async () => null },
    "@/lib/providers/anime-mapping": {
      externalToKitsu: async () => null,
      kitsuToImdb: async () => null,
    },
    "@/lib/providers/tmdb": {
      tmdbImdbId: () => {
        imdbLookups++;
        return imdbAnswer;
      },
    },
    "./picker-utils": { cinemetaImdbFallback: async () => null },
  }).useImdbId;

  const useParentsGuide = load("src/views/detail/use-parents-guide.ts", {
    react: React,
    "@/lib/providers/imdb-parents-guide": {
      getParentsGuideCacheEntry: () => undefined,
      fetchImdbParentsGuide: (id: string) => {
        guideFetches.push(id);
        return guideAnswer;
      },
    },
  }).useParentsGuide;

  const ParentsGuidePanel = load("src/views/detail/parents-guide-panel.tsx", {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": icons,
    "@/lib/window": { openUrl: () => {} },
    "@/lib/i18n": translator,
    "@/lib/settings": settings,
    "@/lib/providers/imdb-parents-guide": { severityColorStyle: () => ({}) },
    "./use-parents-guide": { useParentsGuide },
    "../play-picker/use-imdb-id": { useImdbId: imdbResolver },
  }).ParentsGuidePanel;

  const ContentRails = load("src/views/detail/content-rails.tsx", {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": icons,
    "@/components/hover-tooltip": {
      HoverTooltip: ({ children }: { children: React.ReactNode }) => children,
    },
    "@/components/lazy-mount": {
      LazyMount: ({ children }: { children: React.ReactNode }) => children,
    },
    "@/lib/i18n": translator,
    "@/lib/detail-customization": customization,
  }).ContentRails;

  const DetailLayoutEditor = load("src/views/detail/layout-editor.tsx", {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": icons,
    "@/components/icons/pencil-outline": { PencilOutlineIcon: icon },
    "@/lib/detail-customization": customization,
    "@/lib/i18n": translator,
    "@/lib/use-reduced-motion": { useReducedMotion: () => true },
    "./content-rails": { ContentRails },
    "./layout-editor.css": {},
  }).DetailLayoutEditor;

  const meta = { id: "tmdb:movie:42", name: "Fixture film", type: "movie" };
  const sections = [
    { key: "cast", label: "Cast", node: React.createElement("div", null, "Cast") },
    {
      key: "parentsGuide",
      label: "Content Advisory",
      node: React.createElement(ParentsGuidePanel, { meta, imdbId: null }),
    },
  ];
  const root = createRoot(document.getElementById("root")!);
  const click = async (button: Element | null) => {
    assert.ok(button, "expected button was missing");
    await React.act(async () => (button as HTMLElement).click());
  };

  try {
    await React.act(async () => root.render(React.createElement(DetailLayoutEditor, { sections })));
    assert.equal(document.querySelector('[data-section="parentsGuide"]'), null);
    assert.equal(imdbLookups, 0);

    await click(document.querySelector('button[aria-label="Customize layout"]'));
    const hiddenRail = document.querySelector('[data-section="parentsGuide"]');
    assert.ok(hiddenRail, "hidden rail must remain available in layout editing");
    assert.equal(hiddenRail.querySelector("[data-testid='parents-guide-section']"), null);
    await click(hiddenRail.querySelector('button[aria-label="Show"]'));

    assert.ok(document.querySelector("[data-testid='parents-guide-section']"));
    assert.equal(imdbLookups, 0, "restoring a collapsed rail must not start IMDb lookups");
    assert.equal(guideFetches.length, 0);

    await click(
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Expand") ?? null,
    );
    assert.equal(imdbLookups, 1, "expansion should start exactly one IMDb lookup");
    assert.match(document.body.textContent ?? "", /Loading Content Advisory/);
    assert.equal(guideFetches.length, 0, "guide fetch must wait for verified IMDb ID");

    await React.act(async () => resolveImdb("tt1234567"));
    assert.ok(
      guideFetches.includes("tt1234567"),
      "resolved IMDb ID must be used to fetch the guide",
    );
    assert.match(
      document.body.textContent ?? "",
      /Loading Content Advisory/,
      "guide loading should continue without a transient empty-data message",
    );
    assert.ok(
      [...document.querySelectorAll("button")].some((b) => b.textContent === "Open on IMDb"),
      "resolved IMDb title should gain the external guide link",
    );
    await React.act(async () => resolveGuide(null));
    assert.match(document.body.textContent ?? "", /No detailed content advisory submitted/);

    await click(
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Collapse") ?? null,
    );
    await click(
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Expand") ?? null,
    );
    assert.equal(imdbLookups, 1, "re-expanding a verified title must reuse its IMDb ID");
    assert.deepEqual(loadDetailCustomization().hidden, []);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

test("Content Advisory category chevrons use the row button as the only pointer target", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.invalid" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  localStorage.removeItem("harbor.content-advisory.keep-expanded");

  const Icon = (props: any) =>
    React.createElement("svg", { ...props, "aria-hidden": "true" }, React.createElement("path"));
  const icons = new Proxy({}, { get: () => Icon });
  const ParentsGuidePanel = load("src/views/detail/parents-guide-panel.tsx", {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": icons,
    "@/lib/window": { openUrl: () => {} },
    "@/lib/i18n": { useT: () => (key: string) => key },
    "@/lib/settings": {
      useSettings: () => ({ settings: { contentAdvisoryTheme: "monochrome" } }),
    },
    "@/lib/providers/imdb-parents-guide": {
      severityColorStyle: () => ({
        textClass: "text-ink",
        badgeClass: "text-ink",
        barClass: "bg-white",
      }),
    },
    "./use-parents-guide": {
      useParentsGuide: () => ({ guide: null, loading: false, error: null, retry: () => {} }),
    },
    "../play-picker/use-imdb-id": {
      useImdbId: () => ({ id: null, verified: false, settled: true }),
    },
  }).ParentsGuidePanel;
  const guide = {
    categories: [
      {
        id: "nudity",
        label: "Sex & Nudity",
        severity: "Mild",
        items: [{ text: "A non-spoiler advisory", isSpoiler: false }],
        totalItems: 1,
        totalVotes: 0,
        severityVotes: 0,
      },
      {
        id: "violence",
        label: "Violence & Gore",
        severity: "Moderate",
        items: [{ text: "A separate advisory", isSpoiler: false }],
        totalItems: 1,
        totalVotes: 0,
        severityVotes: 0,
      },
    ],
  };
  const root = createRoot(document.getElementById("root")!);

  try {
    await React.act(async () =>
      root.render(
        React.createElement(ParentsGuidePanel, {
          meta: { id: "tt1234567", name: "Example", type: "movie" },
          imdbId: "tt1234567",
          guide,
        }),
      ),
    );
    const expandSection = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Expand",
    );
    assert.ok(expandSection);
    await React.act(async () => expandSection.click());

    const categoryButton = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="parents-guide-cat-nudity"]',
    );
    assert.ok(categoryButton, "the category heading is one full-width button");
    assert.equal(categoryButton.getAttribute("aria-expanded"), "false");

    // In the maximized WebView, pointerup can land on the card instead of
    // the visual chevron. Capture the gesture on the header button itself.
    const captures: number[] = [];
    categoryButton.setPointerCapture = (id: number) => captures.push(id);
    await React.act(async () => {
      const down = new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 });
      Object.defineProperty(down, "pointerId", { value: 7 });
      categoryButton.dispatchEvent(down);
      categoryButton.dispatchEvent(
        new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 }),
      );
      categoryButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }),
      );
    });
    assert.deepEqual(captures, [7], "the button must capture its own pointer gesture");
    assert.equal(categoryButton.getAttribute("aria-expanded"), "true");
    assert.ok(categoryButton.children[0].classList.contains("pointer-events-none"));
    assert.ok(categoryButton.children[1].classList.contains("pointer-events-none"));
    await React.act(async () => categoryButton.click());
    assert.equal(categoryButton.getAttribute("aria-expanded"), "false");

    const chevron = categoryButton.querySelectorAll("svg")[1];
    assert.ok(chevron, "category button has a separate chevron graphic");
    assert.ok(
      chevron.classList.contains("pointer-events-none"),
      "the rotating chevron must not become its own pointer target",
    );
    assert.equal(chevron.getAttribute("aria-hidden"), "true");

    await React.act(async () => categoryButton.click());
    assert.equal(categoryButton.getAttribute("aria-expanded"), "true");
    assert.match(document.body.textContent ?? "", /A non-spoiler advisory/);

    await React.act(async () =>
      chevron
        .querySelector("path")!
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
    );
    assert.equal(categoryButton.getAttribute("aria-expanded"), "false");
    await React.act(async () => categoryButton.click());
    assert.equal(categoryButton.getAttribute("aria-expanded"), "true");

    const violenceButton = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="parents-guide-cat-violence"]',
    );
    assert.ok(violenceButton, "every advisory category must use the same clickable row");
    const violenceChevron = violenceButton.querySelectorAll("svg")[1];
    assert.ok(violenceChevron?.classList.contains("pointer-events-none"));
    await React.act(async () =>
      violenceChevron
        .querySelector("path")!
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
    );
    assert.equal(violenceButton.getAttribute("aria-expanded"), "true");
    assert.equal(categoryButton.getAttribute("aria-expanded"), "true");
    assert.match(document.body.textContent ?? "", /A separate advisory/);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
