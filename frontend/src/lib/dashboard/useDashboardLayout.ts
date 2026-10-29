import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import type { DashboardLayout, LayoutItem } from './layoutTypes';
import { DEFAULT_LAYOUT } from './defaultLayout';

const KEY = (uid: string) => `alpha:dashboard-layout:v1:${uid}`;

/** Reads the saved layout for a user out of localStorage, merged forward with
 * any default widgets the saved copy predates. Pure - safe to call from a
 * `useState` initializer as well as from the user-change effect below. */
function readLayout(userId: string): DashboardLayout {
  try {
    const raw = localStorage.getItem(KEY(userId));
    const saved: DashboardLayout = raw ? (JSON.parse(raw) as DashboardLayout) : DEFAULT_LAYOUT;
    // keep saved order/visibility, append any new default widgets not yet present
    const savedIds = new Set(saved.map((i) => i.id));
    return [...saved, ...DEFAULT_LAYOUT.filter((i) => !savedIds.has(i.id))];
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Per-user dashboard layout, persisted to localStorage. The hook is the seam:
 * swap to a backend store later without touching components. */
export function useDashboardLayout() {
  const userId = useAuthStore((s) => s.user?.id) ?? 'anon';
  // Lazy initializer: the saved layout is read synchronously into the first
  // commit, so a returning user's page paints once, already in their saved
  // order. The previous default-then-effect shape painted DEFAULT_LAYOUT on
  // commit 1 and the saved layout on commit 2, which is invisible on its own
  // but turns into a full-grid reshuffle animation once the page wraps cards
  // in framer-motion's `layout` prop - every customised user would see all
  // their cards slide from factory order into place on every mount.
  const [layout, setLayout] = useState<DashboardLayout>(() => readLayout(userId));

  // The lazy initializer only covers the FIRST render. If the authenticated
  // user changes without an unmount (e.g. a switch-user flow that reuses this
  // component instance), the layout still needs to re-hydrate for the new
  // user - so this effect stays, but it is a no-op on the mount render itself
  // (prevUserId already equals userId then) and only fires on an actual
  // userId change thereafter.
  const prevUserId = useRef(userId);
  useEffect(() => {
    if (prevUserId.current === userId) return;
    prevUserId.current = userId;
    // Re-hydrates the layout for a user switch that happens without a remount;
    // the mount-time read is handled by the lazy useState initializer above.
    setLayout(readLayout(userId));
  }, [userId]);

  const persist = useCallback(
    (next: DashboardLayout) => {
      setLayout(next);
      try {
        localStorage.setItem(KEY(userId), JSON.stringify(next));
      } catch {
        /* ignore quota / disabled storage */
      }
    },
    [userId],
  );

  const update = useCallback(
    (id: string, patch: Partial<LayoutItem>) => persist(layout.map((i) => (i.id === id ? { ...i, ...patch } : i))),
    [layout, persist],
  );

  const reorder = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const arr = [...layout];
      const from = arr.findIndex((i) => i.id === fromId);
      const to = arr.findIndex((i) => i.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved!);
      persist(arr);
    },
    [layout, persist],
  );

  const add = useCallback(
    (id: string) => {
      if (layout.some((i) => i.id === id)) {
        persist(layout.map((i) => (i.id === id ? { ...i, visible: true } : i)));
      } else {
        persist([...layout, { id, visible: true }]);
      }
    },
    [layout, persist],
  );

  const reset = useCallback(() => persist(DEFAULT_LAYOUT), [persist]);

  return { layout, update, reorder, add, reset };
}
