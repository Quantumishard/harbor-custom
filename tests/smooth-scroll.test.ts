import assert from "node:assert/strict";
import test from "node:test";
import { loadModule, readSource } from "../scripts/benchmark-discover.mjs";

function fixture({ enabled = true, reduced = false, rounded = false } = {}) {
  let now = 0;
  let id = 0;
  const frames = new Map();
  const listeners = new Map();
  const globalListeners = new Map();
  const mediaListeners = new Map();
  const observed = new Set();
  let onResize;
  let onChildList;
  const media = {
    matches: reduced,
    addEventListener: (name, fn) => mediaListeners.set(name, fn),
    removeEventListener: (name) => mediaListeners.delete(name),
  };
  class Element {
    position = 0;
    scrollHeight = 3000;
    clientHeight = 800;
    parentElement = null;
    children = [];
    overflowY = "visible";
    get scrollTop() {
      return this.position;
    }
    set scrollTop(value) {
      const clamped = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
      this.position = rounded ? Math.round(clamped) : clamped;
    }
    addEventListener(name, fn) {
      listeners.set(name, fn);
    }
    removeEventListener(name) {
      listeners.delete(name);
    }
  }
  const el = new Element();
  let cleanup;
  const { useSmoothWheel } = loadModule(
    readSource("src/lib/smooth-scroll.ts"),
    {
      react: {
        useEffect: (fn) => {
          cleanup = fn();
        },
      },
    },
    {
      Element,
      ResizeObserver: class {
        constructor(callback) {
          onResize = callback;
        }
        observe(node) {
          observed.add(node);
        }
        unobserve(node) {
          observed.delete(node);
        }
        disconnect() {
          observed.clear();
        }
      },
      MutationObserver: class {
        constructor(callback) {
          onChildList = callback;
        }
        observe() {}
        disconnect() {
          onChildList = undefined;
        }
      },
      getComputedStyle: (node) => ({ overflowY: node.overflowY }),
      performance: { now: () => now },
      window: {
        matchMedia: () => media,
        addEventListener: (name, fn) => globalListeners.set(name, fn),
        removeEventListener: (name) => globalListeners.delete(name),
      },
      requestAnimationFrame: (fn) => {
        const next = ++id;
        frames.set(next, fn);
        return next;
      },
      cancelAnimationFrame: (frame) => frames.delete(frame),
    },
  );
  useSmoothWheel({ current: el }, enabled);
  const wheel = (overrides = {}) => {
    const event = {
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      cancelable: true,
      defaultPrevented: false,
      target: el,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...overrides,
    };
    listeners.get("wheel")?.(event);
    return event;
  };
  const step = (hz = 60) => {
    now += 1000 / hz;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn(now));
  };
  const settle = (hz = 60) => {
    let count = 0;
    while (frames.size && count++ < 1000) step(hz);
    return { ms: Math.round(now), frames: count, pending: frames.size, position: el.scrollTop };
  };
  return {
    el,
    Element,
    wheel,
    step,
    settle,
    frames,
    listeners,
    globalListeners,
    media,
    mediaListeners,
    observed,
    resize: (node = el) => {
      if (observed.has(node)) onResize();
    },
    replaceChildren: (...children) => {
      el.children = children;
      onChildList();
    },
    cleanup: () => cleanup?.(),
  };
}

test("scroll duration stays consistent across monitor refresh rates", () => {
  const durations = [];
  for (const hz of [60, 120, 144]) {
    const f = fixture();
    f.wheel();
    const result = f.settle(hz);
    assert.equal(result.position, 120);
    assert.equal(result.pending, 0);
    durations.push(result.ms);
    f.cleanup();
  }
  assert.ok(Math.max(...durations) - Math.min(...durations) <= 25);
});

test("opposite wheel input reverses immediately instead of continuing old momentum", () => {
  const f = fixture();
  f.el.scrollTop = 400;
  f.wheel({ deltaY: 600 });
  f.step();
  const previous = f.el.scrollTop;
  f.wheel({ deltaY: -120 });
  f.step();
  assert.ok(f.el.scrollTop < previous);
  f.cleanup();
});

