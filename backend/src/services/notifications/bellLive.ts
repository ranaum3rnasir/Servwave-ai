/**
 * The bell on the live line (#3473, services/live/liveLines.ts): when notification rows are written for people, each
 * of them who has a line open is told "the bell changed". The message carries no content: the screen reads its bell
 * again, after a random 0-2 s, and the read goes back through the API, which is where what a person may see is decided.
 *
 * - Sent only after the recipient rows are written (notificationService.ts: `emit` after its insert, `emitMany` after its
 *   one insert, never inside a transaction, so a write that rolls back never rings the bell). A caller's own transaction
 *   (`EmitArgs.tx`) has no "after commit" to wait for, so it sends nothing (and no caller passes one; the guard in
 *   __tests__/notification-live-publish-guard.test.ts fails if one starts to).
 * - One message per person per write: `emitMany` hands over every alert of its write at once.
 * - Notifications hidden from the bell (BELL_HIDDEN_VERBS: Spider's per-lead alerts and red-frame records) send nothing.
 * - Only to people who are recipients, and only on lines of the company the rows belong to (deliverLive).
 *
 * Never reads the database and never throws: a message that cannot be sent leaves the screen to its next check.
 * Logs carry ids and counts only.
 */
import { logger } from '../../lib/logger';
import { deliverLive } from '../live/liveLines';
import { BELL_HIDDEN_VERBS } from './bellHiddenVerbs';

/** The live message that tells a screen its bell changed. */
export const BELL_CHANGED = 'bell.changed';

/** One write of recipient rows: a notification's verb and the people its rows were written for. */
export interface BellWrite {
  organizationId: string;
  verb: string;
  recipientIds: readonly string[];
}

/** Tells the recipients (of the writes whose verb shows in the bell) that have a line open, one message each. */
export function publishBellChanged(writes: readonly BellWrite[]): void {
  try {
    const byOrg = new Map<string, Set<string>>();
    for (const w of writes) {
      if (BELL_HIDDEN_VERBS.includes(w.verb) || w.recipientIds.length === 0) continue;
      const people = byOrg.get(w.organizationId) ?? new Set<string>();
      for (const id of w.recipientIds) people.add(id);
      byOrg.set(w.organizationId, people);
    }
    for (const [orgId, people] of byOrg) {
      const lines = deliverLive(orgId, BELL_CHANGED, (p) => (people.has(p.id) ? {} : null));
      logger.debug('[notifications] bell message sent', { orgId, people: people.size, lines });
    }
  } catch (err) {
    logger.warn('[notifications] bell message not sent', { error: err instanceof Error ? err.name : 'unknown error' });
  }
}
