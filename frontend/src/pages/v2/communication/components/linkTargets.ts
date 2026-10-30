import { senderLabel } from '@/lib/api/communication';
import type { Email } from '@/lib/api/communication';

/** A conversation a held message can be linked to: the latest message of each, as the page already holds them. */
export interface LinkTarget {
  threadId: string;
  subject: string;
  who: string;
  at: string;
  ts: number;
}

const REAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversations among these messages (one each, newest first). A row this page minted itself, not yet saved, is left out. */
export function linkTargetsOf(emails: readonly Email[]): LinkTarget[] {
  const latest = new Map<string, Email>();
  for (const e of emails) {
    if (!e.threadId || !REAL_ID.test(e.threadId) || e.folder === 'drafts') continue;
    const cur = latest.get(e.threadId);
    if (!cur || e.ts > cur.ts) latest.set(e.threadId, e);
  }
  return [...latest.values()]
    .sort((a, b) => b.ts - a.ts)
    .map((e) => ({
      threadId: e.threadId!,
      subject: e.subject || '(no subject)',
      who: e.direction === 'out' ? `To ${e.to}` : senderLabel(e.from),
      at: e.at,
      ts: e.ts,
    }));
}
