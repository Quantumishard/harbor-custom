import { useEffect, useState, type RefObject } from "react";

type Callback = (visible: boolean) => void;

const subs = new WeakMap<Element, Set<Callback>>();
let observer: IntersectionObserver | null = null;

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const set = subs.get(e.target);
        if (!set) continue;
        // Snapshot: callbacks can subscribe or unsubscribe during delivery.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const cb of [...set]) cb(e.isIntersecting);
      }
    },
    { rootMargin: "100px" },
  );
  return observer;
}

export function observe(el: Element, cb: Callback): () => void {
  const o = ensureObserver();
  let set = subs.get(el);
  if (!set) {
    set = new Set();
    subs.set(el, set);
    o.observe(el);
  }
  set.add(cb);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = subs.get(el);
    if (!current) return;
    current.delete(cb);
    if (current.size > 0) return;
    subs.delete(el);
    o.unobserve(el);
  };
}

const SCROLL_SETTLE_MS = 140;
const pendingAfterScroll = new Set<() => void>();
let scrollSettleTimer: number | undefined;
let lastScrollAt = 0;

function flushAfterScroll() {
  const remaining = SCROLL_SETTLE_MS - (performance.now() - lastScrollAt);
  if (remaining > 1) {
    scrollSettleTimer = window.setTimeout(flushAfterScroll, remaining);
    return;
  }
  scrollSettleTimer = undefined;
  document.removeEventListener("scroll", markScrolling, true);
  const tasks = Array.from(pendingAfterScroll);
  pendingAfterScroll.clear();
  for (const task of tasks) task();
}

function markScrolling() {
  lastScrollAt = performance.now();
}

/** Optional work should start only for cards still near the viewport when scrolling settles. */
export function observeSettled(el: Element, task: () => void): () => void {
  const run = () => {
    stop();
    task();
  };
  const stop = observe(el, (visible) => {
    if (!visible) {
      pendingAfterScroll.delete(run);
      return;
    }
    pendingAfterScroll.add(run);
    if (scrollSettleTimer !== undefined) return;
    document.addEventListener("scroll", markScrolling, { capture: true, passive: true });
    markScrolling();
    scrollSettleTimer = window.setTimeout(flushAfterScroll, SCROLL_SETTLE_MS);
  });
  return () => {
    stop();
    pendingAfterScroll.delete(run);
    if (pendingAfterScroll.size === 0 && scrollSettleTimer !== undefined) {
      window.clearTimeout(scrollSettleTimer);
      scrollSettleTimer = undefined;
      document.removeEventListener("scroll", markScrolling, true);
    }
  };
}

type EntryCallback = (entry: IntersectionObserverEntry) => void;
type MarginObserver = {
  observer: IntersectionObserver;
  subs: WeakMap<Element, Set<EntryCallback>>;
};
const viewportObservers = new Map<string, MarginObserver>();
const rootObservers = new WeakMap<Element, Map<string, MarginObserver>>();
const scrollRoots = new WeakMap<Element, Element | null>();

export function scrollRootOf(el: Element): Element | null {
  const path: Element[] = [];
  let found: Element | null = null;
  let node = el.parentElement;
  while (node && node !== document.body) {
    const cached = scrollRoots.get(node);
    if (cached !== undefined) {
      found = cached;
      break;
    }
    path.push(node);
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      found = node;
      break;
    }
    node = node.parentElement;
  }
  for (const p of path) scrollRoots.set(p, found);
  return found;
}

function marginObserver(rootMargin: string, root: Element | null): MarginObserver {
  let table = viewportObservers;
  if (root) {
    let own = rootObservers.get(root);
    if (!own) {
      own = new Map();
      rootObservers.set(root, own);
    }
    table = own;
  }
  const existing = table.get(rootMargin);
  if (existing) return existing;
  const subs = new WeakMap<Element, Set<EntryCallback>>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const set = subs.get(e.target);
        if (!set) continue;
        // Snapshot: callbacks can subscribe or unsubscribe during delivery.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const cb of [...set]) cb(e);
      }
    },
    { root, rootMargin },
  );
  const created = { observer, subs };
  table.set(rootMargin, created);
  return created;
}

export function observeWithin(
  el: Element,
  rootMargin: string,
  cb: EntryCallback,
  root: Element | null = scrollRootOf(el),
): () => void {
  const { observer, subs } = marginObserver(rootMargin, root);
  let set = subs.get(el);
  if (!set) {
    set = new Set();
    subs.set(el, set);
    observer.observe(el);
  }
  set.add(cb);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = subs.get(el);
    if (!current) return;
    current.delete(cb);
    if (current.size > 0) return;
    subs.delete(el);
    observer.unobserve(el);
  };
}

type ResizeCallback = (rect: DOMRectReadOnly) => void;
const resizeSubs = new WeakMap<Element, Set<ResizeCallback>>();
let resizeObserver: ResizeObserver | null = null;

export function observeResize(el: Element, cb: ResizeCallback): () => void {
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) {
        const set = resizeSubs.get(e.target);
        if (!set) continue;
        // Snapshot: callbacks can subscribe or unsubscribe during delivery.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const fn of [...set]) fn(e.contentRect);
      }
    });
  }
  const ro = resizeObserver;
  let set = resizeSubs.get(el);
  if (!set) {
    set = new Set();
    resizeSubs.set(el, set);
    ro.observe(el);
  }
  set.add(cb);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = resizeSubs.get(el);
    if (!current) return;
    current.delete(cb);
    if (current.size > 0) return;
    resizeSubs.delete(el);
    ro.unobserve(el);
  };
}

export function useInViewport(ref: RefObject<Element | null>, initial = false): boolean {
  const [inView, setInView] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, setInView);
  }, [ref]);
  return inView;
}

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(typeof document === "undefined" ? true : !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
