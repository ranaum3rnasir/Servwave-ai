import { describe, it, expect } from 'vitest';
import { JobStatus } from '@prisma/client';
import { decideCloseOutMove, jobLevelArriveRefusal, statusDoorRefusal, statusDoorAnswer, reopenStartsFrom, REOPEN_FIRST_MESSAGE, type FinishReviewState, type MarkDoneState, type CancelState } from '../lib/job-close-out';

/** M7 (Roles & Permissions, PRD 6): the pure close-out state machine. Complete is the move S06.1 builds. */
describe('M7 close-out state machine: Complete', () => {
  const LIVE: JobStatus[] = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'];

  it.each(LIVE)('lands a job in Office review from %s for a person with Complete jobs', (status) => {
    expect(decideCloseOutMove({ move: 'complete', status, switches: { complete_jobs: true } })).toEqual({ allowed: true, next: 'OFFICE_REVIEW' });
  });

  it.each(LIVE)('refuses a job in %s without Complete jobs, and says it is a permission refusal', (status) => {
    const decision = decideCloseOutMove({ move: 'complete', status, switches: { complete_jobs: false } });
    expect(decision).toMatchObject({ allowed: false, kind: 'forbidden' });
  });

  it('refuses a cancelled job with "Reopen this job first", even for a holder', () => {
    expect(REOPEN_FIRST_MESSAGE).toBe('Reopen this job first');
    expect(decideCloseOutMove({ move: 'complete', status: 'CANCELLED', switches: { complete_jobs: true } })).toEqual({
      allowed: false, kind: 'status', reason: 'Reopen this job first',
    });
  });

  it.each(['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'COMPLETED'] as const)('refuses a job that is already past Complete (%s) for a holder', (status) => {
    const decision = decideCloseOutMove({ move: 'complete', status, switches: { complete_jobs: true } });
    expect(decision).toMatchObject({ allowed: false, kind: 'status' });
    expect((decision as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it('refuses a Done job the same way: the only way out is Reopen', () => {
    expect(decideCloseOutMove({ move: 'complete', status: 'DONE', switches: { complete_jobs: true } })).toMatchObject({ reason: REOPEN_FIRST_MESSAGE });
  });

  it('gives a distinct, plain reason for each place in the flow that refuses', () => {
    const reasons = (['CANCELLED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'COMPLETED'] as const).map(
      (status) => (decideCloseOutMove({ move: 'complete', status, switches: { complete_jobs: true } }) as { reason: string }).reason,
    );
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason).not.toMatch(/lost|closed/i);
  });

  it('decides every status the schema has: a holder is allowed from exactly the three live statuses', () => {
    const allowedFrom = Object.values(JobStatus).filter(
      (status) => decideCloseOutMove({ move: 'complete', status, switches: { complete_jobs: true } }).allowed,
    );
    expect([...allowedFrom].sort()).toEqual([...LIVE].sort());
  });
});

describe('M7 close-out state machine: job-level Arrived', () => {
  it('lets Arrived run on every status that is not taken over by the office', () => {
    for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] as const) expect(jobLevelArriveRefusal(status)).toBeNull();
  });

  it('points a job in office review or ready to close at the status menu', () => {
    for (const status of ['OFFICE_REVIEW', 'READY_TO_CLOSE'] as const) {
      expect(jobLevelArriveRefusal(status)).toBe("Arrived can't move a job in office review. Use the status menu to send it back.");
    }
  });

  it('refuses a Done or cancelled job with the Reopen rule', () => {
    for (const status of ['DONE', 'CANCELLED'] as const) expect(jobLevelArriveRefusal(status)).toBe(REOPEN_FIRST_MESSAGE);
  });
});

/** M7: Finish review (S06.12) moves a job from Office review to Ready to close, never to Done, and only for a person who read the review as it stands. */
describe('M7 close-out state machine: Finish review', () => {
  const asRead: FinishReviewState = { version: 'v1', sentVersion: 'v1', left: [] };
  const finish = (over: { status?: JobStatus; office_review?: boolean; review?: Partial<FinishReviewState> } = {}) =>
    decideCloseOutMove({
      move: 'finish_review',
      status: over.status ?? 'OFFICE_REVIEW',
      switches: { office_review: over.office_review ?? true },
      review: { ...asRead, ...over.review },
    });

  it('lands the job in Ready to close, never Done, when everything is checked and the version is current', () => {
    expect(finish()).toEqual({ allowed: true, next: 'READY_TO_CLOSE' });
  });

  it('is a permission refusal without Office review, whatever else is true (Complete jobs and Close jobs play no part)', () => {
    expect(decideCloseOutMove({ move: 'finish_review', status: 'OFFICE_REVIEW', switches: { office_review: false, complete_jobs: true }, review: asRead }))
      .toMatchObject({ allowed: false, kind: 'forbidden' });
  });

  it('is refused with any item unchecked, naming what is left', () => {
    const decision = finish({ review: { left: ['Job details'] } });
    expect(decision).toMatchObject({ allowed: false, kind: 'unchecked' });
    expect((decision as { reason: string }).reason).toContain('Job details');
  });

  it('is refused with a customer item unchecked while everything else is checked', () => {
    expect(finish({ review: { left: ['Phone'] } })).toMatchObject({ allowed: false, kind: 'unchecked' });
  });

  it('is refused with a stale version, in the PRD words', () => {
    expect(finish({ review: { sentVersion: 'v0' } })).toEqual({
      allowed: false,
      kind: 'stale',
      reason: 'Something changed on this job while you were reviewing. Check the new items and finish again.',
    });
  });

  it('is refused when the client sent no version at all', () => {
    expect(finish({ review: { sentVersion: null } })).toMatchObject({ allowed: false, kind: 'stale' });
  });

  it('says the version is stale before it lists what is left, because the list may be out of date', () => {
    expect(finish({ review: { sentVersion: 'v0', left: ['Job details'] } })).toMatchObject({ kind: 'stale' });
  });

  it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] as const)('is refused from %s: the job has not reached the review', (status) => {
    expect(finish({ status })).toMatchObject({ allowed: false, kind: 'status', reason: 'This job is not in office review.' });
  });

  it('says a review already finished is finished (the second of two people finishing at once)', () => {
    expect(finish({ status: 'READY_TO_CLOSE' })).toMatchObject({ allowed: false, kind: 'status', reason: 'This review has already been finished.' });
    expect(finish({ status: 'DONE' })).toMatchObject({ allowed: false, kind: 'status', reason: 'This review has already been finished.' });
  });

  it('points a cancelled job at Reopen', () => {
    expect(finish({ status: 'CANCELLED' })).toMatchObject({ allowed: false, kind: 'status', reason: REOPEN_FIRST_MESSAGE });
  });

  it('is allowed from exactly one status', () => {
    const allowedFrom = Object.values(JobStatus).filter((status) => finish({ status }).allowed);
    expect(allowedFrom).toEqual(['OFFICE_REVIEW']);
  });
});

