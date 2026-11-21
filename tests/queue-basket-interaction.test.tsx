import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createPortal } from "react-dom";
import { JSDOM } from "jsdom";
import { useQueueGesture } from "../src/components/queue-basket/use-queue-gesture.ts";

async function setup({
  queueIds = ["a", "b", "c"],
  extraDependencies = {},
}: {
  queueIds?: string[];
  extraDependencies?: Record<string, unknown>;
} = {}) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://fixture.invalid" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  });
  window.matchMedia = (() => ({ matches: true })) as typeof window.matchMedia;
  const captures = new WeakMap<Element, number>();
  Object.assign(dom.window.HTMLElement.prototype, {
    setPointerCapture(id: number) {
      captures.set(this, id);
    },
    hasPointerCapture(id: number) {
      return captures.get(this) === id;
    },
    releasePointerCapture() {
      captures.delete(this);
    },
    scrollIntoView() {},
  });
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });
  let queue = queueIds.map((id) => ({
    id,
    meta: { id, name: id, type: "movie" },
    addedAt: 1,
  }));
  let history = [
    {
      id: "history-a",
      meta: {
        id: "history-movie",
        name: "History movie",
        type: "movie",
      },
      addedAt: 1,
      recordedAt: 2,
      reason: "skipped" as const,
    },
  ];
  const listeners = new Set<() => void>();
  const removed: string[] = [];
  const openPickerCalls: Array<{
    meta: unknown;
    episode: unknown;
    options: Record<string, unknown>;
  }> = [];
  const notify = () => listeners.forEach((fn) => fn());
  const clearQueue = () => {
    queue = [];
    notify();
  };
  const empty = () => null;
  const dependencies = {
    "@/lib/settings": {
      useSettings: () => ({
        settings: { instantPlay: true },
      }),
    },

    "@/lib/view": {
      usePlayerNavigation: () => ({
        openPicker: (meta: unknown, episode: unknown, options: Record<string, unknown>) => {
          openPickerCalls.push({ meta, episode, options });
        },
      }),
    },

    "./queue-history-panel": {
      QueueHistoryPanel: ({
        history: items,
        onPlay,
        onClear,
      }: {
        history: typeof history;
        onPlay: (item: (typeof history)[number]) => void;
        onClear: () => void;
      }) => {
        const item = items[0];
        if (!item) return null;

        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "button",
            {
              type: "button",
              "data-history-item": "",
              onClick: () => onPlay(item),
            },
            item.meta.name,
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-clear-history": "",
              onClick: onClear,
            },
            "Clear history",
          ),
        );
      },
    },
    "./use-queue-gesture": { useQueueGesture },
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": { createPortal },
    "lucide-react": {
      ArrowLeft: empty,
      History: empty,
      ListVideo: empty,
      Play: empty,
      Trash2: empty,
      X: empty,
    },
    "@/hooks/use-start-queue": { useStartQueue: () => () => false },
    "@/hooks/use-queue-surface": { useQueueSurface: () => true },
    "@/lib/i18n": {
      useT: () => (key: string, values?: Record<string, string | number>) =>
        Object.entries(values ?? {}).reduce(
          (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
          key,
        ),
    },
    "./queue-basket.css": {},
    "./queue-clear-confirm": {
      QueueClearConfirm: ({
        target,
        onConfirm,
      }: {
        target: "queue" | "history";
        onConfirm: () => void;
      }) =>
        React.createElement(
          "button",
          {
            type: "button",
            "data-clear-confirm": target,
            onClick: onConfirm,
          },
          `Confirm ${target}`,
        ),
    },
    "@/lib/queue": {
      useQueue: () =>
        React.useSyncExternalStore(
          (fn) => {
            listeners.add(fn);
            return () => {
              listeners.delete(fn);
            };
          },
          () => queue,
        ),
      useQueueHistory: () => history,
      queueHistoryClear: () => {
        history = [];
        notify();
      },
      useQueueResumeItem: () => null,
      queueClear: clearQueue,
      queueRemove: (id: string) => {
        removed.push(id);
        queue = queue.filter((item) => item.id !== id);
        notify();
      },
      queueReorder: (ids: string[]) => {
        queue = ids.map((id) => queue.find((item) => item.id === id)!);
        notify();
      },
    },
    ...extraDependencies,
  };
  const output = ts.transpileModule(
    readFileSync("src/components/queue-basket/queue-basket.tsx", "utf8"),
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
  await React.act(() => root.render(React.createElement(api.QueueBasket)));
  await React.act(() =>
    document.querySelector<HTMLButtonElement>(".queue-basket-trigger")!.click(),
  );
  const list = document.querySelector("ol")!;
  const row = () => document.querySelector<HTMLLIElement>("li")!;
  const rect = (top: number, height: number) => ({
    left: 0,
    right: 200,
    top,
    bottom: top + height,
    width: 200,
    height,
    x: 0,
    y: top,
    toJSON() {},
  });
  list.getBoundingClientRect = () => rect(0, 300);
  for (const [index, element] of [...document.querySelectorAll("li")].entries()) {
    element.getBoundingClientRect = () => rect(index * 90, 80);
  }
  const pointer = (
    type: string,
    x: number,
    y: number,
    pointerType = "mouse",
    target: Element = row(),
  ) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      pointerType,
      button: 0,
      isPrimary: true,
      clientX: x,
      clientY: y,
    });
    target.dispatchEvent(event);
    return event;
  };
  const touch = (type: string, x: number, y: number, target: Element = row()) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    const point = { identifier: 7, clientX: x, clientY: y, target };
    Object.assign(event, {
      touches: type === "touchend" || type === "touchcancel" ? [] : [point],
      changedTouches: [point],
    });
    target.dispatchEvent(event);
    return event;
  };
  return {
    dom,
    row,
    list,
    pointer,
    touch,
    removed,
    ids: () => queue.map((item) => item.id),
    openPickerCalls,
    clearQueue,
    historyCount: () => history.length,
    cleanup: async () => {
      await React.act(() => root.unmount());
      dom.window.close();
    },
  };
}

