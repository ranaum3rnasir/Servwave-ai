import { useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { SwitchValue } from '@/lib/api/permissionSwitches';

/**
 * Roles & Permissions: the change log of a role and of a person, read a page at a time, newest first.
 *
 * The one reader of `GET /api/roles/:role/change-log` and `GET /api/users/:id/permissions/change-log`. The server pages
 * by `limit` and `offset`; a page says whether older entries remain. Nothing here words an entry: the screen does that
 * from the switch catalog it already holds.
 */

/** One entry: who changed which switch from what to what, when, and why. */
export interface ChangeLogEntry {
  id: string;
  /** Null on the one entry a Save as role writes for the event itself. */
  switch_key: string | null;
  switch_label: string | null;
  from: SwitchValue | null;
  to: SwitchValue | null;
  /** manual | role assigned | reset | save as role | migration | role edit | erased */
  reason: string;
  /** The role a "role assigned" or "save as role" entry is about, by the name it had then. */
  role_label: string | null;
  created_at: string;
  /** Null for a migration, and for anything written with no person behind it. */
  actor: { id: string; name: string } | null;
}

interface ChangeLogPage {
  /** The number of entries in the log: sent with the first page only. */
  total: number | null;
  has_more: boolean;
  entries: ChangeLogEntry[];
}

/** Entries asked for at a time: a role edited for months holds thousands, a role assignment writes about 150 at once. */
export const CHANGE_LOG_PAGE_SIZE = 50;

/** Every change log's cache entries, so a write that adds entries can start them over. */
export const changeLogKey = ['permission-change-log'] as const;

/**
 * Start every open change log over from its newest page after a write. Refetching the pages already loaded would walk
 * a long log from the top; the entries a write adds are all at the top.
 */
export function resetChangeLogs(qc: QueryClient): void {
  void qc.resetQueries({ queryKey: changeLogKey });
}

function useChangeLogPages(key: readonly string[], path: string) {
  const query = useInfiniteQuery({
    queryKey: [...changeLogKey, ...key],
    queryFn: ({ pageParam }) =>
      api.get<ChangeLogPage>(path, { params: { limit: CHANGE_LOG_PAGE_SIZE, offset: pageParam } }).then((r) => r.data),
    initialPageParam: 0,
    // The next page starts after every entry already read.
    getNextPageParam: (last, pages) => (last.has_more ? pages.reduce((n, p) => n + p.entries.length, 0) : undefined),
    enabled: key.every((part) => part !== ''),
    // A log is dropped when its tab closes, so opening it again starts at the newest page instead of re-reading every
    // page that was scrolled through.
    gcTime: 0,
  });
  // A write while the log is open can slide an entry across a page edge: an entry seen twice is shown once.
  const seen = new Set<string>();
  const entries = (query.data?.pages ?? []).flatMap((p) => p.entries).filter((e) => !seen.has(e.id) && !!seen.add(e.id));
  return { ...query, entries };
}

/** A role's change log. The page mounts it only when the Change log tab is open, so nothing is read before then. */
export function useRoleChangeLog(role: string) {
  return useChangeLogPages(['role', role], `/api/roles/${role}/change-log`);
}

/** A person's change log, including their role assignments and resets. */
export function usePersonChangeLog(userId: string) {
  return useChangeLogPages(['person', userId], `/api/users/${userId}/permissions/change-log`);
}
