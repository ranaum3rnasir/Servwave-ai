import { lazy, Suspense, useRef, type ComponentType, type ReactElement, type ReactNode } from 'react';

/**
 * A dialog that is code-split AND only fetched the first time it is asked to open (mobile slice 61,
 * PERF-03).
 *
 * Pages mount their dialogs once and drive them with an `open` prop. Imported normally, every one of
 * them (and the form controls only they use) is in the page's first download, though most visits
 * never open any. This wraps such a component: nothing is downloaded or rendered until `open` first
 * becomes true; then the chunk loads, the dialog mounts and stays mounted, so closing it still
 * plays its exit and reopening it is instant.
 *
 *   const EventEditor = lazyWhenOpened(() => import('./eventEditor'), (m) => m.EventEditor);
 *
 * `preload()` starts the download without opening, for a caller that can tell one is likely (the
 * board has settled, a pointer is over the control); calling it more than once is free, and a failed
 * preload is left for the open that follows to report through the app's stale-chunk recovery.
 */
export function lazyWhenOpened<M, P extends { open: boolean }>(
  load: () => Promise<M>,
  pick: (module: M) => (props: P) => ReactNode,
): ((props: P) => ReactElement | null) & { preload: () => void } {
  const Lazy = lazy(() => load().then((m) => ({ default: pick(m) as ComponentType<P> })));

  function LazyWhenOpened(props: P): ReactElement | null {
    const everOpened = useRef(false);
    if (props.open) everOpened.current = true;
    if (!everOpened.current) return null;
    return (
      <Suspense fallback={null}>
        <Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
      </Suspense>
    );
  }
  LazyWhenOpened.preload = () => {
    void load().catch(() => {});
  };
  return LazyWhenOpened;
}
