import { prisma } from '../prisma';
import { isSuperUser } from './effectiveRole';
import { scopeWhereFor } from './scopeWhereFor';
import { compileSwitchGrants, resolveSwitchesForPeople } from './switches/store';

/**
 * The people, of those asked about, who can reach one logistic order (Roles & Permissions S07.9): active, in the company, and
 * with a read reach that takes in the order (an order on a job or lead they can open, or any order under Jobs scope All;
 * the Admin box reaches every order of its company). It is the order's own read rule, asked of many people at once: the
 * people are read once, their switches in a constant number of batched reads, and the order is probed once per DISTINCT reach
 * filter (people whose reach resolves to the same filter share one answer), never once per person.
 *
 * Nobody is "someone" here by role name; the caller says who is asked about, and the answer keeps the order given.
 */
export async function peopleWhoCanReachOrder(organizationId: string, orderId: string, candidateIds: string[]): Promise<string[]> {
  const wanted = [...new Set(candidateIds)];
  if (!wanted.length) return [];
  const people = await prisma.user.findMany({
    where: { id: { in: wanted }, organization_id: organizationId, is_active: true },
    select: {
      id: true, role: true, organization_id: true, custom_role_id: true, is_admin: true, department_id: true, location_id: true,
      custom_role: { select: { key: true } },
    },
  });
  if (!people.length) return [];

  const switches = await resolveSwitchesForPeople(people);
  const reaching = new Set<string>();
  const reached = new Map<string, Promise<number>>();
  for (const person of people) {
    const values = switches.get(person.id)!;
    // The Admin box reaches every order in its company.
    if (isSuperUser(person)) {
      reaching.add(person.id);
      continue;
    }
    const reads = compileSwitchGrants(values).filter((g) => g.action === 'read' && g.subject === 'LogisticOrder');
    const reach = scopeWhereFor(person, 'LogisticOrder', reads);
    // People whose reach resolves to the same filter (a company-wide reach, a shared department) get one answer.
    const reachKey = JSON.stringify(reach);
    if (!reached.has(reachKey)) {
      reached.set(reachKey, prisma.logisticOrder.count({ where: { id: orderId, organization_id: organizationId, ...reach } }));
    }
    if ((await reached.get(reachKey)!) > 0) reaching.add(person.id);
  }
  return wanted.filter((id) => reaching.has(id));
}
