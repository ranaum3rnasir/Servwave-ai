import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { dashboardSeed } from '@/lib/api/_mock/dashboard';
import type { DashboardResponse } from '@/lib/api/_mock/dashboard';
import type { DashboardLayout } from '@/lib/dashboard/layoutTypes';
import { clearBrowserLayout } from '@/lib/dashboard/browserLayout';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

// Default to the LIVE backend in every environment — the controller now serves
// the full payload superset. The mock seed is opt-in only, via
// VITE_DASHBOARD_USE_MOCK=true (kept for offline scaffolding).
const USE_MOCK = import.meta.env.VITE_DASHBOARD_USE_MOCK === 'true';

// Re-export the shared types so components import them from the seam, never `_mock`.
export type {
  DashboardResponse, DashboardTileData, DashboardTileMeta, DashboardTileCategory, DashboardTileCategoryGroup, Insight, RevenuePoint, AttentionItem,
  TechSchedule, ScheduleJob, PipelineStage, ScoreboardEntry, LeadSource,
  StatusSlice, JobTypeSlice, ComingUpJob, UnscheduledJob, EstimateToSend, ReviewQueueJob, MissingCrewVisit, MissingOwnerLead, ActivityEvent,
} from '@/lib/api/_mock/dashboard';

/**
 * What a tile's entry holds when the server could not build it (its loader failed or ran out of time): the rest of the
 * answer is fine, and this one tile is drawn as an error with a way to try again, never as a figure.
 */
export function isTileError(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) && (entry as { error?: unknown }).error === true;
}

/** Tiles that are placeholders: the server has no loader for them, so they never have an entry in the answer's data. */
export const TILES_WITHOUT_DATA: readonly string[] = ['service_areas', 'recent_calls'];

/**
 * The home page's read computes only the tiles the layout shows, so the layout can show a tile the answer holds no
 * figures for: a layout change (the one-time carry-over, Reset, a tile added from the picker, tiles the server added
 * to the layout), whichever came while the first read was still on its way. ONE rule covers them all: once the layout
 * is known and no read is under way, if a tile it shows has no entry in the answer, read the dashboard again, once for
 * that set of missing tiles. A tile still without figures after that read (one the server could not build) is
 * `failed`, drawn as "Couldn't load" with a retry; it is never left waiting, and the page never reads again for the
 * same layout. `waiting` is true from the moment a tile is seen to lack figures until that one read has answered.
 *
 * The server builds the answer from the layout it has SAVED, so while a save of the layout is still on its way the read
 * is held back (and the tile waits): a read that overtook the save would come back without the tile and use up the one
 * read. The set is forgotten once nothing is missing, so a tile that goes missing again later gets its own read and
 * waits for it like the first time.
 */
export function useDashboardCoversLayout(
  dashboard: { data: DashboardResponse | undefined; isFetching: boolean; refetch: () => unknown },
  layout: DashboardLayout,
  layoutLoaded: boolean,
) {
  const { data: answer, isFetching, refetch } = dashboard;
  const saving = useIsMutating({ mutationKey: DASHBOARD_LAYOUT_SAVE_KEY }) > 0;
  const lacking = useMemo(() => {
    if (!layoutLoaded || !answer) return [];
    return layout
      .filter((entry) => entry.visible && entry.available !== false)
      .map((entry) => entry.id)
      .filter((id) => answer.tiles.some((t) => t.id === id) && !TILES_WITHOUT_DATA.includes(id) && (answer.data as Record<string, unknown>)[id] === undefined);
  }, [answer, layout, layoutLoaded]);
  const signature = lacking.join('|');
  // The set of missing tiles the one catch-up read has been asked for (read only inside the effect), and the set whose read
  // has answered (state, so the page draws the result).
  const asked = useRef('');
  const [answered, setAnswered] = useState('');
  // Nothing is missing any more: forget the answered set, so a tile that goes missing again waits for its own read.
  if (!signature && answered) setAnswered('');
  useEffect(() => {
    if (!signature) {
      asked.current = '';
      return;
    }
    if (isFetching || saving || asked.current === signature) return;
    asked.current = signature;
    void Promise.resolve(refetch()).finally(() => setAnswered(signature));
  }, [signature, isFetching, saving, refetch]);
  const waiting = signature !== '' && (saving || answered !== signature);
  return {
    /** The tile is shown but the answer holds nothing for it, and the one read that could bring it is not done. */
    isWaiting: (id: string) => waiting && lacking.includes(id),
    /** The tile is shown, the one read has answered, and there is still nothing for it: the server could not build it. */
    hasFailed: (id: string) => !waiting && lacking.includes(id),
  };
}

export interface DashboardParams {
  period?: '3M' | '6M' | '12M';
  date?: string;
  department_id?: string;
}

