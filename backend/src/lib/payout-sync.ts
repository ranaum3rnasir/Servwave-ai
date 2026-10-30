/**
 * Payments go-live slice P2 - ServWave's own record of a company's payouts.
 *
 * One writer for the three things that fill the payouts table: the payout events (the payment
 * event reconciler), the nightly reconcile and the backfill script. It upserts the row for the company
 * that owns the connected account and links the company's payments whose balance transaction is in the
 * payout. An end state is never replaced by a different end state from an event snapshot (events arrive
 * out of order); only the processor's current state (`current: true`) may do that. It writes ServWave's bookkeeping only: never a payment's money fields, and never another
 * company's payment (the link is scoped to the company through the payment's invoice).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { listAccountPayouts, listPayoutBalanceTransactions } from './stripe';
import type { ProcessorPayout } from '../services/payment-reconciler/decide';

export type PayoutStatus = 'PENDING' | 'IN_TRANSIT' | 'PAID' | 'FAILED' | 'CANCELED';

const TERMINAL: readonly PayoutStatus[] = ['PAID', 'FAILED', 'CANCELED'];

/** The processor's payout status, in ServWave's. An unknown status reads as pending. */
export function payoutStatusOf(processorStatus: string): PayoutStatus {
  switch (processorStatus) {
    case 'paid': return 'PAID';
    case 'in_transit': return 'IN_TRANSIT';
    case 'failed': return 'FAILED';
    case 'canceled': return 'CANCELED';
    default: return 'PENDING';
  }
}

/** "Bank name ••1234", in ServWave's words: a bank name that carries the processor's name is not shown. */
export function destinationLabelOf(destination: ProcessorPayout['destination']): string | null {
  if (!destination || typeof destination === 'string') return null;
  const last4 = destination.last4 || null;
  const bank = destination.bank_name && !/stripe/i.test(destination.bank_name) ? destination.bank_name : null;
  if (!last4) return bank;
  return `${bank ?? 'Bank account'} ••${last4}`;
}

/** payout_summary.bank_label of the company, when the account sync stored one. */
function summaryBankLabel(summary: Prisma.JsonValue | null | undefined): string | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const label = (summary as Record<string, unknown>).bank_label;
  return typeof label === 'string' && label ? label : null;
}

export type PayoutDb = Pick<Prisma.TransactionClient, 'payout' | 'payment' | 'organization'>;

/** The calendar day (UTC midnight), which is all the arrival_date column keeps. */
const dayOf = (d: Date | null): Date | null => (d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null);

const unixDate = (unix: number | null | undefined): Date | null => (typeof unix === 'number' ? new Date(unix * 1000) : null);

/**
 * Upsert the payouts row for `organizationId` and, when `balanceTransactionIds` is given, link the
 * company's payments in it. Returns the row id, or null when the payout id already belongs to another
 * company (never written to).
 */
