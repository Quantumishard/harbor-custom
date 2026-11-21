import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import * as portals from "react-dom";
import { createRoot } from "react-dom/client";
import * as icons from "lucide-react";
import * as context from "../src/lib/context-menu.tsx";
import * as poster from "../src/lib/title-poster.ts";
import * as logo from "../src/lib/title-logo.ts";
import * as backdrop from "../src/lib/title-backdrop.ts";

test("detail Media exposes and persists poster, logo and backdrop choices through buttons and registered menus", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const updates: unknown[] = [];
  const dependencies: Record<string, any> = {
    react: React,
    "react/jsx-runtime": jsx,
    "react-dom": portals,
    "lucide-react": icons,
    "@/lib/context-menu": context,
    "@/lib/i18n": { t: (s: string) => s },
    "@/lib/title-poster": poster,
    "@/lib/title-logo": logo,
    "@/lib/title-backdrop": backdrop,
    "@/lib/settings": {
      useSettings: () => ({ settings: { theme: {} }, update: (v: unknown) => updates.push(v) }),
    },
    "@/components/icons/play-filled": { Play: () => null },
    "@/components/hover-tooltip": { HoverTooltip: ({ children }: any) => children },
    "@/lib/download/save-binary": {},
    "@/lib/trailer": {},
    "./trailer-overlay": { TrailerOverlay: () => null },
    "./media-lightbox": { MediaLightbox: () => null },
    "./media-gallery/media-rail": { MediaRail: ({ children }: any) => children },
  };
  function load(file: string) {
    const output = ts.transpileModule(
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", output)(
      (id: string) => {
        assert.ok(id in dependencies, `unmocked dependency ${id}`);
        return dependencies[id];
      },
      module,
      module.exports,
    );
    return module.exports;
  }
  dependencies["./media-gallery/media-tiles"] = load(
    "src/views/detail/media-gallery/media-tiles.tsx",
  );
  const { MediaGallery } = load("src/views/detail/media-gallery.tsx");
  const root = createRoot(document.getElementById("root")!);
  const id = "artwork-fixture";
  const detail = {
    gallery: { posters: [], backdrops: [], logos: [] },
    poster: "https://images.example.org/poster.jpg",
    backdrop: "https://images.example.org/backdrop.jpg",
    logo: "https://images.example.org/logo.png",
    trailerCandidates: [],
    extraVideos: [],
  };
  const render = (value = detail) =>
    React.act(() =>
      root.render(
        <context.ContextMenuProvider>
          <MediaGallery detail={value} title="Fixture" metaId={id} />
        </context.ContextMenuProvider>,
      ),
    );
  const clickTab = async (name: string) => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith(name),
    );
    assert.ok(button, `${name} tab is present even without alternative images`);
    await React.act(() => button.click());
  };
  const command = () => {
    const target = context.registeredContextTarget(document.querySelector("img")!);
    assert.equal(target?.kind, "actions");
    assert.equal(target.navigation, false);
    return target.kind === "actions" ? target.actions() : [];
  };
  try {
    await render();
    for (const [tab, get, key, action, field] of [
      ["Posters", poster.getTitlePoster, "harbor:title-posters", "artwork:poster", "poster"],
      ["Logos", logo.getTitleLogo, "harbor:title-logos", "artwork:logo", "logo"],
      [
        "Backdrops",
        backdrop.getTitleBackdrop,
        "harbor:title-backdrops",
        "artwork:backdrop",
        "backdrop",
      ],
    ] as const) {
      await clickTab(tab);
      await React.act(() => command().find((a) => a.id === action)!.run!());
      assert.equal(get(id), detail[field]);
      assert.equal(JSON.parse(localStorage.getItem(key)!)[id], detail[field]);
      assert.match(command().find((a) => a.id === action)!.label, /Reset/);
      const reset = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Reset to default"]',
      );
      assert.ok(reset, "the matching reset button is reachable by keyboard");
      await React.act(() => reset.click());
      assert.equal(get(id), undefined);
      assert.equal(JSON.parse(localStorage.getItem(key)!)[id], undefined);
    }
    await React.act(() => command().find((a) => a.id === "artwork:theme")!.run!());
    assert.deepEqual(updates, [
      { theme: { backgroundImage: detail.backdrop, backgroundDim: 0.5 } },
    ]);
    // A metadata refresh can remove the selected tab; another populated tab must render.
    await clickTab("Logos");
    await render({ ...detail, logo: "" });
    assert.equal(document.querySelector("img")?.getAttribute("src"), detail.backdrop);
  } finally {
    await React.act(() => root.unmount());
    poster.clearTitlePoster(id);
    logo.clearTitleLogo(id);
    backdrop.clearTitleBackdrop(id);
    dom.window.close();
  }
});
