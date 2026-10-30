import type { NextFunction, Request, Response } from 'express';
import type { JobStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { logger } from '../logger';
import { canActOnRow } from './enforce';
import { JOB_CLOSE_OUT_REFUSED, statusDoorAnswer, statusDoorRefusal, type StatusDoor } from '../job-close-out';
import { jobWindowMoved, resolveJobScheduleWindow, statedWindowMoves, type RawStatedWindow } from '../job-schedule-projection';
import { isLiveVisit } from '../visit-status';
import { CANONICAL_ID, isOtherSpellingOfId } from '../ids/canonicalId';

/**
 * The closed-job answer for every door that sets a job's status (Roles & Permissions, PRD 6, S06.17 and S06.18).
 *
 * A Done or Cancelled job leaves only through Reopen, so the status door, the calendar drag, unschedule, job-level Start
 * and Arrived, and bulk start and arrive all ask M7 (`statusDoorAnswer`) first and refuse with "Reopen this job first"
 * for everyone: a Change locked jobs holder and a Reopen Done jobs holder are refused like anyone else. This is a different
 * question from the completed-job lock (jobLock.ts), which a Change locked jobs holder passes, so it is asked BEFORE the
 * lock: a person the lock would have turned away is told what to do about it, not that the job is locked.
 *
 * A job in Office review or Ready to close is left by a backward move (S06.18), which needs the door's own switch and
 * Complete jobs. It is a close-out move, so the lock does not block it: when M7 allows the move, `statusDoorVerdict` says
 * `backward`, and the route's lock guard stands aside for this request. Job-level Arrived is never a backward move and is
 * refused there whatever the person holds.
 *
 * Like the lock, it never tells anyone the status of a job they cannot open: a job outside the person's reach falls
 * through to the door's own refusal.
 */

export interface StatusDoorVerdict {
  /** The plain reason the door is closed on this job for this person, or null while it is open. */
  reason: string | null;
  /** True when the door is making a backward move out of Office review or Ready to close that M7 allows: the lock does not bind it. */
  backward: boolean;
}

/** Does the person hold Complete jobs on this job (the switch and the job's row scope for it)? */
async function mayCompleteJob(req: Request, jobId: string): Promise<boolean> {
  return req.ability!.can('complete', 'Job') && (await canActOnRow(req, 'Job', prisma.job, jobId, 'complete'));
}

/**
 * M7's answer for a door on this job and this person. The door's own switch is the route's to check (it runs first), so it is
 * taken as held here; `status` is passed when the caller has it. A job the person cannot open is open to the door's own
 * refusal, never described.
 */
export async function statusDoorVerdict(req: Request, jobId: string, door: StatusDoor, status?: JobStatus): Promise<StatusDoorVerdict> {
  const current = status ?? (await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { status: true } }))?.status;
  if (!current) return { reason: null, backward: false };
  // Only a closed or reviewed job has anything to say; the others skip the reach and switch reads.
  const plain = statusDoorAnswer({ status: current, door, switches: { step_switch: true, complete_jobs: true } });
  if (plain.open && !plain.backward) return { reason: null, backward: false };
  if (!(await canActOnRow(req, 'Job', prisma.job, jobId, 'read'))) return { reason: null, backward: false };
  const answer = statusDoorAnswer({ status: current, door, switches: { step_switch: true, complete_jobs: await mayCompleteJob(req, jobId) } });
  return answer.open ? { reason: null, backward: answer.backward } : { reason: answer.reason, backward: false };
}

/** The reason a status door is closed on this job for this person, or null while it is open. `status` is passed when the caller has it. */
export async function statusDoorClosedReason(req: Request, jobId: string, status?: JobStatus, door: StatusDoor = 'schedule'): Promise<string | null> {
  return (await statusDoorVerdict(req, jobId, door, status)).reason;
}

/** The one refusal shape for a move M7 will not make: 409 with the machine-readable close-out code. */
export function respondStatusDoorClosed(res: Response, reason: string): void {
  res.status(409).json({ error: reason, code: JOB_CLOSE_OUT_REFUSED });
}

/** Set on the response by the door guard when the request is a backward move M7 allowed, so the lock guard stands aside. */
export const BACKWARD_MOVE_ALLOWED = 'backwardMoveAllowed';

/** Has the door guard already let this request through as an allowed backward move? */
export function isAllowedBackwardMove(res: Response): boolean {
  return res.locals?.[BACKWARD_MOVE_ALLOWED] === true;
}

/** Fail closed (security review, side finding): a uuid in any spelling but the canonical one names no job, so it is refused
 * here, never let through to a handler whose own lookup would still find the job by that spelling. */
const NOT_FOUND = (res: Response, what: 'Job' | 'Visit') => res.status(404).json({ error: `${what} not found` });

/**
 * Route guard for a door that sets the job's status: asks M7 and refuses with its words, for Done and Cancelled (the Reopen
 * rule, for everyone), for job-level Arrived in Office review and Ready to close, and for a backward move out of review from a
 * person who cannot complete jobs. When M7 allows a backward move it flags the response so the lock guard behind it stands
 * aside. It sits after the route's own switch guard and BEFORE the lock guard. A uuid in another spelling answers 404 "Job not
 * found"; a malformed id or a job that is not there falls through to the handler, which answers as it always has.
 *
 * `onlyWhenWindowMoves` is for the assign route, which serves two doors: a window that moves the job (the calendar drag, the
 * reschedule from the job) sets Scheduled, and a crew-only assign changes the crew and never the status, so that one stays
 * under the lock alone. The window is judged against the job's own, the way the handler judges it.
 */
