import { attachedReach, creatorReach, jobWorkReach } from './recordPeople';
import { substituteConditions } from './substituteConditions';
import type { ScopedSubject } from './switches/catalog';

/**
 * "Yours" (Roles & Permissions, PRD 9): the person's own records, as a Prisma `where` fragment.
 *
 * The jobs and leads the person is on (the same Attached rule every role uses), every estimate and invoice on
 * those jobs and leads whoever made it, and the estimates and invoices they made themselves while the creator rule
 * lets them open them. It is derived from the resolver's own fragments, never restated here, so a person taken off a
 * record loses it on the very next request.
 *
 * Money without See company figures is summed over this set whatever the person's Data Scope is: a company-wide sum
 * is a company figure.
 */
export function ownRecordsWhere(subject: ScopedSubject, userId: string): Record<string, unknown> {
  const attached = substituteConditions(attachedReach(subject), { userId })!;
  if (subject !== 'Estimate' && subject !== 'Invoice') return attached;
  const creator = substituteConditions(creatorReach(subject), { userId })!;
  return { OR: [attached, creator] };
}

/**
 * The jobs a person's own work reaches inside `scope` (Attached, Team or Location), as a Prisma `where` fragment to AND
 * onto that scope's reach: it drops a service plan's visit job whose only link to the person is the Sold By copied from
 * the plan (see `jobWorkReach`). The figures of finished work, such as Completed jobs value, use it so a plan's sale
 * is credited once, through the plan, and not again on every visit job.
 */
export function jobsOfOwnWorkWhere(
  scope: 'attached' | 'team' | 'location',
  person: { id: string; department_id?: string | null; location_id?: string | null },
): Record<string, unknown> {
  return substituteConditions(jobWorkReach(scope), { userId: person.id, teamId: person.department_id, locationId: person.location_id })!;
}
