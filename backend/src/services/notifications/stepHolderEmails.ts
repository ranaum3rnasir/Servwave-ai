/**
 * stepHolderEmails.ts - who a payment owner email goes to (Roles & Permissions, PRD 6, S06.29).
 *
 * The owner emails that ride beside the money and payments-account alerts (lib/owner-payment-notices, lib/payments-notifications) used
 * to go to every active person on the Admin role. They go to the same people the bell's step 2 and step 3 reach: the active holders of
 * the alert's step switch (Access Billing for invoice and payment money, who must also be able to open the invoice; the Admins
 * for the payments account, since the Company settings switch retired), else the Admins. Not the record's people, not the Dispatcher and not the
 * holders of an "Alert me about every ..." copy: an email is for whoever has to act. Nobody comes from a role name.
 *
 * One batched read of the company's people and their switches, one of the access check when there is an invoice to open, one of the
 * addresses, however large the company.
 */

import { prisma } from '../../lib/prisma';
import type { EntityRef } from '../../lib/tasks/entityAccess';
import { twoLaneRecipients } from './alertChain';

export async function stepHolderEmails(args: {
  organizationId: string;
  stepSwitch: string;
  /** The record the email is about when people must be able to open it (the invoice); null for a company-level notice. */
  record: EntityRef | null;
  /** Words for "nobody can ..." in the log line a chain that finds nobody leaves. */
  words: { record: string; step: string; alert: string };
}): Promise<string[]> {
  const answer = await twoLaneRecipients({
    organizationId: args.organizationId,
    record: args.record,
    actorId: null,
    recordPeople: [],
    dispatcherId: null,
    stepSwitch: args.stepSwitch,
    copySwitch: [],
    stepHoldersAlways: true,
    // The alert this email follows has logged the gap already.
    logGap: false,
    words: args.words,
  });
  if (!answer.laneTwo.length) return [];
  const people = await prisma.user.findMany({
    where: { id: { in: answer.laneTwo }, organization_id: args.organizationId, is_active: true },
    select: { email: true },
  });
  return people.map((p) => p.email);
}