export function refuseStatusDoorOnClosedJob(opts: { door: StatusDoor; onlyWhenWindowMoves?: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '');
      if (isOtherSpellingOfId(id)) {
        NOT_FOUND(res, 'Job');
        return;
      }
      if (!CANONICAL_ID.test(id)) {
        next();
        return;
      }
      const job = await prisma.job.findFirst({
        where: { id, ...tenantWhere(req) },
        select: {
          status: true,
          ...(opts.onlyWhenWindowMoves
            ? { visits: { select: { status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true } } }
            : {}),
        },
      });
      if (!job) {
        next();
        return;
      }
      if (opts.onlyWhenWindowMoves) {
        const visits = (job as { visits?: Parameters<typeof resolveJobScheduleWindow>[0] }).visits;
        if (!jobWindowMoved(resolveJobScheduleWindow(visits), (req.body ?? {}) as Parameters<typeof jobWindowMoved>[1])) {
          next();
          return;
        }
      }
      const verdict = await statusDoorVerdict(req, id, opts.door, job.status);
      if (verdict.reason) {
        respondStatusDoorClosed(res, verdict.reason);
        return;
      }
      if (verdict.backward) res.locals[BACKWARD_MOVE_ALLOWED] = true;
      next();
    } catch (err) {
      logger.error('Job status door check error:', err);
      res.status(500).json({ error: 'Failed to check the job' });
    }
  };
}

/**
 * Route guard for the Schedule's drag and resize of ONE visit (PATCH /:id/visits/:visitId): a move of the visit's time on a
 * Done or Cancelled job is the calendar drag, so it answers "Reopen this job first" like the job-level door (S06.17), for
 * everyone, a Change locked jobs holder included. The move is judged against the window the visit would END UP with (the
 * body's value where it states one, the stored value for the rest), so a body that names only the end or only the all-day
 * flag is a move like a full one. A request that leaves the visit's time alone (a note, a location, a crew restatement, the
 * same window sent back) is not a move and stays under the completed-job lock behind this guard. Office review and Ready to
 * close are not asked here: a visit write there stays under the lock and never moves the job's status. It sits after the
 * route's own switch guard and BEFORE the lock guard, and reads the body the way the handler does.
 */
export function refuseVisitMoveOnClosedJob() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '');
      const visitId = String(req.params.visitId ?? '');
      if (isOtherSpellingOfId(id) || isOtherSpellingOfId(visitId)) {
        NOT_FOUND(res, isOtherSpellingOfId(id) ? 'Job' : 'Visit');
        return;
      }
      if (!CANONICAL_ID.test(id) || !CANONICAL_ID.test(visitId)) {
        next();
        return;
      }
      const job = await prisma.job.findFirst({ where: { id, ...tenantWhere(req) }, select: { status: true } });
      if (!job || !statusDoorRefusal(job.status)) {
        next();
        return;
      }
      const visit = await prisma.visit.findFirst({
        where: { id: visitId, job_id: id, ...tenantWhere(req) },
        select: { scheduled_at: true, scheduled_end: true, is_all_day: true },
      });
      if (!visit || !statedWindowMoves({ scheduled_start: visit.scheduled_at, scheduled_end: visit.scheduled_end, is_all_day: visit.is_all_day }, (req.body ?? {}) as RawStatedWindow)) {
        next();
        return;
      }
      const verdict = await statusDoorVerdict(req, id, 'schedule', job.status);
      if (verdict.reason) {
        respondStatusDoorClosed(res, verdict.reason);
        return;
      }
      next();
    } catch (err) {
      logger.error('Job visit move door check error:', err);
      res.status(500).json({ error: 'Failed to check the job' });
    }
  };
}

/**
 * Route guard for the job edit (PATCH /:id) when it names a window: on a Done or Cancelled job whose visit is still live,
 * the edit lands the stated start on that visit, which is the calendar drag by another door, so it answers "Reopen this job
 * first" like the others (S06.17). Only a start the body states writes to a visit, and only a window that differs from the
 * stored one is a move; a closed job with no live visit has nothing to move and is answered by the new-visit door behind
 * this guard, in the same words. It sits after the route's own switch guard and BEFORE the lock guard.
 */
export function refuseJobEditMoveOnClosedJob() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '');
      const body = (req.body ?? {}) as RawStatedWindow;
      if (isOtherSpellingOfId(id)) {
        NOT_FOUND(res, 'Job');
        return;
      }
      if (!CANONICAL_ID.test(id)) {
        next();
        return;
      }
      if (body.scheduled_start === undefined) {
        next();
        return;
      }
      const job = await prisma.job.findFirst({
        where: { id, ...tenantWhere(req) },
        select: { status: true, visits: { select: { status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true } } },
      });
      if (!job || !statusDoorRefusal(job.status) || !job.visits.some(isLiveVisit) || !statedWindowMoves(resolveJobScheduleWindow(job.visits), body)) {
        next();
        return;
      }
      const verdict = await statusDoorVerdict(req, id, 'schedule', job.status);
      if (verdict.reason) {
        respondStatusDoorClosed(res, verdict.reason);
        return;
      }
      next();
    } catch (err) {
      logger.error('Job edit door check error:', err);
      res.status(500).json({ error: 'Failed to check the job' });
    }
  };
}
