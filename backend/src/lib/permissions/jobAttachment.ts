import { prisma } from '../prisma';
import { attachedReach } from './recordPeople';
import { substituteConditions } from './substituteConditions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is the person one of the people on this job (on the crew of any visit, its Sold By, or its Dispatcher)? Read from
 * the people on the job as they stand, so a person taken off it answers false on the very next call. The job page
 * asks it to decide whether to show the job's staging to someone whose stock switches are off (PRD 7).
 */
export async function isAttachedToJob(person: { id: string; organization_id: string }, jobId: string): Promise<boolean> {
  if (!UUID.test(jobId)) return false;
  const reach = substituteConditions(attachedReach('Job'), { userId: person.id })!;
  return !!(await prisma.job.findFirst({ where: { id: jobId, organization_id: person.organization_id, ...reach }, select: { id: true } }));
}
