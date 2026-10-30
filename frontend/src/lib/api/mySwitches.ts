import { useQuery } from '@tanstack/react-query';
import type { SwitchSet } from '@/lib/api/permissionSwitches';
import api from '@/lib/axios';
import { registerStoreReset } from '@/lib/storeReset';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Roles & Permissions S02.19 - the signed-in person's own resolved switches.
 *
 * Thin TanStack Query wrapper over `GET /api/permission-switches/me`: the person's value for every switch (Show,
 * Access and list values included) beside the rules those values compile into. Menus read the values here; action
 * buttons keep reading the compiled rules (`useAppAbility`). The client only DRAWS from this - the server decides
 * access on every request - so a stale or missing answer can leave a menu entry out or in, never open a record.
 *
 * This is the ONLY reader of that route: the menu and every screen that draws a control from a switch (the job page
 * customer block, ...) share this hook, so they share one request and one cache and follow a role edit together.
 */
export type MySwitchValues = SwitchSet;

/** The person's own resolved value for every switch, and whether they hold the Admin box. */
export interface MySwitches {
  admin_box: boolean;
  values: MySwitchValues;
}

export const MY_SWITCHES_KEY = ['permission-switches', 'me'] as const;

const CACHE_PREFIX = 'servwave_my_switches:';

/**
 * The last answer for this person, kept so a reload draws the menu it drew last time instead of an empty one while
 * the fresh answer is on its way. Like the cached ability rules, it is display-only and replaced as soon as the
 * request lands. Wrapped throughout: storage can be missing or blocked, and the menu must still render without it.
 */
function readCachedAnswer(userId: string | undefined): MySwitches | undefined {
  if (!userId) return undefined;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + userId);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as MySwitches;
    if (!parsed || typeof parsed.values !== 'object' || !parsed.values) return undefined;
    return { admin_box: parsed.admin_box === true, values: parsed.values };
  } catch {
    return undefined;
  }
}

function writeCachedAnswer(userId: string, answer: MySwitches): void {
  try {
    localStorage.setItem(CACHE_PREFIX + userId, JSON.stringify(answer));
  } catch {
    // Storage unavailable: the menu just waits for the request next time.
  }
}

// Signing out drops the cached answer with the rest of the account's data.
registerStoreReset(() => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Nothing to clear.
  }
});

/** The one query behind every reader below: one key, one request, one cache. */
function useMySwitchesQuery() {
  const userId = useAuthStore((s) => s.user?.id);
  return useQuery<MySwitches>({
    queryKey: [...MY_SWITCHES_KEY, userId],
    enabled: !!userId,
    // A role edited while the person is signed in shows on their next visit to the tab.
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
    initialData: () => readCachedAnswer(userId),
    initialDataUpdatedAt: 0,
    queryFn: async () => {
      const { data: answer } = await api.get('/api/permission-switches/me');
      const result: MySwitches = { admin_box: answer.admin_box === true, values: answer.values ?? {} };
      if (userId) writeCachedAnswer(userId, result);
      return result;
    },
  });
}

/**
 * The signed-in person's resolved switches, or `undefined` until the first answer (or the cached last one) is in
 * (or when the read fails). A caller that needs a switch treats `undefined` as every switch off / "not shown yet".
 */
export function useMySwitches(): MySwitches | undefined {
  return useMySwitchesQuery().data;
}

/**
 * The same answer for a route guard, which must tell "no answer yet" (draw nothing, do not redirect) from "the read
 * failed" (the switch counts as off). `pending` is true only while there is neither a fresh nor a cached answer and
 * the request is still unsettled; once it settles empty, `answer` stays `undefined` and the guard refuses.
 *
 * `settled` is true once this visit has heard back from the server, with an answer or with a failure. Until then
 * `answer` may be the cached last one, which is good enough to open a route (a stale "yes" costs nothing: the server
 * decides every request) but not to refuse one: a switch turned on since the last visit must not bounce the person.
 * Guards read both through `routeAccess` below.
 */
export function useMySwitchesStatus(): { answer: MySwitches | undefined; pending: boolean; settled: boolean } {
  const { data, isPending, isError, dataUpdatedAt } = useMySwitchesQuery();
  // A cached answer carries no update time (see the query), so a time means the server has answered since.
  return { answer: data, pending: isPending, settled: dataUpdatedAt > 0 || isError };
}

/** What a route guard does with the person's switches: draw the route, draw nothing yet, or send them home. */
export type RouteAccess = 'allow' | 'wait' | 'refuse';

/**
 * The one rule behind every switch-driven route guard. An answer that allows the route opens it at once, cached or
 * fresh. An answer that does not allow it only refuses once the server has answered (or the read has failed), so
 * the guard draws nothing meanwhile; a failed read with no allowing answer refuses.
 */
export function routeAccess(
  status: { answer: MySwitches | undefined; settled: boolean },
  allows: (values: MySwitchValues) => boolean,
): RouteAccess {
  if (status.answer && allows(status.answer.values)) return 'allow';
  return status.settled ? 'refuse' : 'wait';
}

/** Whether a toggle switch is on. A switch the answer does not hold reads as off. */
export function switchOn(values: MySwitchValues | undefined, key: string): boolean {
  return values?.[key] === true;
}
