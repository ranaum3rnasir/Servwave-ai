import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { scopeWhereForReq } from '../permissions/enforce';
import { carriersOfNumbers, normalizeNAPhone } from '../comms-identity';
import { communicationScopeForReq } from './communicationScope';
import { customersInReach } from './numberCarriers';

/**
 * Guard the number (whole-diff security ruling, Ran 2026-11-07). Since #3021 a customer carrying a conversation's number
 * opens it, so the numbers a person may put on a customer decide what they read. At every PERSON door that makes a customer
 * carry a number (a phone field or phone-list row of the customer, or a phone entry of one of its leads or jobs), a number
 * that a customer the person cannot open already carries is refused, unless the person holds Communication "All". The
 * refusal names nobody. System paths (incoming webhooks, accretion from calls, automations, scripts) are not person doors
 * and are not asked.
 *
 * "Carries" is the identity module's one rule (`carriersOfNumbers`) and "can open" is the read side's customer reach
 * (`scopeWhereForReq(req, 'Customer')`, asked by `customersInReach`), so the guard and the reads cannot drift apart.
 */

/** The refusal every guarded door answers with (409, through `extractApiError`): it never says who carries the number. */
export const NUMBER_ON_CUSTOMER_OUT_OF_REACH =
  "This number is already on a customer you can't open. Ask someone who can open that customer to add it.";

/** The guard's refusal, thrown where a door applies a write deep inside a transaction (the office review's finish). */
export class NumberOutOfReachRefusal extends Error {
  readonly status = 409;
  constructor() {
    super(NUMBER_ON_CUSTOMER_OUT_OF_REACH);
  }
}

type Db = Pick<PrismaClient, '$queryRaw' | 'customer'>;

/**
 * May the person make customer `customerId` (null for one not made yet) carry these numbers? Each number is compared in the
 * spellings the rule compares; one that is no North American number is never carried, so it is never refused. The
 * customer being written is not asked about: it is the one the door already lets the person write to.
 */
export type NumberCarryCheck = (db: Db, numbers: readonly (string | null | undefined)[], customerId: string | null) => Promise<boolean>;

/**
 * The person's check, with their Communication scope and customer reach read now. Read it BEFORE a transaction opens and
 * pass the transaction's own client to the check: a query on another connection from inside a transaction waits for the
 * one the transaction holds (the hosted pool has one).
 */
export async function numberCarryCheckForReq(req: Request): Promise<NumberCarryCheck> {
  const organizationId = req.user!.organization_id;
  if ((await communicationScopeForReq(req)) === 'all') return async () => true;
  const customerScope = await scopeWhereForReq(req, 'Customer');
  return async (db, numbers, customerId) => {
    const wanted = [...new Set(numbers.map((n) => (n ? normalizeNAPhone(n) : null)).filter((n): n is string => n !== null))];
    if (wanted.length === 0) return true;
    const carriers = await carriersOfNumbers(db, organizationId, wanted);
    const others = [...new Set([...carriers.values()].flat().map((c) => c.id).filter((id) => id !== customerId))];
    if (others.length === 0) return true;
    const reached = await customersInReach(db, organizationId, others, customerScope);
    return others.every((id) => reached.has(id));
  };
}

/** The numbers among `sent` that are none of `held` (compared as North American numbers): the ones a write would add. */
export function numbersNotYetOn(sent: readonly (string | null | undefined)[], held: readonly (string | null | undefined)[]): string[] {
  const asE164 = (n: string | null | undefined) => (n ? normalizeNAPhone(n) : null);
  const have = new Set(held.map(asE164).filter((n): n is string => n !== null));
  return [...new Set(sent.map(asE164).filter((n): n is string => n !== null && !have.has(n)))];
}

/** The phones a customer of the company holds in its own fields: phone, second phone and the phones list. */
export async function phonesOnCustomer(organizationId: string, customerId: string): Promise<(string | null)[]> {
  const held = await prisma.customer.findFirst({
    where: { id: customerId, organization_id: organizationId },
    select: { phone: true, secondary_phone: true, phones: { select: { phone: true } } },
  });
  return held ? [held.phone, held.secondary_phone, ...held.phones.map((p) => p.phone)] : [];
}

/**
 * The new lead and new job forms' typed phone for an existing customer, which accretion adds to the customer's phones
 * list: may the person add it? The form fills in the customer's own phones, so a phone the customer already holds is not
 * asked about.
 */
export async function mayAddTypedPhoneForReq(req: Request, customerId: string, phone: string | null | undefined): Promise<boolean> {
  if (!phone) return true;
  const added = numbersNotYetOn([phone], await phonesOnCustomer(req.user!.organization_id, customerId));
  return (await numberCarryCheckForReq(req))(prisma, added, customerId);
}
