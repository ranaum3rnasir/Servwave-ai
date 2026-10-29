/**
 * Run `task` once the page has settled: after the window's load event, then a quiet period of
 * `delayMs`, then at an idle moment (or straight away where the engine has no idle callback).
 * Returns a function that cancels it, whether or not it has started waiting.
 *
 * It exists for work that nobody is waiting for, such as warming a chunk a customer may need later
 * or starting the error-reporting recorder. Doing that at the page's first idle moment (which is
 * how it used to be done) puts it on the wire while the document's own data is still being fetched,
 * and on a phone connection that delays the first paint (mobile slice 61, PERF-03).
 */
export function runAfterSettle(task: () => void, { delayMs = 3000, timeoutMs = 4000 } = {}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;

  const start = () => {
    if (cancelled) return;
    timer = setTimeout(() => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(() => {
          if (!cancelled) task();
        }, { timeout: timeoutMs });
      } else {
        task();
      }
    }, delayMs);
  };

  if (typeof document === 'undefined' || document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('load', start, { once: true });
  }

  return () => {
    cancelled = true;
    window.removeEventListener('load', start);
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle);
  };
}