/** M7: Mark Done (S06.13). Ready to close to Done only; money owed needs its own switch and a confirmed amount. */
describe('M7 close-out state machine: Mark Done', () => {
  type Over = { status?: JobStatus; switches?: { close_jobs?: boolean; close_jobs_with_money_owed?: boolean; office_review?: boolean }; markDone?: Partial<MarkDoneState> };
  const markDone = (over: Over = {}) =>
    decideCloseOutMove({
      move: 'mark_done',
      status: over.status ?? 'READY_TO_CLOSE',
      switches: { close_jobs: true, ...over.switches },
      markDone: { owedCents: 0, confirmedCents: null, ...over.markDone },
    });

  it('lands a Ready to close job in Done for a Close jobs holder when nothing is owed', () => {
    expect(markDone()).toEqual({ allowed: true, next: 'DONE' });
  });

  it('is a permission refusal without Close jobs, even with Close jobs with money owed on', () => {
    expect(markDone({ switches: { close_jobs: false, close_jobs_with_money_owed: true } })).toMatchObject({ allowed: false, kind: 'forbidden' });
  });

  it('is allowed from exactly one status', () => {
    const allowedFrom = Object.values(JobStatus).filter((status) => markDone({ status }).allowed);
    expect(allowedFrom).toEqual(['READY_TO_CLOSE']);
  });

  it('is refused from Office review with "Finish the office review first", also for a person holding both switches', () => {
    expect(markDone({ status: 'OFFICE_REVIEW', switches: { close_jobs: true, office_review: true, close_jobs_with_money_owed: true } })).toEqual({
      allowed: false, kind: 'status', reason: 'Finish the office review first',
    });
  });

  it('points a cancelled job at Reopen and says a Done job is already Done', () => {
    expect(markDone({ status: 'CANCELLED' })).toMatchObject({ allowed: false, kind: 'status', reason: REOPEN_FIRST_MESSAGE });
    expect(markDone({ status: 'DONE' })).toMatchObject({ allowed: false, kind: 'status', reason: 'This job is already Done.' });
  });

  it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] as const)('says a job in %s is not ready to close', (status) => {
    expect(markDone({ status })).toMatchObject({ allowed: false, kind: 'status', reason: 'This job is not ready to close.' });
  });

  it('refuses money owed without Close jobs with money owed, with the PRD words', () => {
    expect(markDone({ markDone: { owedCents: 12_500 } })).toEqual({
      allowed: false,
      kind: 'money_owed',
      reason: 'Money is still owed on this job. Only someone allowed to close jobs with money owed can mark it Done.',
    });
  });

  it('asks the holder of Close jobs with money owed to confirm the amount before the job goes Done', () => {
    const switches = { close_jobs: true, close_jobs_with_money_owed: true };
    expect(markDone({ switches, markDone: { owedCents: 12_500, confirmedCents: null } })).toMatchObject({ allowed: false, kind: 'amount' });
    expect(markDone({ switches, markDone: { owedCents: 12_500, confirmedCents: 12_500 } })).toEqual({ allowed: true, next: 'DONE' });
  });

  it('refuses an amount that no longer matches what is owed, and says what it is now', () => {
    const switches = { close_jobs: true, close_jobs_with_money_owed: true };
    const decision = markDone({ switches, markDone: { owedCents: 5_000, confirmedCents: 12_500 } });
    expect(decision).toMatchObject({ allowed: false, kind: 'amount' });
    expect((decision as { reason: string }).reason).toContain('$50.00');
  });

  it('refuses a confirmed amount when a payment has since cleared the balance', () => {
    expect(markDone({ switches: { close_jobs: true, close_jobs_with_money_owed: true }, markDone: { owedCents: 0, confirmedCents: 12_500 } }))
      .toMatchObject({ allowed: false, kind: 'amount' });
  });

  it('does not ask for an amount when nothing is owed', () => {
    expect(markDone({ markDone: { owedCents: 0, confirmedCents: null } })).toMatchObject({ allowed: true });
  });

  it('refuses when the money facts were not read (nobody closes a job over an amount nobody looked at)', () => {
    expect(decideCloseOutMove({ move: 'mark_done', status: 'READY_TO_CLOSE', switches: { close_jobs: true } })).toMatchObject({ allowed: false, kind: 'amount' });
  });

  it('never says "lost" in a refusal a person reads', () => {
    const reasons = [
      markDone({ status: 'OFFICE_REVIEW' }), markDone({ status: 'DONE' }), markDone({ status: 'IN_PROGRESS' }),
      markDone({ markDone: { owedCents: 100 } }),
    ].map((d) => (d as { reason: string }).reason);
    for (const reason of reasons) expect(reason).not.toMatch(/lost/i);
  });
});

