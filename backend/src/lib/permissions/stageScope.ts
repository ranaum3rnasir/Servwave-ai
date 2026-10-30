import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { isSuperUser } from './effectiveRole';
import { stageJobReach, stageReach } from './recordPeople';
import { scopeWhereFor } from './scopeWhereFor';
import { resolveSwitches } from './switches/store';
import type { PermissionUser } from './enforce';

/**
 * Staging reach (Roles & Permissions, PRD 7): which stages a person may open, and which jobs they may stage
 * onto. The rules live in `recordPeople` (`stageReach`, `stageJobReach`); this module resolves them for the
 * person from their switches and fits them to a Prisma `where`, with the same fail-closed handling of a
 * Team or Location scope for a person who has no team or location as every other reach.
 *
 * Nothing here is cached: a person taken off a job loses its stages on the very next request.
 */

type Where = Record<string, unknown>;

/** The row-scope engine takes a list of grants; an arm is a read grant carrying the arm's condition. */
const asReads = (resource: 'Job' | 'JobStage', arms: { conditions?: Where }[]) =>
  arms.map((arm) => ({ action: 'read', subject: resource, conditions: arm.conditions }));

/** The `where` over job stages the person reaches: `{}` for every stage, and a match-nothing fragment for none. */
export async function stageReachWhere(user: PermissionUser): Promise<Where> {
  if (isSuperUser(user)) return {};
  const arms = stageReach(await resolveSwitches(user));
  return scopeWhereFor(user, 'JobStage', asReads('JobStage', arms));
}

/** The `where` over jobs the person may put a stage on (or move one onto): `{}` for every job. */
async function stageJobWhere(user: PermissionUser): Promise<Where> {
  if (isSuperUser(user)) return {};
  const arms = stageJobReach(await resolveSwitches(user));
  return scopeWhereFor(user, 'Job', asReads('Job', arms));
}

/**
 * Whether a stage on this job (or on no job, `jobId` empty) is within the person's reach, for a stage that
 * does not exist yet or is being moved. A stage assigned to the person reaches them only after it exists, so
 * assignment never opens a job here.
 */
export async function canStageOnJob(req: Request, jobId: string | null | undefined): Promise<boolean> {
  const user = req.user;
  if (!user) return false;
  const jobWhere = await stageJobWhere(user);
  // Every job, and a stage on no job, is reached.
  if (Object.keys(jobWhere).length === 0) return true;
  if (!jobId) return false;
  return (await prisma.job.count({ where: { id: jobId, ...tenantWhere(req), ...jobWhere } })) > 0;
}
