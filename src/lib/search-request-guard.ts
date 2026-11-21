/** Stop waiting on a lane even when its transport keeps running. */
export function settleSearchSource<T>(
  request: Promise<T>,
  fallback: T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve) => {
    const finish = (value: T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(value);
    };
    const cancel = () => finish(fallback);
    const timer = setTimeout(cancel, timeoutMs);
    request.then(finish, cancel);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}
