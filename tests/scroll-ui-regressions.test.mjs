import assert from "node:assert/strict";
import test from "node:test";
import { loadModule, readSource } from "../scripts/benchmark-discover.mjs";

test("row card mounts and artwork share the scroll budget and queued work can be cancelled", () => {
  const source = readSource("src/components/row.tsx");
  const start = source.indexOf("const CARD_UPDATES_DURING_SCROLL");
  const end = source.indexOf("export type RowShape", start);
  assert.ok(start >= 0 && end > start);
  let scrolling = true;
  let id = 0;
  const frames = new Map();
  const { queueRowCardUpdate } = loadModule(
    source.slice(start, end),
    {},
    {
      isScrollActive: () => scrolling,
      startTransition: (task) => task(),
      requestAnimationFrame: (task) => (frames.set(++id, task), id),
      cancelAnimationFrame: (frame) => frames.delete(frame),
    },
  );
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((task) => task());
  };
  const updates = [];
  queueRowCardUpdate(() => updates.push("mount"));
  const cancelArtwork = queueRowCardUpdate(() => updates.push("cancelled artwork"));
  queueRowCardUpdate(() => updates.push("current artwork"));
  flush();
  assert.deepEqual(updates, ["mount"]);
  cancelArtwork();
  flush();
  assert.deepEqual(updates, ["mount", "current artwork"]);
  assert.equal(frames.size, 0);

  const cancelLast = queueRowCardUpdate(() => assert.fail("cancelled update ran"));
  cancelLast();
  assert.equal(frames.size, 0);

  scrolling = false;
  for (let i = 0; i < 7; i++) queueRowCardUpdate(() => updates.push(i));
  flush();
  assert.deepEqual(updates.slice(2), [0, 1, 2, 3, 4, 5]);
  flush();
  assert.deepEqual(updates.slice(2), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(frames.size, 0);
});

test("Back to Top checks a final scroll event inside its throttle window", () => {
  const timers = new Map();
  const frames = new Map();
  const listeners = new Map();
  let now = 0;
  let nextId = 0;
  let shown = false;
  let cleanup;
  const scroller = {
    scrollTop: 0,
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
  };
  const { BackToTop } = loadModule(
    readSource("src/components/back-to-top.tsx"),
    {
      react: {
        useEffect: (effect) => {
          cleanup = effect();
        },
        useState: (initial) => [
          initial,
          (value) => {
            shown = value;
          },
        ],
      },
      "react/jsx-runtime": { jsx: () => null },
      "lucide-react": { ArrowUp: () => null },
      "@/lib/i18n": { useT: () => (label) => label },
    },
    {
      performance: { now: () => now },
      window: {
        setTimeout: (task) => (timers.set(++nextId, task), nextId),
        clearTimeout: (id) => timers.delete(id),
      },
      requestAnimationFrame: (task) => (frames.set(++nextId, task), nextId),
      cancelAnimationFrame: (id) => frames.delete(id),
    },
  );
  const flush = (queue) => {
    const pending = Array.from(queue.values());
    queue.clear();
    pending.forEach((run) => run());
  };
  BackToTop({ scrollRef: { current: scroller } });
  now = 40;
  scroller.scrollTop = 900;
  listeners.get("scroll")();
  assert.equal(shown, false);
  now = 100;
  flush(timers);
  flush(frames);
  assert.equal(shown, true);

  now = 130;
  scroller.scrollTop = 0;
  listeners.get("scroll")();
  now = 200;
  flush(timers);
  flush(frames);
  assert.equal(shown, false);

  now = 225;
  listeners.get("scroll")();
  cleanup();
  assert.equal(timers.size + frames.size + listeners.size, 0);
});