export async function syncPayout(
  db: PayoutDb,
  organizationId: string,
  payout: ProcessorPayout,
  balanceTransactionIds?: string[],
  opts: { current?: boolean } = {},
): Promise<{ id: string; linked: number } | null> {
  const incoming = payoutStatusOf(payout.status);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { payout_summary: true } });
  const summaryLabel = summaryBankLabel(org?.payout_summary);
  const fieldsBase = {
    amount: (payout.amount / 100).toFixed(2),
    arrival_date: dayOf(unixDate(payout.arrival_date)),
    processor_created_at: unixDate(payout.created),
    is_automatic: payout.automatic ?? true,
  };

  let rowId: string | null = null;
  let finalStatus: PayoutStatus = incoming;
  // Two deliveries for one payout can run at once, and events arrive in any order: the write is
  // conditional on the status that was read, so a status is never moved backwards by a stale read. A
  // lost race re-reads and decides again.
  for (let attempt = 0; attempt < 5 && !rowId; attempt++) {
    const existing = await db.payout.findUnique({ where: { stripe_payout_id: payout.id } });
    if (existing && existing.organization_id !== organizationId) {
      logger.warn(`Payout sync: payout ${payout.id} belongs to another company; not written to org ${organizationId}`);
      return null;
    }

    // Status only moves forward (pending, in transit, end state). A different end state from an event
    // snapshot is not trusted either: only the processor's current state may change one.
    const held = existing ? (existing.status as PayoutStatus) : null;
    const heldEnd = held && TERMINAL.includes(held) ? held : null;
    let status: PayoutStatus = incoming;
    if (heldEnd) {
      status = !TERMINAL.includes(incoming) || (incoming !== heldEnd && !opts.current) ? heldEnd : incoming;
    } else if (held === 'IN_TRANSIT' && incoming === 'PENDING') {
      status = 'IN_TRANSIT';
    }
    const fields = {
      ...fieldsBase,
      status,
      destination_label: destinationLabelOf(payout.destination) ?? summaryLabel ?? existing?.destination_label ?? null,
    };
    // The failure code is written when the payout failed and left alone otherwise.
    const failure = status === 'FAILED'
      ? { failure_code: payout.failure_code ?? null }
      : (existing?.status === 'FAILED' ? { failure_code: null } : {});

    if (!existing) {
      // ON CONFLICT DO NOTHING: a delivery that lost the race to insert finds the row on the next pass.
      await db.payout.createMany({ data: [{ organization_id: organizationId, stripe_payout_id: payout.id, ...fields, ...failure }], skipDuplicates: true });
      continue;
    }

    const data = { ...fields, ...failure };
    // A run that finds nothing new writes nothing (the row's updated_at stays put).
    const unchanged = existing.status === data.status
      && existing.amount.toFixed(2) === data.amount
      && existing.arrival_date?.getTime() === data.arrival_date?.getTime()
      && existing.processor_created_at?.getTime() === data.processor_created_at?.getTime()
      && existing.is_automatic === data.is_automatic
      && existing.destination_label === data.destination_label
      && (!('failure_code' in failure) || existing.failure_code === failure.failure_code);
    if (!unchanged) {
      // Only if the row still holds the status that was read.
      const { count } = await db.payout.updateMany({ where: { id: existing.id, status: existing.status }, data });
      if (count === 0) continue;
    }
    rowId = existing.id;
    finalStatus = status;
  }
  if (!rowId) {
    // Created by this pass (the loop ends when the row is found): read it for its id.
    const created = await db.payout.findUnique({ where: { stripe_payout_id: payout.id }, select: { id: true, organization_id: true, status: true } });
    if (!created || created.organization_id !== organizationId) return null;
    rowId = created.id;
    finalStatus = created.status as PayoutStatus;
  }

  // A payout that failed or was canceled moved no money: its payments are not shown as paid out.
  if (finalStatus === 'FAILED' || finalStatus === 'CANCELED') {
    await db.payment.updateMany({
      where: { payout_id: rowId, invoice: { organization_id: organizationId } },
      data: { payout_id: null },
    });
    return { id: rowId, linked: 0 };
  }
  const linked = balanceTransactionIds?.length
    ? await linkPayoutPayments(db, organizationId, rowId, balanceTransactionIds)
    : 0;
  return { id: rowId, linked };
}

/** Point the company's payments whose balance transaction is in `balanceTransactionIds` at the payout. */
export async function linkPayoutPayments(db: Pick<PayoutDb, 'payment'>, organizationId: string, payoutRowId: string, balanceTransactionIds: string[]): Promise<number> {
  if (balanceTransactionIds.length === 0) return 0;
  const result = await db.payment.updateMany({
    where: {
      stripe_balance_transaction_id: { in: balanceTransactionIds },
      invoice: { organization_id: organizationId },
      OR: [{ payout_id: null }, { payout_id: { not: payoutRowId } }],
    },
    data: { payout_id: payoutRowId },
  });
  return result.count;
}

export interface OrgPayoutSyncResult {
  /** Payouts the processor listed in the window. */
  listed: number;
  /** Of those, how many ServWave held no row for yet. */
  missing: number;
  /** Payments newly linked to a payout. */
  linked: number;
  /** Payouts whose balance transactions could not be read (looked at again next run). */
  unreadable: number;
}

/**
 * List one company's payouts since `sinceUnix` and bring ServWave's rows up to date: upsert each and link
 * the payments whose balance transaction is in it (re-linking those whose fee was captured after the
 * payout was first synced). Shared by the nightly reconcile and the backfill script. A dry run lists and
 * counts and writes nothing. Idempotent: a second run changes no row.
 */
export async function syncOrgPayouts(
  organizationId: string,
  accountId: string,
  sinceUnix: number,
  opts: { dryRun?: boolean } = {},
): Promise<OrgPayoutSyncResult> {
  const result: OrgPayoutSyncResult = { listed: 0, missing: 0, linked: 0, unreadable: 0 };
  const payouts = await listAccountPayouts(accountId, sinceUnix);
  result.listed = payouts.length;
  for (const payout of payouts) {
    const held = await prisma.payout.findUnique({ where: { stripe_payout_id: payout.id }, select: { id: true } });
    if (!held) result.missing++;
    if (opts.dryRun) continue;
    let balanceTransactionIds: string[] | undefined;
    // A failed payout moved no money out; a canceled one never will.
    if (payout.status !== 'failed' && payout.status !== 'canceled') {
      try {
        balanceTransactionIds = (await listPayoutBalanceTransactions(accountId, payout.id)).map((bt) => bt.id);
      } catch (err) {
        result.unreadable++;
        logger.warn(`Payout sync: the balance transactions of payout ${payout.id} (org ${organizationId}) could not be read: ${(err as Error).message}`);
      }
    }
    const synced = await prisma.$transaction((tx) => syncPayout(tx, organizationId, payout as unknown as ProcessorPayout, balanceTransactionIds, { current: true }));
    result.linked += synced?.linked ?? 0;
  }
  return result;
}
