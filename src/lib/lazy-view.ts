import { createElement, lazy, use, type ComponentType, type ReactNode } from "react";

const RETRY_DELAYS_MS = [400, 1200];

/**
 * React caches a lazy import's rejection forever, so a route that lost a single fetch never loads
 * again until the page is reloaded. A dev rebuild or a fresh release both drop module URLs a
 * mounted page is still holding, which makes that one lost fetch ordinary rather than rare.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyView<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => loadWithRetry(load));
}

async function loadWithRetry<T>(load: () => Promise<T>): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    try {
      return await load();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/** Let a route that finished warming render on its first visit without suspending. */
export function preloadableView<P extends object>(load: () => Promise<(props: P) => ReactNode>) {
  type ViewComponent = (props: P) => ReactNode;
  let resolved: ViewComponent | undefined;
  let warming: Promise<ViewComponent> | undefined;
  let requested: Promise<ViewComponent> | undefined;
  const remember = (view: ViewComponent) => (resolved = view);

  function View(props: P) {
    const view =
      resolved ??
      use(
        (requested ??= warming
          ? warming.catch(() => loadWithRetry(load).then(remember))
          : loadWithRetry(load).then(remember)),
      );
    return createElement(view, props);
  }

  return Object.assign(View, {
    preload() {
      if (resolved) return Promise.resolve(resolved);
      if (requested) return requested;
      return (warming ??= load()
        .then(remember)
        .finally(() => {
          warming = undefined;
        }));
    },
  });
}
