/**
 * The "Update available" decision: when a waiting service-worker update is applied, and when
 * the page reloads onto it.
 *
 * A deploy installs a new worker next to the running one. It WAITS (the worker no longer calls
 * `skipWaiting()` by itself, see `src/sw.ts`) until this controller tells it to take over. That
 * hand-over is what swaps the offline cache under the page, and the page then reloads onto the
 * new bundle, so both steps are held back while anything on screen holds unsaved work (the
 * shared signal in `ui-kit/lib/unsavedWork`). A reload under a half-filled form would throw the
 * form away.
 *
 * Two moments apply an update:
 *   - the user taps "Update" (a tap made while work is unsaved is remembered, and acts the
 *     moment the work is saved or discarded);
 *   - the page is in the background (hidden) with nothing unsaved: the safest time, nobody is
 *     looking at it.
 *
 * `shouldApplyUpdateNow` and `shouldReloadForUpdate` are the pure decisions, tested alone. The
 * controller is the small state machine around them, with every browser touch point injected.
 */

export interface ApplyDecisionInput {
  /** A new worker is installed and waiting. */
  updateWaiting: boolean;
  /** The user tapped Update. */
  applyRequested: boolean;
  /** Something on screen holds work a reload would discard. */
  hasUnsavedWork: boolean;
  /** The page is in the background. */
  pageHidden: boolean;
}

/** Should the waiting worker be told to take over now? Never while work is unsaved. */
export function shouldApplyUpdateNow({
  updateWaiting,
  applyRequested,
  hasUnsavedWork,
  pageHidden,
}: ApplyDecisionInput): boolean {
  if (!updateWaiting || hasUnsavedWork) return false;
  return applyRequested || pageHidden;
}

/** Should the page reload onto a worker that has already taken over? Never while work is unsaved. */
export function shouldReloadForUpdate({
  controllerChanged,
  hasUnsavedWork,
}: {
  controllerChanged: boolean;
  hasUnsavedWork: boolean;
}): boolean {
  return controllerChanged && !hasUnsavedWork;
}

export type UpdateStatus =
  /** Nothing is waiting. */
  | 'idle'
  /** An update is waiting for the user's tap. */
  | 'available'
  /** The user tapped, but unsaved work is holding the update back. */
  | 'blocked-by-unsaved-work'
  /** The new worker is taking over. */
  | 'applying';

export interface UpdateControllerDeps {
  hasUnsavedWork: () => boolean;
  /** Calls `listener` whenever the unsaved-work signal changes. Returns the unsubscribe. */
  subscribeUnsavedWork: (listener: () => void) => () => void;
  isPageHidden: () => boolean;
  /** Tells the waiting worker to take over (posts SKIP_WAITING to it). */
  activateWaitingWorker: () => void;
  reload: () => void;
}

export interface UpdateController {
  getStatus: () => UpdateStatus;
  subscribe: (listener: () => void) => () => void;
  /** A new worker finished installing and is waiting. */
  markUpdateWaiting: () => void;
  /** The user tapped "Update". */
  requestApply: () => void;
  /** The page was shown or hidden. */
  pageVisibilityChanged: () => void;
  /** The page's controlling worker changed (the new one took over). */
  controllerChanged: () => void;
  dispose: () => void;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const listeners = new Set<() => void>();
  let updateWaiting = false;
  let applyRequested = false;
  let activated = false;
  let controllerSwapped = false;
  let reloaded = false;
  let status: UpdateStatus = 'idle';

  const notify = () => listeners.forEach((l) => l());

  const computeStatus = (): UpdateStatus => {
    if (!updateWaiting) return 'idle';
    if (activated) return 'applying';
    return applyRequested ? 'blocked-by-unsaved-work' : 'available';
  };

  const settle = () => {
    const unsaved = deps.hasUnsavedWork();
    if (
      !activated &&
      shouldApplyUpdateNow({
        updateWaiting,
        applyRequested,
        hasUnsavedWork: unsaved,
        pageHidden: deps.isPageHidden(),
      })
    ) {
      activated = true;
      deps.activateWaitingWorker();
    }
    if (!reloaded && shouldReloadForUpdate({ controllerChanged: controllerSwapped, hasUnsavedWork: unsaved })) {
      reloaded = true;
      deps.reload();
    }
    const next = computeStatus();
    if (next !== status) {
      status = next;
      notify();
    }
  };

  const unsubscribeSignal = deps.subscribeUnsavedWork(settle);

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markUpdateWaiting() {
      updateWaiting = true;
      settle();
    },
    requestApply() {
      applyRequested = true;
      settle();
    },
    pageVisibilityChanged: settle,
    controllerChanged() {
      // The worker changed under this page: this tab's cache is the new deploy's now, so the
      // page has to reload onto it. That includes an update another tab applied.
      controllerSwapped = true;
      settle();
    },
    dispose() {
      unsubscribeSignal();
      listeners.clear();
    },
  };
}