test("touch scrolling neither grabs nor removes a queue row", async () => {
  const h = await setup();
  try {
    await React.act(() => {
      h.pointer("pointerdown", 30, 30, "touch");
      h.touch("touchstart", 30, 30);
    });
    assert.equal(document.querySelector(".queue-basket-drag-preview"), null);
    await React.act(() => {
      assert.equal(h.touch("touchmove", 30, 70).defaultPrevented, false);
      h.pointer("pointercancel", 30, 70, "touch");
      h.touch("touchend", 30, 400);
    });
    assert.deepEqual(h.ids(), ["a", "b", "c"]);
    assert.deepEqual(h.removed, []);
    assert.equal(h.row().classList.contains("touch-none"), false);
  } finally {
    await h.cleanup();
  }
});

test("keyboard reordering acts only on a focused row with Alt and retains its focus", async () => {
  const h = await setup();
  try {
    const row = h.row();
    row.focus();
    assert.equal(document.activeElement, row);
    await React.act(() =>
      row.dispatchEvent(
        new h.dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.deepEqual(h.ids(), ["b", "a", "c"]);
    assert.equal(document.activeElement, row);
    await React.act(() =>
      row.dispatchEvent(
        new h.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    assert.deepEqual(h.ids(), ["b", "a", "c"]);
  } finally {
    await h.cleanup();
  }
});

test("mouse dragging waits for movement and reorders the whole row", async () => {
  const h = await setup();
  try {
    await React.act(() => h.pointer("pointerdown", 30, 30));
    assert.equal(document.querySelector(".queue-basket-drag-preview"), null);
    await React.act(() => h.pointer("pointermove", 30, 240));
    assert.ok(document.querySelector(".queue-basket-drag-preview"));
    await React.act(() => h.pointer("pointerup", 30, 240));
    assert.deepEqual(h.ids(), ["b", "c", "a"]);
    assert.deepEqual(h.removed, []);
  } finally {
    await h.cleanup();
  }
});

test("a touch hold enables dragging and explicit outside dropping removes only that item", async (t) => {
  const h = await setup();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await React.act(() => h.touch("touchstart", 30, 30));
    await React.act(() => t.mock.timers.tick(350));
    assert.ok(document.querySelector(".queue-basket-drag-preview"));
    await React.act(() => {
      assert.equal(h.touch("touchmove", 30, 400).defaultPrevented, true);
      h.list.dispatchEvent(new h.dom.window.Event("scroll"));
    });
    assert.ok(document.querySelector(".queue-basket-drag-preview"));
    await React.act(() => h.touch("touchend", 30, 400));
    assert.deepEqual(h.removed, ["a"]);
    assert.deepEqual(h.ids(), ["b", "c"]);
  } finally {
    t.mock.timers.reset();
    await h.cleanup();
  }
});

test("canceling an activated touch drag outside never removes an item", async (t) => {
  const h = await setup();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await React.act(() => h.touch("touchstart", 30, 30));
    await React.act(() => t.mock.timers.tick(350));
    await React.act(() => {
      h.touch("touchmove", 30, 400);
      h.touch("touchcancel", 30, 400);
      h.touch("touchend", 30, 400);
    });
    assert.deepEqual(h.removed, []);
    assert.deepEqual(h.ids(), ["a", "b", "c"]);
    assert.equal(document.querySelector(".queue-basket-drag-preview"), null);
  } finally {
    t.mock.timers.reset();
    await h.cleanup();
  }
});

test("queue history opens from the popup and plays without rejoining the queue", async () => {
  const h = await setup();

  try {
    const historyButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Watching history"]',
    );

    assert.ok(historyButton);
    assert.equal(historyButton.disabled, false);

    await React.act(() => historyButton.click());

    assert.equal(document.querySelector("h2")?.textContent, "Watching history");

    const historyItem = document.querySelector<HTMLButtonElement>("[data-history-item]");
    assert.ok(historyItem);

    await React.act(() => historyItem.click());

    assert.deepEqual(h.openPickerCalls, [
      {
        meta: {
          id: "history-movie",
          name: "History movie",
          type: "movie",
        },
        episode: undefined,
        options: {
          autoPlay: true,
          resume: true,
        },
      },
    ]);

    assert.equal("queueItemId" in h.openPickerCalls[0].options, false);
    assert.deepEqual(h.ids(), ["a", "b", "c"]);
  } finally {
    await h.cleanup();
  }
});

test("queue history clears only after confirmation without changing the queue", async () => {
  const h = await setup();

  try {
    const historyButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Watching history"]',
    );
    assert.ok(historyButton);

    await React.act(() => historyButton.click());

    const clearHistory = document.querySelector<HTMLButtonElement>("[data-clear-history]");
    assert.ok(clearHistory);
    await React.act(() => clearHistory.click());

    assert.equal(h.historyCount(), 1);
    assert.deepEqual(h.ids(), ["a", "b", "c"]);

    const confirm = document.querySelector<HTMLButtonElement>('[data-clear-confirm="history"]');
    assert.ok(confirm);
    confirm.focus();
    assert.equal(document.activeElement, confirm);
    await React.act(() => confirm.click());

    assert.equal(h.historyCount(), 0);
    assert.deepEqual(h.ids(), ["a", "b", "c"]);
    assert.equal(document.querySelector("h2")?.textContent, "Watching queue");
    assert.equal(
      document.activeElement,
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'),
    );
  } finally {
    await h.cleanup();
  }
});

