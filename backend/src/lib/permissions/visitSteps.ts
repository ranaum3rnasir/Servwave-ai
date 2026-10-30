import type { Request } from 'express';
import type { Subject } from './catalog';
import { prisma } from '../prisma';
import { canActOnRow } from './enforce';
import { jobLockedFor } from './jobLock';

/**
 * M3 - the access resolver's per-visit answer (Roles & Permissions, PRD 4): which status steps this person may take
 * on a visit. The job page reads it (the Visits card and the lifecycle bar show no button the server would refuse) and
 * the visit routes ask the very same function, so the screen and the door cannot disagree.
 *
 * A step is on the list only with the step's OWN switch (Mark on my way, Mark arrived, Start and finish visits for both
 * Start and Finish visit) AND either a place on that visit's crew or Update any visit's status. Update any visit's
 * status lifts the crew condition only, never the step's switch. The crew is read off the visit as it stands, so a
 * person taken off a visit loses its steps on the next request.
 *
 * On a job that is locked for this person (S04.22, jobLock.ts) no visit carries a step: a status step changes the
 * finished job, and only a holder of Change locked jobs may.
 */

/** The four steps, named as their routes are (POST /api/jobs/:id/visits/:visitId/<step>). */
export type VisitStep = 'en-route' | 'arrive' | 'start' | 'complete';

/** The Job ability each step's own switch grants. Finishing a visit rides Start and finish visits, like Start. */
const STEP_ABILITY: Record<VisitStep, 'en_route' | 'arrive' | 'start'> = {
  'en-route': 'en_route',
  arrive: 'arrive',
  start: 'start',
  complete: 'start',
};

/** Lifecycle order, which is the order the answer lists them in. */
export const VISIT_STEPS: readonly VisitStep[] = ['en-route', 'arrive', 'start', 'complete'];

/**
 * May this person step a job's or visit's status without being on the crew of what is stepped? Only with Update any
 * visit's status, and only on the jobs in their Jobs scope. It is the crew condition alone: the step's own switch is
 * asked separately.
 */
export async function mayStepWithoutCrew(req: Request, jobId: string): Promise<boolean> {
  if (!req.ability!.can('update_any_visit_status', 'Job' as Subject)) return false;
  return canActOnRow(req, 'Job', prisma.job, jobId, 'update_any_visit_status');
}

/** The steps this person may take on each of the job's visits, by visit id. */
export async function visitStepsFor(
  req: Request,
  jobId: string,
  visits: { id: string; assignees?: { user_id: string }[] | null }[],
): Promise<Record<string, VisitStep[]>> {
  const ownSwitch = VISIT_STEPS.filter((step) => req.ability!.can(STEP_ABILITY[step], 'Job' as Subject));
  const answer: Record<string, VisitStep[]> = {};
  if (await jobLockedFor(req, jobId)) {
    for (const visit of visits) answer[visit.id] = [];
    return answer;
  }
  // Nothing to look up when no step switch is held, and the any-visit lookup is one query per job, not per visit.
  const mayWithoutCrew = ownSwitch.length > 0 && visits.length > 0 && (await mayStepWithoutCrew(req, jobId));
  for (const visit of visits) {
    const onCrew = (visit.assignees ?? []).some((a) => a.user_id === req.user!.id);
    answer[visit.id] = onCrew || mayWithoutCrew ? [...ownSwitch] : [];
  }
  return answer;
}
