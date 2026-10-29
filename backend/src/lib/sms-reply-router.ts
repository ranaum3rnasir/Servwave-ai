/**
 * SMS Reply Router — pure decision function for best-effort inbound-SMS job
 * attribution (Communication ↔ Jobs spec §7).
 *
 * SMS has no thread-id — only the number pair — so reply attribution can never
 * be exact. The policy is "act + cheap undo," never "ask first": silently
 * auto-attach the inbound message to the most-recently-texted-from *live* job
 * (recency-gated), and let the user reassign with one click if the guess is
 * wrong. The full customer thread stays canonical — a message's job_id is a
 * reassignable projection, so a wrong guess costs one click, while asking
 * first would cost a confirm dialog on every happy-path reply.
 *
 * When no candidate qualifies (cold inbound, all jobs closed, or all texts
 * stale), the function returns null → Message.job_id stays NULL → the message
 * lands in the per-customer Unrouted tray (the backstop; no new table).
 *
 * Pure I/O: no prisma, no clock — the caller passes `now` and the candidate
 * list, which keeps the decision deterministic and unit-testable.
 */

/** Only auto-route to a job texted-from within this many days of `now`. */
export const SMS_ROUTER_RECENCY_WINDOW_DAYS = 30;

/** JobStatus values considered closed — never auto-route to these. */
export const CLOSED_JOB_STATUSES = ['COMPLETED', 'CANCELLED'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface JobTextCandidate {
  jobId: string;
  jobLabel: string | null;
  /** When the most recent outbound SMS was sent from this job's context. */
  lastOutboundAt: Date;
  /** JobStatus enum value as a string (e.g. 'SCHEDULED', 'COMPLETED'). */
  jobStatus: string;
}

/**
 * Pick the job an inbound SMS should be attributed to, or null for the
 * Unrouted tray.
 *
 * Eligible candidates are NOT closed and were texted-from within the recency
 * window of `now` (the window edge itself counts as inside). Among eligible
 * candidates, the most recent `lastOutboundAt` wins.
 */
export function resolveInboundSmsJob(args: {
  now: Date;
  recentJobTexts: JobTextCandidate[];
}): { jobId: string; jobLabel: string | null } | null {
  const { now, recentJobTexts } = args;
  const windowMs = SMS_ROUTER_RECENCY_WINDOW_DAYS * DAY_MS;

  const eligible = recentJobTexts.filter(
    (c) =>
      !(CLOSED_JOB_STATUSES as readonly string[]).includes(c.jobStatus) &&
      now.getTime() - c.lastOutboundAt.getTime() <= windowMs
  );

  if (eligible.length === 0) return null;

  const winner = eligible.reduce((best, c) =>
    c.lastOutboundAt.getTime() > best.lastOutboundAt.getTime() ? c : best
  );

  return { jobId: winner.jobId, jobLabel: winner.jobLabel };
}
