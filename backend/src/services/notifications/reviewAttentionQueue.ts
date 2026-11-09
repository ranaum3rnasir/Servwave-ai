/**
 * reviewAttentionQueue.ts - where a writer leaves "tell the office about this" until the change has committed (Roles &
 * Permissions, PRD 6, S06.24; the job started, cancelled and reopened alerts ride it too, S06.25).
 *
 * The writers that land a change on a job's history (lib/job-change-history, lib/record-contact-history, the attachment
 * delete) run INSIDE the transaction of the change itself, and many controllers sit above them. An alert emitted from
 * there can be lost (its reads cannot see the uncommitted state), can fire for a write that rolls back, and on the hosted
 * pool a query on the global client from inside a transaction waits for a connection that never comes. So a writer only
 * QUEUES here, on the request it is part of (AsyncLocalStorage, no extra query), and the request flushes the queue once its
 * response has been sent with a success status (middleware/reviewAttentionScope). A request that failed alerts nobody, and
 * a request that lands several unusual items on one job sends ONE alert listing them.
 *
 * This module holds no database client and imports none, so the writers that load it stay cheap to load; the flush loads
 * the alert sender on first use.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../../lib/logger';
import type { JobLifecycleJob, JobLifecycleVerb } from './jobLifecycleAlerts';

/** One line of the alert: the panel's words for why it needs a look, and its title for the item. */
export interface AttentionItem {
  reason: string;
  title: string;
  /**
   * The invoices the item is about, when it is about any (an invoice line or discount, a file on an invoice). The review panel
   * leaves such an item out for a person who cannot open the invoice, so the alert leaves it out of their copy too.
   */
  invoiceIds?: string[];
}

export interface PendingAttention {
  orgId: string;
  /** The person who made the change; never someone for the alert. */
  actorId: string | null;
  /** The job the change landed on, or the invoice whose jobs it reached (an invoice file belongs to the jobs that hold it). */
  jobId?: string;
  invoiceId?: string;
  /** Only when the job turns out to be Done: a delete or detail change on a Done job alerts whatever it was. */
  onlyIfDone: boolean;
  items: AttentionItem[];
  /**
   * The job just moved to Ready to close (Finish review): the Ready to close alert is sent, not an attention alert. It rides this
   * queue for the same reason: its reads are many and none of them is the person's to wait for.
   */
  readyToClose?: boolean;
  /**
   * A job that just ENTERED Office review (Complete): the items already unusual in its window are read at the flush, after the
   * response, and listed; `items` is empty. The people are those the request already held.
   */
  entering?: { windowStart: Date; jobNumber: string; recordPeople: string[]; dispatcherId: string | null };
  /**
   * The job was started, cancelled or reopened (S06.25): the matching alert is sent (jobLifecycleAlerts), not an attention
   * alert; `items` is empty. It rides this queue for the same reason as the others: it is sent once the change committed and
   * the response went out, and its reads are many and none of them is the person's to wait for. The people are those the request
   * already held, read off the job it just wrote.
   */
  lifecycle?: { verb: JobLifecycleVerb; job: JobLifecycleJob; data?: Record<string, unknown> };
  /**
   * Any other alert that waits for the response (S06.26: the lead and estimate alerts; the next alert moves ride it too). The
   * sender reads what it needs when it runs, so the request holds nothing and costs nothing; it catches and logs its own
   * failures. `items` is empty.
   */
  later?: () => Promise<void>;
}

const scope = new AsyncLocalStorage<PendingAttention[]>();
const flushing = new Set<Promise<void>>();

/** Run one request with its own queue; `flush` is called with what was queued once the request ended well. */
export function runWithAttentionQueue<T>(run: () => T): { result: T; queue: PendingAttention[] } {
  const queue: PendingAttention[] = [];
  return { result: scope.run(queue, run), queue };
}

const memos = new WeakMap<PendingAttention[], Map<string, unknown>>();

/**
 * Something the alerts of ONE request share (an answer they would each read again): made the first time the request asks for it and
 * handed back to every later ask in the same request. Outside a request there is nothing to share it with, so it is made afresh.
 */
export function requestMemo<T>(key: string, make: () => T): T {
  const queue = scope.getStore();
  if (!queue) return make();
  let memo = memos.get(queue);
  if (!memo) {
    memo = new Map();
    memos.set(queue, memo);
  }
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as T;
}

export function queueReviewAttention(pending: PendingAttention): void {
  const queue = scope.getStore();
  if (!queue) {
    // A writer reached outside a request (nothing signed in): the move it makes still happens, only the alert has no moment to ride.
    logger.warn('[reviewAttention] a change landed outside a request, so no alert was raised', { jobId: pending.jobId ?? null });
    return;
  }
  queue.push(pending);
}

/**
 * Leave an alert for after the response. Inside a request it is sent once the response has gone out with a success status,
 * exactly like the alerts above. Outside one (a payment webhook's own background work, a job nobody is signed in to) there is
 * no response to wait for and nothing to ride, so it is sent at once without holding the caller; its sender logs its own failures.
 */
export function queueAlertAfterResponse(args: { orgId: string; actorId: string | null; send: () => Promise<void> }): void {
  const queue = scope.getStore();
  if (queue) {
    queue.push({ orgId: args.orgId, actorId: args.actorId, onlyIfDone: false, items: [], later: args.send });
    return;
  }
  const sending: Promise<void> = args.send()
    .catch((err) => {
      logger.warn('[reviewAttention] could not send an alert outside a request', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => flushing.delete(sending));
  flushing.add(sending);
}

/** Send what a finished request queued. Failures are logged by the sender and never thrown. */
export function flushReviewAttention(queue: PendingAttention[]): void {
  if (queue.length === 0) return;
  const sending: Promise<void> = import('./jobReviewAlerts.js')
    .then((m) => m.alertQueuedReviewAttention(queue))
    .catch((err) => {
      logger.warn('[reviewAttention] could not send the queued alerts', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => flushing.delete(sending));
  flushing.add(sending);
}

/** How many flushes are still sending (read by lib/after-response.ts's drain). */
export function reviewAttentionPending(): number {
  return flushing.size;
}

/** Resolves when every flush started so far has finished. For tests that must read the alerts a request left behind. */
export async function reviewAttentionSettled(): Promise<void> {
  // The response's own 'finish' may still be on its way to the event loop when the client has the answer.
  await new Promise((resolve) => setImmediate(resolve));
  while (flushing.size > 0) await Promise.all([...flushing]);
}
