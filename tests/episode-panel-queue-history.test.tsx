import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

test("Up Next opens queue history and resumes an item outside the queue session", async () => {
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
  const historyItem = {
    id: "history-item",
    meta: { id: "history-movie", name: "History movie", type: "movie" },
    addedAt: 1,
    recordedAt: 2,
    reason: "skipped" as const,
  };
  const queuedItem = {
    id: "active-queue-item",
    meta: { id: "queued-movie", name: "Queued movie", type: "movie" as const },
    addedAt: 1,
  };
  let queueItems: Array<typeof queuedItem> = [];
  let clearQueueCalls = 0;
  const openPickerCalls: unknown[][] = [];
  let closeCalls = 0;

  const dependencies: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": {
      ChevronLeft: empty,
      History: empty,
      Trash2: empty,
    },
    "@/components/icons/play-filled": { Play: empty },
    "@/components/queue-basket/queue-clear-confirm": {
      QueueClearConfirm: ({
        onCancel,
        onConfirm,
      }: {
        onCancel: () => void;
        onConfirm: () => void;
      }) =>
        React.createElement(
          "div",
          { "data-queue-clear-dialog": "" },
          React.createElement(
            "button",
            { type: "button", "data-cancel-clear": "", onClick: onCancel },
            "Cancel",
          ),
          React.createElement(
            "button",
            { type: "button", "data-confirm-clear": "", onClick: onConfirm },
            "Confirm",
          ),
        ),
    },
    "@/components/queue-basket/queue-history-panel": {
      QueueHistoryPanel: ({
        history,
        onPlay,
      }: {
        history: (typeof historyItem)[];
        onPlay: (item: typeof historyItem) => void;
      }) =>
        React.createElement(
          "button",
          {
            type: "button",
            "data-history-item": "",
            onClick: () => onPlay(history[0]),
          },
          history[0]?.meta.name,
        ),
    },
    "@/lib/queue": {
      queueClear: () => {
        clearQueueCalls += 1;
      },
      queueIndexOf: () => -1,
      queueItemAfter: () => null,
      queueRemove: () => {},
      useQueue: () => queueItems,
      useQueueHistory: () => [historyItem],
    },
    "@/lib/view": {
      usePlayerNavigation: () => ({
        openPicker: (...args: unknown[]) => openPickerCalls.push(args),
      }),
    },
    "@/lib/providers/kitsu": { parseKitsuId: () => null },
    "@/lib/streams/anime-identity-core": {
      splitFranchiseDisplaySeason: () => null,
    },
    "@/lib/i18n": {
      useT: () => (key: string) => key,
    },
    "@/lib/settings": {
      useSettings: () => ({ settings: { instantPlay: true } }),
    },
  };

  const output = ts.transpileModule(
    readFileSync("src/components/player/episode-panel/queue-up-next.tsx", "utf8"),
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
    return dependencies[name];
  }, api);

  const QueueUpNext = api.QueueUpNext;
  assert.ok(QueueUpNext);

  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const renderPanel = (open: boolean, roomGuest = false) =>
    root.render(
      React.createElement(QueueUpNext, {
        meta: { id: "current-series", name: "Current series", type: "series" },
        currentEpisode: { season: 1, episode: 1 },
        roomGuest,
        open,
        onClose: () => {
          closeCalls += 1;
        },
      }),
    );

  try {
    await React.act(() => renderPanel(true));

    assert.match(document.body.textContent ?? "", /Your queue is empty/);

    const historyButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Watching history"]',
    );
    assert.ok(historyButton);

    await React.act(() => historyButton.click());
    assert.match(document.body.textContent ?? "", /Back to watching queue/);
    const historyBackButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Back to watching queue"),
    );
    assert.ok(historyBackButton);
    assert.equal(document.activeElement, historyBackButton);

    await React.act(() => historyBackButton.click());
    const restoredHistoryButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Watching history"]',
    );
    assert.ok(restoredHistoryButton);
    assert.equal(document.activeElement, restoredHistoryButton);

    await React.act(() => restoredHistoryButton.click());

    await React.act(() => renderPanel(false));
    await React.act(() => renderPanel(true));
    assert.match(document.body.textContent ?? "", /In your watching queue/);

    await React.act(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Watching history"]')!.click(),
    );
    await React.act(() =>
      document.querySelector<HTMLButtonElement>("[data-history-item]")!.click(),
    );

    assert.deepEqual(openPickerCalls, [
      [
        historyItem.meta,
        undefined,
        {
          autoPlay: true,
          resume: true,
        },
      ],
    ]);
    assert.equal(closeCalls, 1);

    await React.act(() => renderPanel(false));
    await React.act(() => renderPanel(true, true));
    assert.equal(document.querySelector('button[aria-label="Watching history"]'), null);

    await React.act(() => renderPanel(false));
    queueItems = [queuedItem];
    await React.act(() => renderPanel(true));
    const clearButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Clear",
    );
    assert.ok(clearButton);
    await React.act(() => clearButton.click());
    assert.equal(clearQueueCalls, 0, "opening confirmation must not clear the queue");
    assert.ok(document.querySelector("[data-queue-clear-dialog]"));
    await React.act(() =>
      document.querySelector<HTMLButtonElement>("[data-cancel-clear]")!.click(),
    );
    assert.equal(clearQueueCalls, 0, "canceling must preserve the queue");
    assert.equal(document.querySelector("[data-queue-clear-dialog]"), null);
    await React.act(() => clearButton.click());
    await React.act(() =>
      document.querySelector<HTMLButtonElement>("[data-confirm-clear]")!.click(),
    );
    assert.equal(clearQueueCalls, 1, "confirming should clear the queue exactly once");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
  }
});
