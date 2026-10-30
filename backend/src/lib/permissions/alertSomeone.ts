import { prisma } from '../prisma';
import { readersWithEntityAccess } from '../tasks/entityAccessCohort';
import type { EntityRef } from '../tasks/entityAccess';

/**
 * The alert "someone" test (Roles & Permissions, PRD 1, M3 "Alert recipients").
 *
 * A person is "someone" for an alert about a record when they are active, can open the record, and are not the
 * person who caused the alert. "Can open" is the access resolver's own answer (the same one that decides what a
 * list shows, from the person's switches and Data Scope), so an alert can never name a record to someone who could
 * not follow it. PRD 4's recipient lookup and PRD 6's alert moves ask this and nothing else about a candidate.
 *
 * `candidateIds` are the people the alert could go to; the answer is the subset that passes, in the order given.
 * A person from another company, a record that is not there and a record type the resolver does not know all leave
 * nobody in the answer. Batched: a constant number of reads however many candidates there are.
 */
export async function alertSomeone(args: {
  organizationId: string;
  candidateIds: string[];
  record: EntityRef;
  /** The person who caused the alert; they are never someone for it. */
  actorId: string | null;
}): Promise<string[]> {
  const wanted = [...new Set(args.candidateIds)].filter((id) => id !== args.actorId);
  if (!wanted.length) return [];
  const people = await prisma.user.findMany({
    where: { id: { in: wanted }, organization_id: args.organizationId, is_active: true },
    select: {
      id: true, role: true, organization_id: true, department_id: true, location_id: true,
      custom_role_id: true, is_admin: true, custom_role: { select: { key: true } },
    },
  });
  if (!people.length) return [];
  const { withAccess } = await readersWithEntityAccess(people, args.record);
  return wanted.filter((id) => withAccess.has(id));
}