export function useDashboard(params: DashboardParams) {
  return useQuery<DashboardResponse>({
    queryKey: ['dashboard', params],
    queryFn: USE_MOCK
      ? () => Promise.resolve(dashboardSeed)
      : () =>
          api
            .get('/api/dashboard', {
              params: {
                period: params.period,
                date: params.date,
                department_id: params.department_id || undefined,
                // The home page's read: the server lists every tile the picker can offer but computes only the ones
                // the person's layout shows (a hidden or never-added tile costs the server nothing).
                shown: 1,
              },
            })
            .then((r) => r.data as DashboardResponse),
    staleTime: 60_000,
    refetchInterval: USE_MOCK ? false : 120_000,
  });
}

/**
 * The signed-in person's saved home-page layout (Roles & Permissions, PRD 9). `layout` is what to draw, in order: the
 * saved one, or the default of the person's role when they have saved none, and only tiles they may have. Every call
 * acts on the signed-in person; no id is ever sent.
 */
export interface DashboardLayoutAnswer {
  layout: DashboardLayout;
  /**
   * Whether the server holds a saved layout for the person. `layout` alone cannot say, because it is the role's default
   * until they save one. Only an explicit `false` means nothing is saved yet (S09.5: a layout the browser kept is then
   * carried over, once); a server that does not send it is read as "saved", so nothing is ever carried over by guess.
   */
  saved?: boolean;
}

const LAYOUT_URL = '/api/dashboard/layout';
/** Marks the layout save, so the dashboard read can tell that one is still on its way. */
const DASHBOARD_LAYOUT_SAVE_KEY = ['dashboard-layout-save'];
const CARRY_OVER_URL = `${LAYOUT_URL}/carry-over`;
const RESET_URL = `${LAYOUT_URL}/reset`;

/** The one place the page's layout is read from; the dashboard has no other reader of this route. */
export function useDashboardLayoutQuery() {
  const userId = useAuthStore((s) => s.user?.id);
  return useQuery<DashboardLayoutAnswer>({
    queryKey: ['dashboard-layout', userId],
    queryFn: USE_MOCK
      ? () => {
          const layout = dashboardSeed.tiles.map((t) => ({ id: t.id, visible: true }));
          return Promise.resolve({ layout, saved: true });
        }
      : () => api.get(LAYOUT_URL).then((r) => r.data as DashboardLayoutAnswer),
    // The page keeps its own copy current as the person edits, so a refetch must not overwrite an edit in flight.
    refetchOnWindowFocus: false,
  });
}

/**
 * Saves the whole layout for the signed-in person. The server refuses (409, `TILE_NOT_AVAILABLE`) only a save that would
 * show a tile the person has lost access to since the page last read; the only control that can send one is the picker's
 * add, so that refusal is told to the person in the server's own plain words. Any other failure stays as quiet as before.
 */
export function useSaveDashboardLayout() {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: DASHBOARD_LAYOUT_SAVE_KEY,
    mutationFn: (layout: DashboardLayout) =>
      USE_MOCK ? Promise.resolve({ layout, saved: true }) : api.put(LAYOUT_URL, { layout }).then((r) => r.data as DashboardLayoutAnswer),
    // A failed save leaves the screen ahead of the server: read the server's layout again so the two agree.
    onError: (err: unknown) => {
      queryClient.invalidateQueries({ queryKey: ['dashboard-layout', userId] });
      const refused = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
      if (refused?.status === 409 && refused.data?.code === 'TILE_NOT_AVAILABLE') {
        toast({ title: "That tile wasn't added", description: extractApiError(err, "That tile isn't available with your access."), variant: 'destructive' });
      }
    },
  });
}

/**
 * Moves the layout this browser kept to the server (S09.5). The server stores it only if nothing is saved for the
 * person, and answers with whatever is saved afterwards, so it can never replace a layout saved from another device.
 * Once the server has answered, its layout is the person's and the browser copy is cleared.
 */
export function useCarryOverDashboardLayout() {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (layout: DashboardLayout) => api.post(CARRY_OVER_URL, { layout }).then((r) => r.data as DashboardLayoutAnswer),
    onSuccess: (saved) => {
      queryClient.setQueryData<DashboardLayoutAnswer>(['dashboard-layout', userId], saved);
      clearBrowserLayout(userId);
    },
  });
}

/**
 * Puts the default of the person's role back as their saved layout (S09.6). The server makes the layout, cut to the tiles
 * the person may have, and answers with it; the cached answer then follows. The server replaces the saved row rather
 * than deleting it, so `saved` stays true and a browser copy is never carried over again.
 */
export function useResetDashboardLayout() {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (USE_MOCK) {
        return Promise.resolve<DashboardLayoutAnswer>({ layout: dashboardSeed.tiles.map((t) => ({ id: t.id, visible: true })), saved: true });
      }
      return api.post(RESET_URL).then((r) => r.data as DashboardLayoutAnswer);
    },
    onSuccess: (answer) => {
      queryClient.setQueryData<DashboardLayoutAnswer>(['dashboard-layout', userId], answer);
    },
  });
}
