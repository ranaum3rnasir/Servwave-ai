import { create } from 'zustand';

/**
 * Shared unsaved-changes guard for the Settings shell (#113).
 *
 * The app uses the declarative <BrowserRouter>/<Routes> API, not a data router,
 * so react-router's `useBlocker` is unavailable (it throws "must be used within
 * a data router"). Instead the active settings page publishes its dirty state
 * here, and every exit path routes through `requestLeave`, which defers to the
 * shell's confirm dialog when there are unsaved changes:
 *   - Header user menu (My Profile / Settings) and Header comms buttons,
 *   - Header GlobalSearch result navigation,
 *   - the persistent top-bar ServWave brand logo (AppLayout),
 *   - the main Sidebar nav + Quick Create,
 *   - in-shell NavLinks + the X button,
 *   - intra-page jumps like the Roles role switch (RolesPage), which are NOT
 *     route changes and so could never be caught by a router blocker anyway.
 * SettingsLayout additionally guards SPA Back/Forward via a `popstate` listener
 * (routed through this store), and `beforeunload` covers full-page reload/close.
 */
interface SettingsGuardState {
  isDirty: boolean;
  /** A leave action awaiting the user's confirm/cancel, or null when none pending. */
  pendingLeave: (() => void) | null;
  setDirty: (dirty: boolean) => void;
  /** Run `go` now if clean; otherwise stash it and open the confirm dialog. */
  requestLeave: (go: () => void) => void;
  /** Confirm the pending leave (caller discards edits first). */
  resolvePending: () => void;
  /** Dismiss the dialog and keep editing. */
  cancelPending: () => void;
}

export const useSettingsGuard = create<SettingsGuardState>((set, get) => ({
  isDirty: false,
  pendingLeave: null,
  setDirty: (dirty) => set({ isDirty: dirty }),
  requestLeave: (go) => {
    if (get().isDirty) set({ pendingLeave: () => go() });
    else go();
  },
  resolvePending: () => {
    const go = get().pendingLeave;
    set({ pendingLeave: null });
    go?.();
  },
  cancelPending: () => set({ pendingLeave: null }),
}));