test("reopening the popup returns from history to the watching queue", async () => {
  const h = await setup();

  try {
    const historyButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Watching history"]',
    );
    const dialog = document.querySelector<HTMLDialogElement>(".queue-basket-dialog");
    const trigger = document.querySelector<HTMLButtonElement>(".queue-basket-trigger");

    assert.ok(historyButton);
    assert.ok(dialog);
    assert.ok(trigger);

    await React.act(() => historyButton.click());
    assert.equal(document.querySelector("h2")?.textContent, "Watching history");

    await React.act(() => dialog.click());
    await React.act(() => trigger.click());

    assert.equal(document.querySelector("h2")?.textContent, "Watching queue");
  } finally {
    await h.cleanup();
  }
});

test("watching history stays accessible after the final queue item is removed", async () => {
  const h = await setup();

  try {
    await React.act(() => h.clearQueue());

    const trigger = document.querySelector<HTMLButtonElement>(".queue-basket-trigger");
    assert.ok(trigger, "history-only state must keep a floating entry point");
    assert.equal(
      trigger.querySelector(".queue-basket-trigger-label")?.textContent?.trim(),
      "Watching history",
    );
    assert.match(trigger.getAttribute("aria-label") ?? "", /Watching history.*1 in history/);
    assert.equal(trigger.querySelector(".queue-basket-count")?.textContent?.trim(), "1");
    assert.equal(document.querySelector("h2")?.textContent, "Watching history");
    assert.ok(document.querySelector("[data-history-item]"));
    assert.equal(document.querySelector("[data-clear-confirm=queue]"), null);

    await React.act(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
    );
    assert.equal(trigger.hidden, false);
    await React.act(() => trigger.click());
    assert.equal(document.querySelector("h2")?.textContent, "Watching history");

    await React.act(() =>
      document.querySelector<HTMLButtonElement>("[data-clear-history]")!.click(),
    );
    await React.act(() =>
      document.querySelector<HTMLButtonElement>('[data-clear-confirm="history"]')!.click(),
    );
    assert.equal(h.historyCount(), 0);
    assert.equal(document.querySelector(".queue-basket-trigger"), null);
  } finally {
    await h.cleanup();
  }
});