test("scroll memory saves the outgoing anchor before navigation parks the layer", () => {
  const source = readSource("src/lib/view.tsx");
  const start = source.indexOf("function anchorOffsetIn(");
  const end = source.indexOf("\n}", source.indexOf("export function useScrollMemory", start));
  assert.ok(start >= 0 && end > start);
  const listeners = new Map();
  const timers = new Map();
  const savers = new Set();
  const snapshots = new Map();
  let parked = false;
  let hasAnchor = true;
  let anchorTop = 1000;
  const windowListeners = new Map();
  let reads = 0;
  let heightReads = 0;
  let onResize;
  let cleanup;
  let position = 0;
  let nextId = 0;
  const anchor = {
    dataset: { scrollAnchor: "row-3" },
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: anchorTop - position, height: 300 }),
  };
  const scroller = {
    style: { overflowAnchor: "" },
    firstElementChild: { nextElementSibling: {} },
    get scrollTop() {
      reads++;
      return position;
    },
    set scrollTop(value) {
      position = value;
    },
    get clientHeight() {
      heightReads++;
      return parked ? 0 : 800;
    },
    scrollHeight: 6000,
    closest: () => (parked ? {} : null),
    querySelectorAll: () => [anchor],
    querySelector: () => (hasAnchor ? anchor : null),
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
  };
  const { useScrollMemory } = loadModule(
    source.slice(start, end + 2),
    {},
    {
      useView: () => ({
        rememberScroll: (key, snapshot) => snapshots.set(key, snapshot),
        recallScroll: (key) => snapshots.get(key),
        registerScrollSave: (save) => {
          savers.add(save);
          return () => savers.delete(save);
        },
      }),
      useSettings: () => ({ settings: { smoothScroll: false } }),
      useSmoothWheel: () => {},
      useEffect: () => {},
      useLayoutEffect: (effect) => {
        cleanup = effect();
      },
      noteScrollActivity: () => {},
      performance: { now: () => 10 },
      ResizeObserver: class {
        constructor(callback) {
          onResize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      CSS: { escape: (value) => value },
      window: {
        setTimeout: (task, delay) => (timers.set(++nextId, { task, delay }), nextId),
        addEventListener: (event, handler) => windowListeners.set(event, handler),
        removeEventListener: (event) => windowListeners.delete(event),
      },
      clearTimeout: (id) => timers.delete(id),
    },
  );
  const ref = { current: scroller };
  useScrollMemory("discover", ref);
  assert.equal(heightReads, 0, "a page with no saved scroll skips layout during setup");
  position = 700;
  listeners.get("scroll")();
  position = 1200;
  listeners.get("scroll")();
  assert.equal(reads, 0);

  for (const save of savers) save();
  parked = true;
  cleanup();
  assert.deepEqual(snapshots.get("discover"), { anchor: "row-3", delta: 200, fallback: 1200 });
  assert.equal(savers.size, 0);
  assert.equal(timers.size, 0);

  parked = false;
  position = 0;
  useScrollMemory("discover", ref);
  assert.equal(position, 1200);
  cleanup();

  snapshots.set("discover", { fallback: 0, delta: 0 });
  heightReads = 0;
  useScrollMemory("discover", ref);
  assert.equal(heightReads, 0, "a saved top position also skips layout during setup");
  onResize();
  assert.equal(position, 0);
  cleanup();

  snapshots.set("discover", { anchor: "row-3", fallback: 820, delta: 4 });
  hasAnchor = false;
  useScrollMemory("discover", ref, true, false, { followLayout: true });
  assert.equal(position, 0, "a missing section must not restore to raw pixels");
  assert.equal(scroller.style.overflowAnchor, "none");
  hasAnchor = true;
  onResize();
  assert.equal(position, 1004);
  anchorTop = 1480;
  onResize();
  assert.equal(position, 1484, "late content above the target must preserve its viewport offset");
  const [settle] = [...timers].find(([, entry]) => entry.delay === 450);
  anchorTop = 1490;
  const { task } = timers.get(settle);
  timers.delete(settle);
  task();
  assert.equal(position, 1494);
  assert.equal(scroller.style.overflowAnchor, "");
  assert.equal(windowListeners.size, 0);
  cleanup();

  position = 0;
  hasAnchor = false;
  useScrollMemory("discover", ref, true, false, { followLayout: true });
  listeners.get("wheel")();
  position = 500;
  hasAnchor = true;
  onResize();
  assert.equal(position, 500, "user scrolling must cancel the pending restore");
  assert.equal(scroller.style.overflowAnchor, "");
  assert.equal(timers.size, 0);
  cleanup();

  position = 0;
  hasAnchor = false;
  useScrollMemory("discover", ref, true, true, { followLayout: true });
  assert.equal(scroller.style.opacity, "0");
  assert.ok(
    [...timers.values()].every((entry) => entry.delay !== 220),
    "pending detail anchors must not reveal the top of the page",
  );
  const [deadline, timeout] = [...timers].find(([, entry]) => entry.delay === 2200);
  timers.delete(deadline);
  timeout.task();
  assert.equal(position, 500, "a section that never returns uses the last saved offset");
  assert.equal(scroller.style.opacity, "1");
  assert.equal(scroller.style.overflowAnchor, "");
  cleanup();
});