/** The Cancel move (S06.15): from any status but Done, with a reason that the job's org list offers. */
describe('M7 close-out state machine: Cancel', () => {
  // The org's offered codes are an input to the machine (the route reads them from the org's list), never a copy of the built-ins.
  const OFFERED = ['PRICE', 'OTHER', 'WEATHER'];
  const cancel = (over: { status?: JobStatus; switches?: { cancel_jobs?: boolean }; cancel?: CancelState } = {}) =>
    decideCloseOutMove({
      move: 'cancel',
      status: over.status ?? 'IN_PROGRESS',
      switches: over.switches ?? { cancel_jobs: true },
      cancel: over.cancel ?? { reasonCode: 'PRICE', offeredCodes: OFFERED },
    });

  it('cancels from every status except Done, with an offered reason', () => {
    for (const status of Object.values(JobStatus).filter((s) => s !== 'DONE')) {
      expect(cancel({ status })).toEqual({ allowed: true, next: 'CANCELLED' });
    }
  });

  it('leaves Office review and Ready to close as cancellable: nothing about an open review blocks it', () => {
    expect(cancel({ status: 'OFFICE_REVIEW' })).toMatchObject({ allowed: true });
    expect(cancel({ status: 'READY_TO_CLOSE' })).toMatchObject({ allowed: true });
  });

  it('allows re-cancelling a cancelled job (the reason may change)', () => {
    expect(cancel({ status: 'CANCELLED' })).toEqual({ allowed: true, next: 'CANCELLED' });
  });

  it('refuses a Done job with "Reopen this job first", whatever the reason', () => {
    expect(cancel({ status: 'DONE' })).toEqual({ allowed: false, kind: 'status', reason: 'Reopen this job first' });
  });

  it('refuses without Cancel jobs, as a permission refusal', () => {
    expect(cancel({ switches: { cancel_jobs: false } })).toMatchObject({ allowed: false, kind: 'forbidden' });
    expect(cancel({ switches: {} })).toMatchObject({ allowed: false, kind: 'forbidden' });
  });

  it.each([null, undefined, '', '   '])('refuses a cancel with no reason (%j)', (reasonCode) => {
    expect(cancel({ cancel: { reasonCode, offeredCodes: OFFERED } })).toMatchObject({ allowed: false, kind: 'reason' });
  });

  it('refuses a code the org does not offer: an unknown code, a turned-off one and another org\'s', () => {
    // A turned-off reason is simply not among the offered codes; so is a code that only another org has.
    for (const reasonCode of ['NOT_A_REASON', 'DUPLICATE_JOB', 'price']) {
      expect(cancel({ cancel: { reasonCode, offeredCodes: OFFERED } })).toMatchObject({ allowed: false, kind: 'reason' });
    }
  });

  it('refuses when the offered list was not read', () => {
    expect(decideCloseOutMove({ move: 'cancel', status: 'IN_PROGRESS', switches: { cancel_jobs: true } })).toMatchObject({ allowed: false, kind: 'reason' });
  });

  it('allows an org-added reason', () => {
    expect(cancel({ cancel: { reasonCode: 'WEATHER', offeredCodes: OFFERED } })).toMatchObject({ allowed: true });
  });

  it('never lands a job anywhere but Cancelled, and never says "lost" in a refusal', () => {
    const nexts = new Set<string>();
    const reasons: string[] = [];
    for (const status of Object.values(JobStatus)) {
      for (const cancelState of [undefined, { reasonCode: 'PRICE', offeredCodes: OFFERED }, { reasonCode: 'X', offeredCodes: OFFERED }]) {
        const d = decideCloseOutMove({ move: 'cancel', status, switches: { cancel_jobs: true }, cancel: cancelState });
        if (d.allowed) nexts.add(d.next); else reasons.push(d.reason);
      }
    }
    expect([...nexts]).toEqual(['CANCELLED']);
    for (const reason of reasons) expect(reason).not.toMatch(/lost/i);
  });
});