test("clicking inside keeps the queue open while clicking the backdrop closes it", async () => {
  const h = await setup();

  try {
    const trigger = document.querySelector<HTMLButtonElement>(".queue-basket-trigger");
    const dialog = document.querySelector<HTMLDialogElement>(".queue-basket-dialog");
    const header = dialog?.querySelector<HTMLElement>("header");

    assert.ok(trigger);
    assert.ok(dialog);
    assert.ok(header);

    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(trigger.hidden, true);

    await React.act(() => header.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(trigger.hidden, true);

    await React.act(() => dialog.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(trigger.hidden, false);
    assert.equal(dialog.open, false);

    assert.equal(document.activeElement, trigger);
  } finally {
    await h.cleanup();
  }
});

test("queue count uses the plural item label", async () => {
  const h = await setup();

  try {
    const trigger = document.querySelector<HTMLButtonElement>(".queue-basket-trigger");
    const description = document.querySelector("header p");

    assert.ok(trigger);
    assert.equal(trigger.querySelector(".queue-basket-trigger-label")?.textContent, "Queue");
    assert.match(trigger.getAttribute("aria-label") ?? "", /^Watching queue ·/);
    assert.equal(document.querySelector("h2")?.textContent, "Watching queue");
    assert.equal(description?.textContent, "3 items in queue");
    assert.match(trigger.getAttribute("aria-label") ?? "", /3 items in queue/);
  } finally {
    await h.cleanup();
  }
});

test("queue count uses the singular item label", async () => {
  const h = await setup({ queueIds: ["a"] });

  try {
    const trigger = document.querySelector<HTMLButtonElement>(".queue-basket-trigger");
    const description = document.querySelector("header p");

    assert.ok(trigger);
    assert.equal(description?.textContent, "1 item in queue");
    assert.match(trigger.getAttribute("aria-label") ?? "", /1 item in queue/);
  } finally {
    await h.cleanup();
  }
});
