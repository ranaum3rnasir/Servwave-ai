// #2049 — Read state is per user across the inbox; SMS threads get a persisted marker and
// email mark-read stops 403ing for SALES.
//
// Poll-merge half only (the backend half — the missing SMS route and the email route's
// `update`+`access_inbox` gate — lives in backend/src/__tests__/repro-2049.test.ts).
//
// Reproduced on prod (Pass A): `SmsInboxView.tsx`'s `openThread()` zeroes `unread` in local
// React state only (no mutation call), and the 20s poll's `mergeServerThreads` lets every
// server-known thread win wholesale (`return [...localOnly, ...server]` —
// mergeServerThreads.ts:17-19), discarding that local zero. So opening a thread "reads" it
// only until the next poll (LIVE_POLL_MS = 20_000, communication.ts:246) or reload restores
// the server's stale `unread` count.
//
// Desired behaviour (issue body): "the poll merge no longer overwrites it" — a thread the
// user has locally marked read must stay read across a server poll that has not caught up yet.
import { describe, it, expect } from 'vitest';
import { mergeServerThreads } from '@/lib/communication/mergeServerThreads';
import type { MessageThread } from '@/lib/api/communication-shared/phone-messages';

function thread(overrides: Partial<MessageThread> & { id: string }): MessageThread {
  return {
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [],
    ...overrides,
  };
}

describe('#2049 mergeServerThreads must not resurrect a locally-read thread as unread', () => {
  it('a thread the user just opened (unread: 0 locally) stays read after a server poll that has not caught up (still reports unread: 3) — today the server row wins wholesale and restores it', () => {
    const local = [thread({ id: 't1', customerId: 'c1', unread: 0 })];
    const server = [thread({ id: 't1', customerId: 'c1', unread: 3 })];

    const merged = mergeServerThreads(local, server);
    const merged1 = merged.find((t) => t.id === 't1');

    expect(merged1?.unread).toBe(0);
  });

  it('a genuinely NEW unread count from the server (never locally opened) still comes through', () => {
    // Control: the fix must not simply pin unread at whatever local last held forever — a
    // thread with no local knowledge yet (first poll) must take the server's real count.
    const local: MessageThread[] = [];
    const server = [thread({ id: 't2', customerId: 'c2', unread: 5 })];

    const merged = mergeServerThreads(local, server);
    const merged2 = merged.find((t) => t.id === 't2');

    expect(merged2?.unread).toBe(5);
  });
});
