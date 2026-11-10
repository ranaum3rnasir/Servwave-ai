import type { Prisma, PrismaClient } from '@prisma/client';
import { carriersOfNumbers, customerName, type NumberCarrier } from '../comms-identity';
import { otherPartyE164 } from './otherPartyNumber';

/**
 * #3024 (#3013 Q41 and decision 1; Ran's rulings of 2026-11-06): which customers' leads and jobs a text or a call may be tied
 * to by a person ("Attach to a lead or job"). One rule for the re-tie routes and for the menu that offers the targets, so the
 * menu never offers what the server refuses:
 *
 * - `carriers`: some customer of the company carries the number. Only the leads and jobs of those carriers (in the fixed
 *   order); any other is refused. This replaces "same customer only".
 * - `any`: no customer carries the number (or a call has none). Any lead or job the person can open, as before.
 * - `filed`: a conversation from before pairs (no stored pair yet, #3019). Its same-customer rule, as before.
 *
 * The person's reach is their own Lead and Job scope, which always applies on top (the routes resolve the target under it,
 * and the menu lists only what it opens). A customer is named in the menu only through a lead or job of theirs the person
 * opens: the customer on a record is part of that record (Roles & Permissions S01.5), so a person who opens jobs but not the
 * Customers module still gets the menu.
 */
export type TieRule =
  | { kind: 'any' }
  | { kind: 'carriers'; carriers: NumberCarrier[] }
  | { kind: 'filed'; customerId: string };

type Db = Pick<PrismaClient, '$queryRaw' | 'phoneNumber'>;
type Where = Record<string, unknown>;

/** One query (the carriers of the number), none without a number. */
async function ruleForNumber(db: Db, organizationId: string, e164: string | null): Promise<TieRule> {
  if (!e164) return { kind: 'any' };
  const carriers = (await carriersOfNumbers(db, organizationId, [e164])).get(e164) ?? [];
  return carriers.length > 0 ? { kind: 'carriers', carriers } : { kind: 'any' };
}

/** The rule for a text in this conversation (`thread`: its stored pair number and the customer it is filed on). */
export async function textTieRule(
  db: Db, organizationId: string, thread: { other_party_e164?: string | null; customer_id?: string | null },
): Promise<TieRule> {
  if (thread.other_party_e164 == null) return thread.customer_id ? { kind: 'filed', customerId: thread.customer_id } : { kind: 'any' };
  return ruleForNumber(db, organizationId, thread.other_party_e164);
}

/** The rule for a call: the number of whoever is on the other end (the caller of an incoming call, the number dialled of an outgoing one). */
export async function callTieRule(
  db: Db, organizationId: string, call: { direction: string; from_number: string; to_number: string },
): Promise<TieRule> {
  const theirs = call.direction === 'in' ? call.from_number : call.to_number;
  return ruleForNumber(db, organizationId, await otherPartyE164(db as never, organizationId, theirs));
}

/** Whether the rule lets a text or a call be tied to a lead or job of this customer. */
export function tieAllowed(rule: TieRule, customerId: string): boolean {
  if (rule.kind === 'any') return true;
  if (rule.kind === 'filed') return rule.customerId === customerId;
  return rule.carriers.some((c) => c.id === customerId);
}

export interface AttachTargetGroup {
  customer: NumberCarrier;
  jobs: { id: string; number: string; location: string }[];
  leads: { id: string; number: string; detail: string }[];
}

/**
 * What the menu offers under the rule. `any`: nothing listed here; the screen searches every lead and job the person can open,
 * as before. Otherwise the leads and jobs the person can open of each customer the rule allows, grouped by customer in the
 * rule's order (cancelled jobs and lost leads left out, as the menu always did); a customer with none the person opens is left
 * out, so never named. A fixed number of queries however many customers carry the number: one for the jobs, one for the
 * leads, and for a conversation from before pairs one for its customer's name.
 */
export async function attachTargets(
  db: Pick<PrismaClient, 'customer' | 'job' | 'lead'>,
  organizationId: string,
  rule: TieRule,
  scopes: { job: Where; lead: Where },
): Promise<{ rule: 'any' | 'carriers'; groups: AttachTargetGroup[] }> {
  if (rule.kind === 'any') return { rule: 'any', groups: [] };
  const customers = rule.kind === 'carriers' ? rule.carriers : await filedCustomer(db, organizationId, rule.customerId);
  if (customers.length === 0) return { rule: 'carriers', groups: [] };
  const ids = customers.map((c) => c.id);
  const [jobs, leads] = await Promise.all([
    db.job.findMany({
      where: { AND: [{ organization_id: organizationId, customer_id: { in: ids }, status: { not: 'CANCELLED' } }, scopes.job] } as Prisma.JobWhereInput,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true, job_number: true, customer_id: true, service_location: { select: { address_line1: true } } },
    }),
    db.lead.findMany({
      where: { AND: [{ organization_id: organizationId, customer_id: { in: ids }, status: { not: 'LOST' } }, scopes.lead] } as Prisma.LeadWhereInput,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true, lead_number: true, customer_id: true, service_request: true },
    }),
  ]);
  const groups = customers.map((customer) => ({
    customer,
    jobs: jobs.filter((j) => j.customer_id === customer.id)
      .map((j) => ({ id: j.id, number: j.job_number, location: j.service_location?.address_line1 ?? '' })),
    leads: leads.filter((l) => l.customer_id === customer.id)
      .map((l) => ({ id: l.id, number: l.lead_number, detail: l.service_request ?? '' })),
  }));
  return { rule: 'carriers', groups: groups.filter((g) => g.jobs.length > 0 || g.leads.length > 0) };
}

/** The customer a conversation from before pairs is filed on, named (shown only with a lead or job of theirs the person opens). */
async function filedCustomer(db: Pick<PrismaClient, 'customer'>, organizationId: string, customerId: string): Promise<NumberCarrier[]> {
  const row = await db.customer.findFirst({
    where: { id: customerId, organization_id: organizationId },
    select: { id: true, first_name: true, last_name: true, company_name: true },
  });
  return row ? [{ id: row.id, name: customerName(row) }] : [];
}