describe('M7 close-out state machine: Reopen', () => {
  const reopen = (status: JobStatus, switches: { reopen_done_jobs?: boolean } = { reopen_done_jobs: true }) =>
    decideCloseOutMove({ move: 'reopen', status, switches });

  it.each(['DONE', 'CANCELLED'] as const)('sends a %s job back to In Progress for a holder of Reopen Done jobs', (status) => {
    expect(reopen(status)).toEqual({ allowed: true, next: 'IN_PROGRESS' });
  });

  it('still reopens a job left at Completed by the old flow, until the one-time move takes it to Done', () => {
    expect(reopen('COMPLETED')).toEqual({ allowed: true, next: 'IN_PROGRESS' });
  });

  it.each(['DONE', 'CANCELLED', 'COMPLETED'] as const)('is a permission refusal from %s without Reopen Done jobs', (status) => {
    expect(reopen(status, { reopen_done_jobs: false })).toMatchObject({ allowed: false, kind: 'forbidden' });
    expect(reopen(status, {})).toMatchObject({ allowed: false, kind: 'forbidden' });
  });

  it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'OFFICE_REVIEW', 'READY_TO_CLOSE'] as const)(
    'is refused from %s, because the job is not closed, also for a holder',
    (status) => {
      const decision = reopen(status);
      expect(decision).toMatchObject({ allowed: false, kind: 'status' });
      expect((decision as { reason: string }).reason).toMatch(/not closed/i);
    },
  );

  it('points a job in Office review or Ready to close at the status menu, not at Reopen', () => {
    for (const status of ['OFFICE_REVIEW', 'READY_TO_CLOSE'] as const) {
      const reason = (reopen(status) as { reason: string }).reason;
      expect(reason).toMatch(/status menu/i);
      expect(reason).not.toBe(REOPEN_FIRST_MESSAGE);
    }
  });

  it('is allowed from exactly Done, Cancelled and the old Completed', () => {
    const allowed = Object.values(JobStatus).filter((status) => reopen(status).allowed);
    expect(allowed.sort()).toEqual(['CANCELLED', 'COMPLETED', 'DONE']);
  });

  it('only ever lands a job in In Progress, and never says "lost" in a refusal', () => {
    for (const status of Object.values(JobStatus)) {
      const d = reopen(status);
      if (d.allowed) expect(d.next).toBe('IN_PROGRESS');
      else expect(d.reason).not.toMatch(/lost/i);
    }
  });

  it('lets the job page ask where Reopen starts without judging the status itself', () => {
    expect(reopenStartsFrom('DONE')).toBe(true);
    expect(reopenStartsFrom('CANCELLED')).toBe(true);
    expect(reopenStartsFrom('OFFICE_REVIEW')).toBe(false);
    expect(reopenStartsFrom('IN_PROGRESS')).toBe(false);
  });
});

