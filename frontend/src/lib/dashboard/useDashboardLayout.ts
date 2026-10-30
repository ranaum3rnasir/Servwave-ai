import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { useCarryOverDashboardLayout, useDashboardLayoutQuery, useResetDashboardLayout, useSaveDashboardLayout, type DashboardLayoutAnswer } from '@/lib/api/dashboard';
import { readBrowserLayout } from './browserLayout';
import type { DashboardLayout, LayoutItem } from './layoutTypes';

/**
 * The signed-in person's dashboard layout, kept on the server (PRD 9): the same on every device. The server sends the
 * tiles to draw, in order; a hide, a move, a resize, a time-range choice or an added tile shows at once and is saved
 * straight away, with no save button. The browser keeps no copy of its own.
 *
 * The layout is empty until the server has answered (`loaded` is false), and stays empty for a role made from blank.
 * A tile the person has lost access to comes in the server's list flagged `available: false`. It is kept here out of
 * sight: the `layout` this hook gives the page leaves it out, so it is never drawn, counted or offered, while every
 * save sends the whole list with it in its place, as the server asked. Nothing is saved before the server's layout has
 * been read, so an edit can never replace a layout the page could not see.
 *
 * One time only (S09.5): when the server answers that nothing is saved for the person, the layout this browser kept
 * for THEM (if any) is sent over once and the server's copy is the layout from then on. The server decides, not the
 * browser: the carry-over is stored only if nothing is saved, and `saved` stays true after it, after any edit and after
 * a reset, so the browser copy is never read again. Nothing is sent before a read of the server has succeeded, and the
 * page waits for the carry-over to land (it draws no layout and takes no edit) so no edit is made on the default
 * and then overwritten. If the carry-over fails the default is drawn and the browser copy is kept for the next open.
 */
export function useDashboardLayout() {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  const query = useDashboardLayoutQuery();
  const { mutate: saveToServer } = useSaveDashboardLayout();
  const carryOver = useCarryOverDashboardLayout();
  const { mutate: resetOnServer } = useResetDashboardLayout();
  const answer = query.data;
  // Read the browser copy only for a person the server says has no saved layout, and only once per person.
  const nothingSaved = query.isSuccess && answer?.saved === false;
  const browserLayout = useMemo(() => (nothingSaved ? readBrowserLayout(userId) : null), [nothingSaved, userId]);
  const sentFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!browserLayout || sentFor.current === userId) return;
    sentFor.current = userId;
    carryOver.mutate(browserLayout);
  }, [browserLayout, carryOver, userId]);
  // Waiting for the carry-over to land. Once it has answered (or failed) the page draws what the server says: after a
  // success that is the stored layout, or the role's default if the server found nothing usable in the browser copy.
  const carrying = browserLayout !== null && !carryOver.isError && !carryOver.isSuccess;
  // The person's latest edit, drawn the moment it is made; the server's answer is what shows until they edit, and again
  // if a save fails. It belongs to the person who made it.
  const [edited, setEdited] = useState<{ userId: string | undefined; layout: DashboardLayout } | null>(null);
  // An answer without a list (an older server) is read as an empty layout rather than breaking the page.
  const fromServer: DashboardLayout = Array.isArray(answer?.layout) && !carrying ? answer.layout : [];
  // Everything the server holds for the person, lost tiles included: what an edit builds on and a save sends.
  const whole: DashboardLayout = edited && edited.userId === userId ? edited.layout : fromServer;
  const layout: DashboardLayout = useMemo(() => whole.filter((i) => i.available !== false), [whole]);
  // A layout the page already holds stays known when a later read of it fails; only a read that never answered leaves it unknown.
  const loaded = answer !== undefined && !carrying;
  // The server has not answered yet (or the one-time carry-over is landing): the page draws a loading state, not tiles.
  // A failed read is neither loaded nor loading, so the page does not wait on it for ever: it says it could not load
  // (`failed`) and offers a retry. Nothing is saved while the layout is unknown (`persist` needs `loaded`).
  const loading = query.isPending || carrying;
  const failed = query.isError && answer === undefined;
  const { refetch: readAgain, isFetching: reading } = query;
  const retry = useCallback(() => { void readAgain(); }, [readAgain]);

  const persist = useCallback(
    (next: DashboardLayout) => {
      if (!loaded) return;
      setEdited({ userId, layout: next });
      // Keep the cached answer current too, so a page opened again in this browser starts from the saved layout.
      queryClient.setQueryData<DashboardLayoutAnswer>(['dashboard-layout', userId], () => ({ layout: next, saved: true }));
      saveToServer(next, { onError: () => setEdited(null) });
    },
    [loaded, queryClient, saveToServer, userId],
  );

  const update = useCallback(
    (id: string, patch: Partial<LayoutItem>) => persist(whole.map((i) => (i.id === id && i.available !== false ? { ...i, ...patch } : i))),
    [whole, persist],
  );

  const reorder = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const arr = [...whole];
      const from = arr.findIndex((i) => i.id === fromId);
      const to = arr.findIndex((i) => i.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved!);
      persist(arr);
    },
    [whole, persist],
  );

  const add = useCallback(
    (id: string) => {
      const held = whole.find((i) => i.id === id);
      if (held?.available === false) return; // a tile the person cannot have is never turned on from here
      persist(held ? whole.map((i) => (i.id === id ? { ...i, visible: true } : i)) : [...whole, { id, visible: true }]);
    },
    [whole, persist],
  );

  // The server makes the layout (the default of the role the person is based on); what it answers is what shows, and
  // any edit shown on the screen gives way to it.
  const reset = useCallback(() => resetOnServer(undefined, { onSuccess: () => setEdited(null) }), [resetOnServer]);

  return { layout, loaded, loading, failed, retry, retrying: reading, update, reorder, add, reset };
}
