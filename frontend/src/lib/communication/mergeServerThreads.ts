import type { Message, MessageThread } from '@/lib/api/communication';

/** #2049 (Reviewer amendment R3) - true when the SERVER row carries a
 *  not-outbound message (`direction !== 'out'`) whose `ts` is strictly newer
 *  than the LOCAL row's newest message. A local row with no messages compares
 *  against -Infinity, so any not-outbound server message counts as newer -
 *  case (a): a first-poll zero must never mask a real inbound.
 *
 *  #2049 (validator r1) - `messages` is coerced to `[]` on BOTH rows: a row
 *  can carry `messages: undefined` (a list payload that does not embed every
 *  thread's messages), and this function must stay total rather than throw
 *  on `.reduce`/`.some` of `undefined`. */
function serverHasNewerInboundMessage(local: MessageThread, server: MessageThread): boolean {
  const localMessages = local.messages ?? [];
  const serverMessages = server.messages ?? [];
  const localNewestTs = localMessages.reduce(
    (max, m) => Math.max(max, new Date(m.ts).getTime()),
    -Infinity,
  );
  return serverMessages.some(
    (m: Message) => m.direction !== 'out' && new Date(m.ts).getTime() > localNewestTs,
  );
}

/** Merge server threads into local state by id - server rows win, optimistic
 * local-only threads (unsaved team/group lanes, still-posting customer
 * threads) stay on top. A local customer thread is dropped once the server's
 * thread for that customer arrives (the send's find-or-create lands in the
 * seed), so polling never duplicates a conversation. Pure + convergent -
 * merge(merge(prev, seed), seed) === merge(prev, seed) - so the seed effect
 * can re-run safely (the jsdom seed-effect-loop hazard).
 *
 * #2049 (R3) - ONE exception to "server wins": when the local row was just
 * marked read (`unread === 0`) and the server row carries NO not-outbound
 * message newer than the local row's newest message, the poll has not caught
 * up yet - keep `unread: 0` on the (otherwise server-sourced) row. A
 * genuinely newer inbound still takes the server's real count. */
export function mergeServerThreads(
  local: MessageThread[],
  server: MessageThread[],
): MessageThread[] {
  const localById = new Map(local.map((t) => [t.id, t]));
  const serverIds = new Set(server.map((t) => t.id));
  const serverCustomerIds = new Set(server.map((t) => t.customerId).filter(Boolean));
  const localOnly = local.filter(
    (t) => !serverIds.has(t.id) && !(t.customerId && serverCustomerIds.has(t.customerId)),
  );
  const merged = server.map((s) => {
    const l = localById.get(s.id);
    if (l && l.unread === 0 && !serverHasNewerInboundMessage(l, s)) {
      return { ...s, unread: 0 };
    }
    return s;
  });
  return [...localOnly, ...merged];
}
