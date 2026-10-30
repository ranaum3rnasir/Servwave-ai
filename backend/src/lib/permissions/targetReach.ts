/**
 * "Can this person reach the record they are writing onto?" for a write that takes a target id in its body (M2).
 *
 * Log past communication, the call, text, WhatsApp and email doors and the manual-log entry routes all accept the id of a
 * lead, job or customer and stamp or touch it. Checking the tenant alone let a person write onto (and read back, and move)
 * a record they cannot open. These helpers are the one place that asks the existing reach (scope) layer, so the answer is
 * the same one the record's own routes give, and a record out of reach is a `null`/`false` the caller answers with the very
 * 404 a missing record gets.
 *
 * Every lookup carries `tenantWhere`, because `scopeWhereForReq` returns an empty fragment (no restriction, no query) for a
 * person whose scope is All, and that is not a tenancy check.
 */
import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { scopeWhereForReq } from './enforce';
import { canReadCustomerById } from './customerScope';

/** A scope fragment as an `AND` clause (nothing at all for an unrestricted scope), so it can never overwrite the `id` beside it. */
function inside(scope: Record<string, unknown>): { AND?: Record<string, unknown>[] } {
  return Object.keys(scope).length === 0 ? {} : { AND: [scope] };
}

/**
 * The `where` for one lead the person can open: this company, this id, inside the Leads scope.
 *
 * The scope goes INSIDE `AND`, never spread beside the id: a person whose scope reaches nothing (View leads off) gets the
 * "reaches nothing" fragment `{ id: { in: [] } }`, and spread at the top level that would overwrite `id` and make a
 * `findUnique` reject the query (a 500 where a missing record answers 404). Use it with `findFirst`.
 */
export async function leadReachWhere(req: Request, id: string): Promise<Record<string, unknown>> {
  return { id, ...tenantWhere(req), ...inside(await scopeWhereForReq(req, 'Lead')) };
}

/** The `where` for one job the person can open: this company, this id, inside the Jobs scope (see `leadReachWhere`). */
export async function jobReachWhere(req: Request, id: string): Promise<Record<string, unknown>> {
  return { id, ...tenantWhere(req), ...inside(await scopeWhereForReq(req, 'Job')) };
}

export async function canReachLead(req: Request, id: string): Promise<boolean> {
  return !!(await prisma.lead.findFirst({ where: await leadReachWhere(req, id), select: { id: true } }));
}

export async function canReachJob(req: Request, id: string): Promise<boolean> {
  return !!(await prisma.job.findFirst({ where: await jobReachWhere(req, id), select: { id: true } }));
}

/**
 * A customer the person can open on the Customers pages: this company, and inside the Customer reach (which View customers
 * turns on). For writing onto the customer's own record.
 */
export async function canReachCustomer(req: Request, id: string): Promise<boolean> {
  const row = await prisma.customer.findFirst({ where: { id, ...tenantWhere(req) }, select: { id: true } });
  return !!row && (await canReadCustomerById(req, id));
}

/**
 * A customer the person may CONTACT (call, text, email, start a conversation with): one they reach on the Customers pages,
 * or one that comes with a lead or job they can open. The customer on a record is part of that record, so a person who
 * holds a job can still text its customer with View customers off; a customer that is on nothing they can open is
 * refused, with the answer a missing customer gets.
 *
 * "A lead or job they can open" is asked of the very same Leads and Jobs reach `leadReachWhere` and `jobReachWhere` give, so
 * View leads off or View jobs off takes that half away (the reach fragment then matches nothing).
 */
export async function findCustomerToContact(req: Request, id: string): Promise<{ id: string } | null> {
  const row = await prisma.customer.findFirst({ where: { id, ...tenantWhere(req) }, select: { id: true } });
  if (!row) return null;
  if (await canReadCustomerById(req, id)) return row;
  const leadReach = await scopeWhereForReq(req, 'Lead');
  const jobReach = await scopeWhereForReq(req, 'Job');
  const viaRecord = await prisma.customer.findFirst({
    where: { id, ...tenantWhere(req), OR: [{ leads: { some: leadReach } }, { jobs: { some: jobReach } }] },
    select: { id: true },
  });
  return viaRecord ? row : null;
}