test("keyboard, pointer and touch cancel queued motion", () => {
  for (const input of ["keydown", "pointerdown", "touchstart"]) {
    const f = fixture();
    f.wheel();
    (input === "keydown" ? f.globalListeners : f.listeners).get(input)();
    assert.equal(f.frames.size, 0);
    f.cleanup();
  }
});

test("shrinking content and rounded scroll positions cannot leave an endless animation", () => {
  const f = fixture();
  f.wheel({ deltaY: 1000 });
  f.step();
  f.el.scrollHeight = 900;
  f.resize();
  assert.equal(f.settle().pending, 0);
  assert.equal(f.el.scrollTop, 100);
  f.cleanup();
  const rounded = fixture({ rounded: true });
  rounded.wheel();
  assert.equal(rounded.settle(144).pending, 0);
  assert.equal(rounded.el.scrollTop, 120);
  rounded.cleanup();
});

test("disabled/reduced motion and native input paths are not intercepted", () => {
  const disabled = fixture({ enabled: false });
  assert.equal(disabled.listeners.size, 0);
  const f = fixture({ reduced: true });
  assert.equal(f.wheel().defaultPrevented, false);
  f.media.matches = false;
  assert.equal(f.wheel().defaultPrevented, true);
  f.media.matches = true;
  f.mediaListeners.get("change")();
  assert.equal(f.frames.size, 0);
  f.media.matches = false;
  for (const event of [
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { metaKey: true },
    { deltaMode: 1 },
    { deltaX: 200 },
    { cancelable: false },
    { deltaY: 0 },
  ]) {
    assert.equal(f.wheel(event).defaultPrevented, false);
  }
  assert.equal(f.frames.size, 0);
  const nested = new f.Element();
  nested.overflowY = "auto";
  nested.parentElement = f.el;
  assert.equal(f.wheel({ target: nested }).defaultPrevented, false);
  f.cleanup();
});

test("a sibling catalog can grow during an active gesture and a replacement is observed", () => {
  const f = fixture();
  const hero = new f.Element();
  const catalog = new f.Element();
  f.el.scrollHeight = 900;
  f.replaceChildren(hero, catalog);
  f.wheel({ deltaY: 80 });
  f.step();
  f.el.scrollHeight = 2400;
  f.resize(catalog);
  f.wheel({ deltaY: 600 });
  assert.equal(f.settle().position, 680);

  const replacement = new f.Element();
  f.replaceChildren(hero, replacement);
  assert.equal(f.observed.has(catalog), false);
  assert.equal(f.observed.has(replacement), true);
  f.cleanup();
  assert.equal(f.observed.size, 0);
});

test("a new gesture reads the actual scroll position and range before resize delivery", () => {
  const f = fixture();
  f.el.scrollHeight = 900;
  f.resize();
  f.el.scrollHeight = 2400;
  f.el.scrollTop = 350;
  f.wheel();
  assert.equal(f.settle().position, 470);
  f.cleanup();
});

test("a nested pane that becomes scrollable takes the wheel", () => {
  const f = fixture();
  const nested = new f.Element();
  nested.parentElement = f.el;
  assert.equal(f.wheel({ target: nested }).defaultPrevented, true);
  f.settle();
  nested.overflowY = "auto";
  assert.equal(f.wheel({ target: nested }).defaultPrevented, false);
  nested.overflowY = "hidden";
  assert.equal(f.wheel({ target: nested }).defaultPrevented, true);
  f.cleanup();
});

test("settled boundaries allow native chaining and cleanup removes every listener", () => {
  const f = fixture();
  assert.equal(f.wheel({ deltaY: -120 }).defaultPrevented, false);
  f.wheel();
  f.cleanup();
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.globalListeners.size, 0);
  assert.equal(f.mediaListeners.size, 0);
});
