import type { QueryClient } from '@tanstack/react-query';

/**
 * Query keys (and the reset of one family of them) that more than one API client file reads. They live here, in a
 * file that imports no API client, so a client can invalidate another client's cache without importing it.
 */

/** Shared query key — mutations invalidate this exact key. */
export const NUMBER_ASSIGNMENTS_KEY = ['communication', 'number-assignments'] as const;

export const SPIDER_UNREAD_KEY = ['spider', 'unread-alerts'] as const;

export const MAILBOXES_KEY = ['communication', 'mailboxes'] as const;

/** Every person's cached set: stale after a role change or an edit to a role. */
export const allPersonSwitchesKey = ['permission-switches', 'person'] as const;

/** Every change log's cache entries, so a write that adds entries can start them over. */
export const changeLogKey = ['permission-change-log'] as const;

/**
 * Start every open change log over from its newest page after a write. Refetching the pages already loaded would walk
 * a long log from the top; the entries a write adds are all at the top.
 */
export function resetChangeLogs(qc: QueryClient): void {
  void qc.resetQueries({ queryKey: changeLogKey });
}
