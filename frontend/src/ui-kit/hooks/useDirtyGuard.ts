import { useCallback, useEffect, useId, useRef, useState } from "react";

import { decideDismissal, type Dismissal } from "@/ui-kit/lib/dirtyGuard";
import { registerUnsavedWork } from "@/ui-kit/lib/unsavedWork";

/**
 * Nothing discards half-filled work without asking. An overlay states whether it is `dirty`; every
 * way out goes through `requestDismiss`, which asks the pure machine (`decideDismissal`) and either
 * closes, raises the "Keep editing" / "Discard" question, or ignores.
 *
 *   const guard = useDirtyGuard({ dirty, onClose });
 *   <Dialog open onOpenChange={guard.onOpenChange}> ... </Dialog>
 *   <DiscardConfirm {...guard.confirmProps} />
 *
 * Radix routes the scrim tap, Escape and the close button all through `onOpenChange(false)`, so
 * one handler covers them. A caller that leaves for another screen (a tap that navigates) passes
 * the navigation as `then`, which runs once the overlay has actually closed.
 *
 * While dirty the guard also: registers in the shared unsaved-work signal; asks the browser to
 * confirm a reload or tab close; and holds the Back button (a history marker is pushed, so Back
 * raises the question instead of leaving the screen).
 *
 * Work that is DONE is not a dismissal - call `closeNow` after a save so it never prompts.
 */

const BACK_MARKER = "__dirtyGuardMarker";
/** Pops this module caused itself (removing a marker): not a user pressing Back. */
let ownPops = 0;

export interface DirtyGuardOptions {
  dirty: boolean;
  /** Actually close the overlay. Called only once the question (if any) is answered. */
  onClose: () => void;
}

export function useDirtyGuard({ dirty, onClose }: DirtyGuardOptions) {
  const id = useId();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // What to do once the user has chosen Discard: any navigation that asked for the dismissal.
  const pending = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    onCloseRef.current = onClose;
    dirtyRef.current = dirty;
  });

  const requestDismiss = useCallback((dismissal: Dismissal, then?: () => void) => {
    const outcome = decideDismissal(dismissal, dirtyRef.current);
    if (outcome === "ignore") return outcome;
    if (outcome === "close") {
      onCloseRef.current();
      then?.();
      return outcome;
    }
    pending.current = then ?? null;
    setConfirmOpen(true);
    return outcome;
  }, []);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) requestDismiss("close");
    },
    [requestDismiss],
  );

  /** The work is done (saved): close without asking. */
  const closeNow = useCallback((then?: () => void) => {
    pending.current = null;
    setConfirmOpen(false);
    onCloseRef.current();
    then?.();
  }, []);

  const keepEditing = useCallback(() => {
    pending.current = null;
    setConfirmOpen(false);
  }, []);

  const discard = useCallback(() => {
    const then = pending.current;
    pending.current = null;
    setConfirmOpen(false);
    onCloseRef.current();
    then?.();
  }, []);

  // The shared unsaved-work signal, for exactly as long as the overlay is dirty.
  useEffect(() => {
    if (!dirty) return undefined;
    return registerUnsavedWork(id);
  }, [dirty, id]);

  // A reload or tab close: the browser's own prompt (its text is not ours to set).
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The Back button. The app uses the declarative router, which has no blocker, so while dirty a
  // marker entry sits on top of the history: Back pops the marker (the screen does not change),
  // we put it back and ask. Discard then closes the overlay, which is what Back means on a sheet.
  useEffect(() => {
    if (!dirty) return undefined;
    const push = () =>
      window.history.pushState({ ...(window.history.state ?? {}), [BACK_MARKER]: true }, "");
    push();
    const onPop = () => {
      if (ownPops > 0) return; // our own marker coming off, not the user pressing Back
      push();
      requestDismiss("navigation");
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Saved or closed with the marker still on top: take it off, so Back is not "one extra".
      if (window.history.state?.[BACK_MARKER]) {
        ownPops += 1;
        // Counted down in a LATER task, so every listener that sees this pop sees the count first,
        // including one registered after this cleanup but before the pop is delivered (React's
        // development double-run of effects does exactly that, and a browser delivers a history pop
        // asynchronously). Listener order cannot be relied on: Chromium and WebKit differ at window.
        window.addEventListener(
          "popstate",
          () => { setTimeout(() => { ownPops = Math.max(0, ownPops - 1); }, 0); },
          { once: true },
        );
        window.history.back();
      }
    };
  }, [dirty, requestDismiss]);

  return {
    requestDismiss,
    onOpenChange,
    closeNow,
    keepEditing,
    discard,
    confirmOpen,
    /** Spread onto `<DiscardConfirm />`. */
    confirmProps: { open: confirmOpen, onKeepEditing: keepEditing, onDiscard: discard },
  };
}