describe('M7 close-out state machine: the doors that set a status', () => {
  it('refuses Done and Cancelled with the Reopen rule and no other status', () => {
    const refused = Object.values(JobStatus).filter((status) => statusDoorRefusal(status) !== null);
    expect(refused.sort()).toEqual(['CANCELLED', 'DONE']);
    for (const status of refused) expect(statusDoorRefusal(status)).toBe('Reopen this job first');
  });
});

/**
 * M7: the backward move (S06.18). A job leaves Office review or Ready to close for Scheduled, Unscheduled or In Progress only
 * for a person who holds the door's own switch AND Complete jobs. The words are the PRD's, written here and not read back from
 * the code.
 */
describe('M7 close-out state machine: the backward move out of review', () => {
  const NEEDS_COMPLETE = 'Only someone who can complete jobs can move this job out of office review.';
  const ARRIVED = "Arrived can't move a job in office review. Use the status menu to send it back.";
  const REVIEW = ['OFFICE_REVIEW', 'READY_TO_CLOSE'] as const;
  const TARGETS = ['SCHEDULED', 'UNSCHEDULED', 'IN_PROGRESS'] as const;

  const back = (status: JobStatus, target: JobStatus, switches: { step_switch?: boolean; complete_jobs?: boolean }) =>
    decideCloseOutMove({ move: 'back_out', status, target, switches });

  for (const status of REVIEW) {
    for (const target of TARGETS) {
      it(`refuses ${status} to ${target} with only the step's switch, in the PRD's words`, () => {
        expect(back(status, target, { step_switch: true })).toEqual({ allowed: false, kind: 'forbidden', reason: NEEDS_COMPLETE });
      });

      it(`allows ${status} to ${target} with the step's switch and Complete jobs, landing where it was sent`, () => {
        expect(back(status, target, { step_switch: true, complete_jobs: true })).toEqual({ allowed: true, next: target });
      });

      it(`refuses ${status} to ${target} with Complete jobs alone: the step's own switch is still needed`, () => {
        expect(back(status, target, { complete_jobs: true })).toMatchObject({ allowed: false, kind: 'forbidden' });
      });
    }

    it(`never sends ${status} to a close-out status or to Cancelled this way`, () => {
      for (const target of ['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'COMPLETED', 'CANCELLED'] as const) {
        expect(back(status, target, { step_switch: true, complete_jobs: true })).toMatchObject({ allowed: false, kind: 'status' });
      }
    });
  }

  it('refuses a Done or Cancelled job with the Reopen rule, whatever the person holds', () => {
    for (const status of ['DONE', 'CANCELLED'] as const) {
      expect(back(status, 'IN_PROGRESS', { step_switch: true, complete_jobs: true })).toEqual({ allowed: false, kind: 'status', reason: REOPEN_FIRST_MESSAGE });
    }
  });

  it('is not a backward move for a job that is not in review', () => {
    for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] as const) {
      expect(back(status, 'SCHEDULED', { step_switch: true, complete_jobs: true })).toMatchObject({ allowed: false, kind: 'status' });
    }
  });

  describe('statusDoorAnswer: what each door answers', () => {
    const answer = (status: JobStatus, door: 'start' | 'schedule' | 'unschedule' | 'arrive', complete_jobs: boolean) =>
      statusDoorAnswer({ status, door, switches: { step_switch: true, complete_jobs } });

    it('opens every door except Arrived on a job that is still being worked, as an ordinary move', () => {
      for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] as const) {
        for (const door of ['start', 'schedule', 'unschedule'] as const) expect(answer(status, door, false)).toEqual({ open: true, backward: false });
        expect(answer(status, 'arrive', false)).toEqual({ open: true, backward: false });
      }
    });

    it('treats Start, Schedule and Unschedule in review as a backward move for a Complete jobs holder and refuses the rest', () => {
      for (const status of REVIEW) {
        for (const door of ['start', 'schedule', 'unschedule'] as const) {
          expect(answer(status, door, true)).toEqual({ open: true, backward: true });
          expect(answer(status, door, false)).toEqual({ open: false, reason: NEEDS_COMPLETE });
        }
      }
    });

    it('refuses job-level Arrived on Office review, Ready to close, Done and Cancelled whatever the person holds', () => {
      for (const status of REVIEW) {
        for (const complete_jobs of [true, false]) expect(answer(status, 'arrive', complete_jobs)).toEqual({ open: false, reason: ARRIVED });
      }
      for (const status of ['DONE', 'CANCELLED'] as const) {
        for (const complete_jobs of [true, false]) expect(answer(status, 'arrive', complete_jobs)).toEqual({ open: false, reason: REOPEN_FIRST_MESSAGE });
      }
    });

    it('refuses every door on a Done or Cancelled job with the Reopen rule, a Complete jobs holder included', () => {
      for (const status of ['DONE', 'CANCELLED'] as const) {
        for (const door of ['start', 'schedule', 'unschedule'] as const) expect(answer(status, door, true)).toEqual({ open: false, reason: REOPEN_FIRST_MESSAGE });
      }
    });

    it('decides every status the schema has: a backward move is offered from exactly Office review and Ready to close', () => {
      const backward = Object.values(JobStatus).filter((status) => {
        const a = answer(status, 'schedule', true);
        return a.open && a.backward;
      });
      expect([...backward].sort()).toEqual(['OFFICE_REVIEW', 'READY_TO_CLOSE']);
    });
  });
});

/** S06.20: an unusual change on a Ready to close job sends it back to Office review. It is a system move: no switch is asked. */
describe('M7 close-out state machine: Ready to close returns to Office review', () => {
  const returnTo = (status: JobStatus) => decideCloseOutMove({ move: 'return_to_review', status, switches: {} });

  it('lands a Ready to close job in Office review, whatever the person who made the change holds', () => {
    expect(returnTo('READY_TO_CLOSE')).toEqual({ allowed: true, next: 'OFFICE_REVIEW' });
  });

  for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'OFFICE_REVIEW', 'DONE', 'CANCELLED', 'COMPLETED'] as const) {
    it(`leaves a job in ${status} where it is`, () => {
      expect(returnTo(status)).toMatchObject({ allowed: false, kind: 'status' });
    });
  }
});
