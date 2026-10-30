import type { Prisma } from '@prisma/client';

/**
 * The office review queue rule (Roles & Permissions, PRD 6): what waits for this person, and how many.
 *
 * Two queues, each belonging to one switch rather than to a role name:
 *   - Office review: jobs in Office review, counted for a holder of Office review (action `office_review` on Job)
 *   - Ready to close: jobs Ready to close, counted for a holder of Close jobs (action `close` on Job)
 * Both count only the jobs the person can open, so the caller passes the person's Jobs row scope (the same
 * `scopeWhereForReq(req, 'Job')` the Jobs list uses); a person who can open no job counts none.
 *
 * ONE rule, read by every surface that shows the queue: the Jobs menu count, the Jobs page tiles and their
 * click-throughs, and PRD 9's dashboard tile. Each takes its count and its rows from the clauses here, so the
 * numbers cannot disagree. A queue the person does not hold is left out of the answer altogether: the shape never
 * tells a person without Office review how many jobs are in review.
 */

/** The part of a person's ability the rule asks about. */
export interface ReviewQueueAbility {
  can(action: string, subject: string): boolean;
}

/** The part of the database client the counts need (the real client, or a transaction). */
export interface JobCounter {
  job: { count(args: { where: Prisma.JobWhereInput }): Promise<number> };
}

/** Which queues a person holds. */
export function heldReviewQueues(ability: ReviewQueueAbility | undefined): { office_review: boolean; ready_to_close: boolean } {
  return {
    office_review: Boolean(ability?.can('office_review', 'Job')),
    ready_to_close: Boolean(ability?.can('close', 'Job')),
  };
}

/** The job set of the Office review queue, before any person's reach is applied. */
export function officeReviewClause(): Prisma.JobWhereInput {
  return { status: 'OFFICE_REVIEW' };
}

/** The job set of the Ready to close queue, before any person's reach is applied. */
export function readyToCloseClause(): Prisma.JobWhereInput {
  return { status: 'READY_TO_CLOSE' };
}

/**
 * The `where` of each queue the person holds, within `scopeWhere` (tenant plus the person's Jobs row scope); a queue
 * the person does not hold is `null`. Composed under AND so a status the scope or a filter carries can never replace
 * the queue's own.
 */
export function reviewQueueWheres(
  ability: ReviewQueueAbility | undefined,
  scopeWhere: Prisma.JobWhereInput,
): { office_review: Prisma.JobWhereInput | null; ready_to_close: Prisma.JobWhereInput | null } {
  const held = heldReviewQueues(ability);
  return {
    office_review: held.office_review ? { AND: [scopeWhere, officeReviewClause()] } : null,
    ready_to_close: held.ready_to_close ? { AND: [scopeWhere, readyToCloseClause()] } : null,
  };
}

/** What the queue count answers: a count for each queue the person holds, and the sum the menu shows. */
export interface ReviewQueueCounts {
  office_review?: number;
  ready_to_close?: number;
  total: number;
}

/** The counts of the queues the person holds, within `scopeWhere`. A person who holds neither gets `{ total: 0 }`. */
export async function countReviewQueue(
  db: JobCounter,
  ability: ReviewQueueAbility | undefined,
  scopeWhere: Prisma.JobWhereInput,
): Promise<ReviewQueueCounts> {
  const wheres = reviewQueueWheres(ability, scopeWhere);
  const [review, ready] = await Promise.all([
    wheres.office_review ? db.job.count({ where: wheres.office_review }) : Promise.resolve(undefined),
    wheres.ready_to_close ? db.job.count({ where: wheres.ready_to_close }) : Promise.resolve(undefined),
  ]);
  return {
    ...(review !== undefined ? { office_review: review } : {}),
    ...(ready !== undefined ? { ready_to_close: ready } : {}),
    total: (review ?? 0) + (ready ?? 0),
  };
}
