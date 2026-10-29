import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom';

import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { DiscardConfirm } from '@/ui-kit/components/ui/discardConfirm';
import { registerUnsavedWork } from '@/ui-kit/lib/unsavedWork';

/**
 * A page that holds half-filled work asks before the user leaves it (mobile slice 66): the lead,
 * customer and job create forms.
 *
 *   const leave = useLeaveGuard(dirty);
 *   <BackLink onClick={leave.leaveBack} />
 *   <Button onClick={leave.leaveBack}>Cancel</Button>
 *   ... onSuccess: leave.finish(`/leads/${id}`)
 *   {leave.leaveDialog}
 *
 * The app uses the declarative router, which has no navigation blocker (see
 * `settingsGuard.store.ts`), so this rides the pieces that already exist:
 *   - every in-app exit (sidebar, top bar, search, the logo) runs through the shared
 *     `requestLeave`, which defers to the question below while this page publishes `dirty`;
 *   - the Back button is held with a history marker: Back takes the marker off, the page stays,
 *     and the question is asked. Keep editing puts the marker back; Discard goes back a step;
 *   - a reload or tab close asks through the browser;
 *   - while dirty it is on the unsaved-work signal, so the "update available" prompt waits.
 *
 * `finish` is for work that is DONE (a successful save): it leaves without asking, taking the
 * marker off first so the history ends up exactly as it would without a guard.
 */

const MARKER = '__leaveGuardMarker';

/** JSON with sorted keys, so two objects with the same content compare equal whatever their key order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * Whether a form's values differ from the ones it opened with. For a react-hook-form form that
 * edits through plain `setValue` calls (the address pickers, the selects), where the library's own
 * `isDirty` only notices edits made through `register` or `setValue(..., { shouldDirty })`:
 * `formValuesDiffer(form.watch(), defaults)`.
 */
export function formValuesDiffer(current: unknown, opened: unknown): boolean {
  return stable(current) !== stable(opened);
}

export function useLeaveGuard(dirty: boolean): {
  /** Cancel / a back link: ask if dirty, then go back one step. */
  leaveBack: () => void;
  /** The work is done: go to `to` without asking. */
  finish: (to: To, options?: NavigateOptions) => void;
  /** Render once, anywhere in the page. */
  leaveDialog: ReactNode;
} {
  const navigate = useNavigate();
  const id = useId();
  const setDirty = useSettingsGuard((s) => s.setDirty);
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const cancelPending = useSettingsGuard((s) => s.cancelPending);
  const pendingLeave = useSettingsGuard((s) => s.pendingLeave);

  const dirtyRef = useRef(dirty);
  // Whether our marker entry is the top of the history right now.
  const markerRef = useRef(false);
  // What to do when the popstate we caused (taking the marker off) arrives.
  const afterPopRef = useRef<(() => void) | null>(null);
  // Set once the user has answered (Discard) or the work is saved: the page is going, so the
  // browser must not ask a second time when the way out is a different document.
  const leavingRef = useRef(false);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    dirtyRef.current = dirty;
    navigateRef.current = navigate;
  });

  const pushMarker = useCallback(() => {
    if (markerRef.current) return;
    window.history.pushState({ ...(window.history.state ?? {}), [MARKER]: true }, '');
    markerRef.current = true;
  }, []);

  /** Run `go`, first taking our marker off the history if it is there. */
  const runLeave = useCallback((go: () => void) => {
    leavingRef.current = true;
    if (markerRef.current) {
      afterPopRef.current = go;
      window.history.back();
    } else {
      go();
    }
  }, []);

  // The shared guard the app's exit paths read, and the unsaved-work signal.
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => {
    return () => {
      setDirty(false);
      cancelPending();
    };
  }, [setDirty, cancelPending]);
  useEffect(() => {
    if (!dirty) return undefined;
    return registerUnsavedWork(id);
  }, [dirty, id]);

  // A reload or tab close: the browser's own prompt (its text is not ours to set).
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The Back button.
  useEffect(() => {
    if (dirty) {
      pushMarker();
    } else if (markerRef.current) {
      // Went clean (the user emptied what they typed): take the marker off so Back is not "one extra".
      afterPopRef.current = () => {};
      window.history.back();
    }
  }, [dirty, pushMarker]);
  useEffect(() => {
    const onPop = () => {
      const after = afterPopRef.current;
      if (after) {
        // The marker coming off because WE asked.
        afterPopRef.current = null;
        markerRef.current = false;
        after();
        return;
      }
      if (!markerRef.current) return;
      // The user's Back took the marker off: the page is still here.
      markerRef.current = false;
      if (dirtyRef.current) requestLeave(() => navigateRef.current(-1));
      else window.history.back(); // nothing left to guard: carry the Back on
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [requestLeave]);

  const leaveBack = useCallback(() => {
    requestLeave(() => navigateRef.current(-1));
  }, [requestLeave]);

  const finish = useCallback(
    (to: To, options?: NavigateOptions) => {
      runLeave(() => navigateRef.current(to, options));
    },
    [runLeave],
  );

  const keepEditing = useCallback(() => {
    leavingRef.current = false;
    cancelPending();
    if (dirtyRef.current) pushMarker();
  }, [cancelPending, pushMarker]);

  const discard = useCallback(() => {
    const go = useSettingsGuard.getState().pendingLeave;
    cancelPending();
    if (go) runLeave(go);
  }, [cancelPending, runLeave]);

  const leaveDialog = (
    <DiscardConfirm open={pendingLeave !== null} onKeepEditing={keepEditing} onDiscard={discard} />
  );

  return { leaveBack, finish, leaveDialog };
}
