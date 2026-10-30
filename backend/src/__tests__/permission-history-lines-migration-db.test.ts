/* =============================================================================
   Roles & Permissions security fixes, M4 follow-up (ticket 35), migration M16: old system-written money history lines and bells
   lose the figure in their words (Ran, 2026-10-29).

   Ran ruled that a history line and a bell name no figure to anyone and that no text is ever scanned. The writers were changed;
   rows written before that still carry the figure in their words. Migration 20261029090000 rewrites those old rows to the new
   wording, and ONLY rows that a system writer stored with exactly that event type and text shape. Run against real rows the way
   the deploy runs the file. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.

   Proved here, one old row per pattern the writers ever produced (taken from the writers as they were on staging and from their
   history): the new text, the figure kept on the row's metadata (not lost), a figure already on the row never overwritten, a
   note someone typed with "$500" untouched, the same words under a typed event type untouched, another company's rows treated
   the same way and kept in their own company, and a second run changing nothing.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261029090000_history_lines_without_amounts', 'migration.sql');

interface Case {
  /** The pattern, for the failure message. */
  name: string;
  entity: 'INVOICE' | 'ESTIMATE' | 'JOB' | 'ORGANIZATION';
  event: string;
  old: string;
  next: string;
  /** What the row's metadata held before (null: none). */
  before?: Record<string, unknown> | null;
  /** What it must hold after: these keys with these values (the rest of `before` stays). */
  after: Record<string, unknown>;
}

const INV = 'INVOICE';
const EST = 'ESTIMATE';
const JOB = 'JOB';
/** One row per pattern. The expected texts are written out by hand, not computed from the rule. */
const CASES: Case[] = [
  { name: 'payment with a tip', entity: INV, event: 'PAYMENT_RECEIVED', old: 'Payment of $1234.56 received via Check (plus $2.00 tip)', next: 'Payment received via Check (plus a tip)', after: { amount: 1234.56, tip_amount: 2 } },
  { name: 'payment (label)', entity: INV, event: 'PAYMENT_RECEIVED', old: 'Payment of $12.50 received via Cash', next: 'Payment received via Cash', before: {}, after: { amount: 12.5 } },
  { name: 'payment (raw method code, oldest)', entity: INV, event: 'PAYMENT_RECEIVED', old: 'Payment of $900.00 received via CASH', next: 'Payment received via CASH', after: { amount: 900 } },
  { name: 'card payment received online', entity: INV, event: 'PAYMENT_RECEIVED', old: 'Card payment of $500.00 received online', next: 'Card payment received online', after: { amount: 500 } },
  { name: 'card payment via ServWave Payments', entity: INV, event: 'PAYMENT_RECEIVED', old: 'Card payment of $1,250.00 received via ServWave Payments', next: 'Card payment received via ServWave Payments', after: { amount: 1250 } },
  { name: 'card payment via the old vendor line', entity: INV, event: 'PAYMENT_RECEIVED', old: 'Card payment of $75.00 received via Stripe', next: 'Card payment received via ServWave Payments', after: { amount: 75 } },
  { name: 'bank payment cleared', entity: INV, event: 'PAYMENT_RECEIVED', old: 'Bank payment of $500.00 cleared', next: 'Bank payment cleared', after: { amount: 500 } },
  { name: 'payment started', entity: INV, event: 'PAYMENT_PROCESSING', old: 'Bank payment of $500.00 started; it takes a few business days to clear', next: 'Bank payment started; it takes a few business days to clear', after: { amount: 500 } },
  { name: 'payment failed', entity: INV, event: 'PAYMENT_FAILED', old: 'Bank payment of $500.00 failed; nothing was collected', next: 'Bank payment failed; nothing was collected', after: { amount: 500 } },
  { name: 'bank payment failed, balance open', entity: INV, event: 'PAYMENT_FAILED', old: 'Bank payment of $500.00 failed; the balance is open for payment again', next: 'Bank payment failed; the balance is open for payment again', after: { amount: 500 } },
  { name: 'invoice refunded', entity: INV, event: 'INVOICE_REFUNDED', old: 'Invoice INV-7 refunded $30.00 (GOODWILL)', next: 'Invoice INV-7 refunded (GOODWILL)', before: { source: 'in_app', amount: 30 }, after: { amount: 30, source: 'in_app' } },
  { name: 'give-back refund, balance reopened', entity: INV, event: 'INVOICE_REFUNDED', old: 'Invoice INV-7 give-back refund $5.00 - balance reopened to $20.00', next: 'Invoice INV-7 give-back refund - balance reopened', after: { amount: 5, amount_due: 20 } },
  { name: 'give-back refund', entity: INV, event: 'INVOICE_REFUNDED', old: 'Invoice INV-7 give-back refund $5.00', next: 'Invoice INV-7 give-back refund', after: { amount: 5 } },
  { name: 'refund made outside', entity: INV, event: 'INVOICE_REFUNDED', old: 'Refund of $30.00 made outside ServWave recorded', next: 'Refund made outside ServWave recorded', before: { source: 'outside_servwave' }, after: { amount: 30, source: 'outside_servwave' } },
  { name: 'refund recorded from payments needing attention', entity: INV, event: 'INVOICE_REFUNDED', old: 'Refund of $1,200.50 recorded on this invoice by Dana Reyes', next: 'Refund recorded on this invoice by Dana Reyes', after: { amount: 1200.5 } },
  { name: 'invoice refunded in the dashboard', entity: INV, event: 'INVOICE_REFUNDED', old: 'Invoice refunded $40.00 via Stripe dashboard', next: 'Invoice refunded outside ServWave', after: { amount: 40 } },
  { name: 'deposit refunded in the dashboard', entity: EST, event: 'DEPOSIT_REFUNDED', old: 'Deposit refunded $25.00 via Stripe dashboard', next: 'Deposit refunded outside ServWave', after: { amount: 25 } },
  { name: 'credit applied', entity: INV, event: 'CREDIT_APPLIED', old: 'Credit of $10.00 applied to invoice INV-7', next: 'Credit applied to invoice INV-7', before: { amount: 10, reason: 'goodwill' }, after: { amount: 10, reason: 'goodwill' } },
  { name: 'write-off credit', entity: INV, event: 'CREDIT_APPLIED', old: 'Write-off credit of $5.00 recorded for the cash give-back on invoice INV-7', next: 'Write-off credit recorded for the cash give-back on invoice INV-7', after: { amount: 5 } },
  { name: 'deposit credit reversed', entity: INV, event: 'DEPOSIT_CREDIT_REVERSED', old: 'Deposit credit of $100.00 reversed on invoice INV-7', next: 'Deposit credit reversed on invoice INV-7', after: { amount: 100 } },
  { name: 'deposit credit reversed (chargeback)', entity: INV, event: 'DEPOSIT_CREDIT_REVERSED', old: 'Deposit credit of $100.00 reversed on invoice INV-7 (chargeback)', next: 'Deposit credit reversed on invoice INV-7 (chargeback)', after: { amount: 100 } },
  { name: 'deposit paid via a method', entity: EST, event: 'DEPOSIT_PAID', old: 'Deposit of $418.75 paid via CHECK for estimate E-1', next: 'Deposit paid via CHECK for estimate E-1', after: { amount: 418.75 } },
  { name: 'deposit paid via credit card', entity: EST, event: 'DEPOSIT_PAID', old: 'Deposit of $418.75 paid via credit card for estimate E-1', next: 'Deposit paid via credit card for estimate E-1', after: { amount: 418.75 } },
  { name: 'deposit paid by bank payment', entity: EST, event: 'DEPOSIT_PAID', old: 'Deposit of $500.00 paid by bank payment for estimate E-1', next: 'Deposit paid by bank payment for estimate E-1', after: { amount: 500 } },
  { name: 'deposit recorded (partial)', entity: EST, event: 'DEPOSIT_PAID', old: 'Deposit of $50.00 recorded via Cash for estimate E-1 (partial — $25.00 remaining)', next: 'Deposit recorded via Cash for estimate E-1 (partial)', before: { amount: 50, method: 'CASH' }, after: { amount: 50, amount_due: 25, method: 'CASH' } },
  { name: 'deposit recorded', entity: EST, event: 'DEPOSIT_PAID', old: 'Deposit of $75.00 recorded via Cash for estimate E-1', next: 'Deposit recorded via Cash for estimate E-1', after: { amount: 75 } },
  { name: 'deposit by bank started', entity: EST, event: 'DEPOSIT_PROCESSING', old: 'Deposit of $500.00 by bank payment started for estimate E-1; it takes a few business days to clear', next: 'Deposit by bank payment started for estimate E-1; it takes a few business days to clear', after: { amount: 500 } },
  { name: 'deposit requested (percent)', entity: EST, event: 'DEPOSIT_REQUESTED', old: 'Deposit of $418.75 requested (25%)', next: 'Deposit requested (25%)', after: { amount: 418.75 } },
  { name: 'deposit requested', entity: EST, event: 'DEPOSIT_REQUESTED', old: 'Deposit of $418.75 requested', next: 'Deposit requested', after: { amount: 418.75 } },
  { name: 'bank return, payment voided', entity: INV, event: 'CHARGEBACK', old: 'The bank returned the payment of $500.00 on invoice INV-7; payment voided, balance reopened', next: 'The bank returned the payment on invoice INV-7; payment voided, balance reopened', after: { amount: 500 } },
  { name: 'chargeback lost', entity: INV, event: 'CHARGEBACK', old: 'Chargeback lost — payment of $500.00 voided on invoice INV-7; the invoice stays voided', next: 'Chargeback lost — payment voided on invoice INV-7; the invoice stays voided', after: { amount: 500 } },
  { name: 'payment voided', entity: INV, event: 'PAYMENT_VOIDED', old: 'Payment of $60.00 voided on invoice INV-7 (ENTERED_IN_ERROR)', next: 'Payment voided on invoice INV-7 (ENTERED_IN_ERROR)', after: { amount: 60 } },
  { name: 'bank payment canceled', entity: INV, event: 'PAYMENT_CANCELED', old: 'Bank payment of $500.00 canceled before it cleared', next: 'Bank payment canceled before it cleared', after: { amount: 500 } },
  { name: 'overpayment flagged', entity: INV, event: 'OVERPAYMENT_FLAGGED', old: 'Overpayment of $20.00 received on invoice INV-7 — refund the excess', next: 'Overpayment received on invoice INV-7 — refund the excess', before: { overpaid: 20, default_action: 'refund_excess' }, after: { overpaid: 20, default_action: 'refund_excess' } },
  { name: 'dispute, bank return', entity: INV, event: 'INVOICE_DISPUTED', old: 'The bank returned the payment of $500.00 on invoice INV-7', next: 'The bank returned the payment on invoice INV-7', after: { amount: 500 } },
  { name: 'dispute, card', entity: INV, event: 'INVOICE_DISPUTED', old: 'Card payment of $450.00 disputed on invoice INV-7', next: 'Card payment disputed on invoice INV-7', after: { amount: 450 } },
  { name: 'partial chargeback', entity: INV, event: 'CHARGEBACK_PARTIAL', old: 'A lost dispute took back $40.00 of the $100.00 payment on invoice INV-7. The payment and the balance were left as they are; the balance needs a manual review.', next: 'A lost dispute took back part of the payment on invoice INV-7. The payment and the balance were left as they are; the balance needs a manual review.', before: { disputed_cents: 4000, unrefunded_cents: 10000 }, after: { disputed_cents: 4000, unrefunded_cents: 10000 } },
  { name: 'partial chargeback, bank return', entity: INV, event: 'CHARGEBACK_PARTIAL', old: 'The bank returned $40.00 of the $100.00 payment on invoice INV-7. The payment and the balance were left as they are; the balance needs a manual review.', next: 'The bank returned part of the payment on invoice INV-7. The payment and the balance were left as they are; the balance needs a manual review.', after: { amount: 40 } },
  { name: 'payment returned before it cleared', entity: INV, event: 'PAYMENT_RETURNED', old: 'The bank returned the payment of $500.00 on invoice INV-7 before it cleared. The payment was marked failed; it was never counted, so the balance is unchanged.', next: 'The bank returned the payment on invoice INV-7 before it cleared. The payment was marked failed; it was never counted, so the balance is unchanged.', after: { amount: 500 } },
  { name: 'unrecorded bank return', entity: INV, event: 'DISPUTE_ON_UNRECORDED_PAYMENT', old: 'The bank returned a payment of $500.00 on invoice INV-7 that was not recorded automatically. Nothing on the invoice was changed. If the payment was recorded by hand, void it and check the balance.', next: 'The bank returned a payment on invoice INV-7 that was not recorded automatically. Nothing on the invoice was changed. If the payment was recorded by hand, void it and check the balance.', before: { amount_cents: 50000 }, after: { amount_cents: 50000 } },
  { name: 'unrecorded card dispute (company level)', entity: 'ORGANIZATION', event: 'DISPUTE_ON_UNRECORDED_PAYMENT', old: 'A customer disputed a card payment of $450.00 in this account that was not recorded on the invoice. Nothing on the invoice was changed. Do not refund this payment while the dispute is open.', next: 'A customer disputed a card payment in this account that was not recorded on the invoice. Nothing on the invoice was changed. Do not refund this payment while the dispute is open.', after: { amount: 450 } },
  { name: 'unapplied: invoice closed for payment', entity: INV, event: 'PAYMENT_UNRECORDED', old: 'Bank payment of $500.00 on invoice INV-7 was not applied: the invoice was closed for payment (voided or already paid) while the payment was clearing.', next: 'Bank payment on invoice INV-7 was not applied: the invoice was closed for payment (voided or already paid) while the payment was clearing.', before: { reason: 'INVOICE_NOT_PAYABLE', charged_cents: 50000, unapplied_cents: 50000 }, after: { charged_cents: 50000, unapplied_cents: 50000 } },
  { name: 'unapplied: overpayment', entity: INV, event: 'PAYMENT_UNRECORDED', old: 'Bank payment of $500.00 on invoice INV-7 was more than the balance due: $120.00 was not applied to the invoice.', next: 'Bank payment on invoice INV-7 was more than the balance due: the excess was not applied to the invoice.', before: { reason: 'OVERPAYMENT', charged_cents: 50000, unapplied_cents: 12000 }, after: { charged_cents: 50000, unapplied_cents: 12000 } },
  { name: 'unapplied: no invoice in this account', entity: 'ORGANIZATION', event: 'PAYMENT_UNRECORDED', old: 'Card payment of $450.00 was not recorded: it does not belong to any invoice in this account.', next: 'Card payment was not recorded: it does not belong to any invoice in this account.', before: { reason: 'INVOICE_NOT_FOUND', charged_cents: 45000 }, after: { charged_cents: 45000 } },
  { name: 'unapplied: refund unmatched', entity: 'ORGANIZATION', event: 'PAYMENT_UNRECORDED', old: 'Payment of $75.00 sent from this account was not recorded: it does not match any payment ServWave recorded.', next: 'Payment sent from this account was not recorded: it does not match any payment ServWave recorded.', after: { amount: 75 } },
  { name: 'payment sent back', entity: INV, event: 'PAYMENT_SENT_BACK', old: '$300.00 that could not be recorded on this invoice was sent back to the customer', next: 'A payment that could not be recorded on this invoice was sent back to the customer', after: { amount: 300 } },
  { name: 'payment attached (new invoice)', entity: INV, event: 'PAYMENT_ATTACHED', old: 'Payment of $120.00 from payments needing attention recorded on the new invoice INV-9 by Dana Reyes', next: 'Payment from payments needing attention recorded on the new invoice INV-9 by Dana Reyes', after: { amount: 120 } },
  { name: 'payment attached', entity: INV, event: 'PAYMENT_ATTACHED', old: 'Payment of $120.00 from payments needing attention attached to INV-9 by Dana Reyes', next: 'Payment from payments needing attention attached to INV-9 by Dana Reyes', after: { amount: 120 } },
  { name: 'job marked done with money owed', entity: JOB, event: 'JOB_MARKED_DONE', old: 'Job J-7 marked Done with $1,100.00 still owed', next: 'Job J-7 marked Done with money still owed', before: { owed_amount: 1100 }, after: { owed_amount: 1100 } },
  { name: 'job money line, online', entity: JOB, event: 'JOB_PAYMENT_RECORDED', old: 'Invoice INV-7 payment recorded: $500.00 received via ServWave Payments', next: 'Invoice INV-7 payment recorded via ServWave Payments', after: { amount: 500 } },
  { name: 'job money line, by method', entity: JOB, event: 'JOB_PAYMENT_RECORDED', old: 'Invoice INV-7 payment recorded: $400.00 via Check', next: 'Invoice INV-7 payment recorded via Check', before: { amount: 400, method: 'CHECK' }, after: { amount: 400, method: 'CHECK' } },
  { name: 'job money line, refund', entity: JOB, event: 'JOB_REFUND_ISSUED', old: 'Invoice INV-7 refund issued: $50.00 via Bank transfer', next: 'Invoice INV-7 refund issued via Bank transfer', after: { amount: 50 } },
  { name: 'job money line, void', entity: JOB, event: 'JOB_PAYMENT_VOIDED', old: 'Invoice INV-7 payment voided: $50.00 via Card (outside ServWave)', next: 'Invoice INV-7 payment voided via Card (outside ServWave)', after: { amount: 50 } },
  { name: 'job money line, deposit applied', entity: JOB, event: 'JOB_DEPOSIT_APPLIED', old: 'Invoice INV-7 deposit applied: $100.00', next: 'Invoice INV-7 deposit applied', after: { amount: 100 } },
  { name: 'job money line, refund without a method', entity: JOB, event: 'JOB_REFUND_ISSUED', old: 'Invoice INV-7 refund issued: $5.00', next: 'Invoice INV-7 refund issued', after: { amount: 5 } },
];

/** Bells: the old title/body of a billing alert, the new ones, and the data it carried. */
interface BellCase { name: string; verb: string; body: string | null; title?: string; data: Record<string, unknown>; next: string | null; nextTitle?: string }
const BELLS: BellCase[] = [
  { name: 'payment received', verb: 'billing.payment_received', body: 'Amount: $100.00', data: { amount: '100.00' }, next: null },
  { name: 'payment received with a why line', verb: 'billing.payment_received', body: 'Amount: $100.00\nThis job has no Dispatcher.', data: { amount: '100.00' }, next: 'This job has no Dispatcher.' },
  { name: 'overdue', verb: 'billing.invoice_overdue', body: 'Balance due: $60.00', data: { amount: '60.00' }, next: null },
  { name: 'estimate won, with add-ons', verb: 'estimate.approved', body: 'Amount: $1,300.00 · Chose: Smart keypad · Declined: Extended warranty', data: { amount: '1,300.00' }, next: 'Chose: Smart keypad · Declined: Extended warranty' },
  { name: 'estimate won, no add-ons', verb: 'estimate.approved', body: 'Amount: $1,300.00', data: { amount: '1,300.00' }, next: null },
  { name: 'deposit paid', verb: 'estimate.deposit_paid', body: 'Amount: $250.00', data: { amount: '250.00' }, next: null },
  { name: 'dispute', verb: 'billing.disputed', body: 'Amount: $300.00. Reason: Fraudulent. Respond by October 20, 2026.', data: { amount: '300.00' }, next: 'Reason: Fraudulent. Respond by October 20, 2026.' },
  { name: 'dispute, amount only', verb: 'billing.disputed', body: 'Amount: $300.00.', data: { amount: '300.00' }, next: null },
  { name: 'dispute, bank return', verb: 'billing.disputed', body: 'The bank took back $300.00. Reason: Insufficient funds.', data: { amount: '300.00' }, next: 'The bank took back this payment. Reason: Insufficient funds.' },
  { name: 'chargeback', verb: 'billing.chargeback', body: 'Amount: $300.00 was taken back from your ServWave Payments balance.', data: { amount: '300.00' }, next: 'This payment was taken back from your ServWave Payments balance.' },
  { name: 'chargeback, bank return with an ending', verb: 'billing.chargeback', body: 'Amount: $500.00 was taken back from your ServWave Payments balance. The invoice is open again and we emailed the customer a link to pay again.', data: { amount: '500.00' }, next: 'This payment was taken back from your ServWave Payments balance. The invoice is open again and we emailed the customer a link to pay again.' },
  { name: 'chargeback, returned before it cleared', verb: 'billing.chargeback', body: 'Amount: $500.00. The bank returned this payment before it cleared, so no money reached your ServWave Payments balance.', data: { amount: '500.00' }, next: 'The bank returned this payment before it cleared, so no money reached your ServWave Payments balance.' },
  { name: 'partial chargeback', verb: 'billing.chargeback', body: '$100.00 was taken back. The payment was left as recorded and the balance was not changed. Review the balance by hand.', data: { amount: '100.00' }, next: 'Part of this payment was taken back. The payment was left as recorded and the balance was not changed. Review the balance by hand.' },
  { name: 'dispute closed', verb: 'billing.dispute_closed', body: 'Amount: $300.00. It was decided in your favor and the payment stands.', data: { amount: '300.00' }, next: 'It was decided in your favor and the payment stands.' },
  { name: 'bank payment started', verb: 'billing.bank_payment_started', body: 'Amount: $300.00. It usually takes a few business days to clear.', data: { amount: '300.00' }, next: 'It usually takes a few business days to clear.' },
  { name: 'bank payment failed', verb: 'billing.bank_payment_failed', body: 'Amount: $500.00. No money moved. We emailed the customer a link to pay again.', data: { amount: '500.00' }, next: 'No money moved. We emailed the customer a link to pay again.' },
  { name: 'refund failed (bank)', verb: 'billing.refund_failed', body: 'A bank refund of $40.00 to Pat Payer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.', data: { amount: '40.00' }, next: 'A bank refund to Pat Payer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.' },
  { name: 'refund failed', verb: 'billing.refund_failed', body: 'A refund of $40.00 to the customer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.', data: { amount: '40.00' }, next: 'A refund to the customer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.' },
  { name: 'first-payment nudge', verb: 'billing.payouts_pending_first_payment', title: "You've collected $1,250.00. Add your bank account to get paid out.", body: '$1,250.00', data: { amount: '$1,250.00' }, next: null, nextTitle: "You've collected a payment. Add your bank account to get paid out." },
  { name: 'first-payment nudge with a why line under the figure', verb: 'billing.payouts_pending_first_payment', title: "You've collected $1,250.00. Add your bank account to get paid out.", body: '$1,250.00\nThis invoice has no job or lead', data: { amount: '$1,250.00' }, next: 'This invoice has no job or lead', nextTitle: "You've collected a payment. Add your bank account to get paid out." },
];

suite('migration M16: old money history lines and bells lose their amounts (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'timeline_events']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });
  const orgs: string[] = [];
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  const seedHistory = async (org: string, cases: Case[]) => {
    const ids: string[] = [];
    for (const c of cases) {
      const row = await db.timelineEvent.create({
        data: {
          organization_id: org, entity_type: c.entity, entity_id: randomUUID(), event_type: c.event, description: c.old,
          metadata: c.before === undefined || c.before === null ? undefined : (c.before as never),
        },
      });
      ids.push(row.id);
    }
    return ids;
  };
  const seedBells = async (org: string) => {
    const ids: string[] = [];
    for (const b of BELLS) {
      const n = await db.notification.create({
        data: {
          organization_id: org, verb: b.verb, category: b.verb.startsWith('estimate') ? 'ESTIMATE' : 'BILLING', priority: 'FEED', needs_action: false,
          object_type: 'INVOICE', object_id: randomUUID(), object_label: 'INV-7', title: b.title ?? 'A bell about INV-7', body: b.body, data: b.data as never,
        },
      });
      ids.push(n.id);
    }
    return ids;
  };
  /** Rows a person typed, or that merely look like a system line, which must come out of the migration exactly as they went in. */
  const TYPED: Array<{ event: string; entity: string; description: string }> = [
    { event: 'NOTE_ADDED', entity: 'INVOICE', description: 'Customer says their budget is $500 and wants the 5% off.' },
    { event: 'NOTE_ADDED', entity: 'INVOICE', description: 'Payment of $12.50 received via Cash' },
    { event: 'NOTE_ADDED', entity: 'JOB', description: 'Invoice INV-7 payment recorded: $400.00 via Check' },
    { event: 'COMMENT_ADDED', entity: 'ESTIMATE', description: 'Deposit of $418.75 requested (25%)' },
    { event: 'SMS_SENT', entity: 'JOB', description: 'Told them the repair is $60 and they agreed.' },
    // A system event type whose text is not one of the writers' shapes is left alone too.
    { event: 'PAYMENT_RECEIVED', entity: 'INVOICE', description: 'Payment received via Cash and the customer tipped $5' },
  ];

  it('every pattern: the new text, the figure kept on the row, existing metadata never overwritten, typed text untouched, a second run a no-op', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    orgs.push(a.org, b.org);
    const idsA = await seedHistory(a.org, CASES);
    const idsB = await seedHistory(b.org, CASES.slice(0, 3));
    const typed: string[] = [];
    for (const t of TYPED) {
      typed.push((await db.timelineEvent.create({ data: { organization_id: a.org, entity_type: t.entity, entity_id: randomUUID(), event_type: t.event, description: t.description } })).id);
    }
    const bellIds = await seedBells(a.org);
    const sms = await db.notification.create({
      data: {
        organization_id: a.org, verb: 'communication.sms_inbound', category: 'COMMUNICATION', priority: 'FEED', needs_action: false, object_type: 'MESSAGE_THREAD',
        object_id: randomUUID(), title: 'New text — Pat Payer', body: 'Amount: $500 is what I can pay', data: {} as never,
      },
    });
    const typedBefore = await db.timelineEvent.findMany({ where: { id: { in: typed } }, orderBy: { id: 'asc' } });

    await run();

    const problems: string[] = [];
    for (const [i, c] of CASES.entries()) {
      const row = await db.timelineEvent.findUniqueOrThrow({ where: { id: idsA[i]! } });
      if (row.description !== c.next) problems.push(`${c.name}: description ${JSON.stringify(row.description)} should be ${JSON.stringify(c.next)}`);
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(c.after)) if (meta[k] !== v) problems.push(`${c.name}: metadata.${k} is ${JSON.stringify(meta[k])}, should be ${JSON.stringify(v)}`);
      if (/\$\s?\d/.test(row.description)) problems.push(`${c.name}: still names a figure`);
      if (/stripe|calltrackingmetrics|\bctm\b|supabase|twilio|quickbooks/i.test(row.description)) problems.push(`${c.name}: still names a vendor`);
      if (row.organization_id !== a.org) problems.push(`${c.name}: company changed`);
    }
    // The other company's rows get the same treatment and stay in their own company.
    for (const [i, c] of CASES.slice(0, 3).entries()) {
      const row = await db.timelineEvent.findUniqueOrThrow({ where: { id: idsB[i]! } });
      if (row.description !== c.next || row.organization_id !== b.org) problems.push(`other company, ${c.name}: ${row.description}`);
    }
    expect(problems).toEqual([]);

    // Typed text, and system event types with other text, are exactly as they were.
    const typedAfter = await db.timelineEvent.findMany({ where: { id: { in: typed } }, orderBy: { id: 'asc' } });
    expect(typedAfter).toEqual(typedBefore);

    // A figure already on the row is never replaced: the metadata a writer stored stays whatever the words said.
    const kept = await db.timelineEvent.create({
      data: { organization_id: a.org, entity_type: INV, entity_id: randomUUID(), event_type: 'PAYMENT_RECEIVED', description: 'Payment of $12.50 received via Cash', metadata: { amount: 99 } },
    });
    await run();
    expect(((await db.timelineEvent.findUniqueOrThrow({ where: { id: kept.id } })).metadata as { amount: number }).amount).toBe(99);

    // Bells.
    const bellProblems: string[] = [];
    for (const [i, bc] of BELLS.entries()) {
      const n = await db.notification.findUniqueOrThrow({ where: { id: bellIds[i]! } });
      if (n.body !== bc.next) bellProblems.push(`${bc.name}: body ${JSON.stringify(n.body)} should be ${JSON.stringify(bc.next)}`);
      if (bc.nextTitle && n.title !== bc.nextTitle) bellProblems.push(`${bc.name}: title ${JSON.stringify(n.title)}`);
      if (JSON.stringify(n.data) !== JSON.stringify(bc.data)) bellProblems.push(`${bc.name}: data changed to ${JSON.stringify(n.data)}`);
    }
    expect(bellProblems).toEqual([]);
    // A customer's text preview is theirs, whatever it says.
    expect((await db.notification.findUniqueOrThrow({ where: { id: sms.id } })).body).toBe('Amount: $500 is what I can pay');

    // Idempotent: a second run changes nothing in any row.
    const snapshot = async () => JSON.stringify([
      await db.timelineEvent.findMany({ where: { organization_id: { in: [a.org, b.org] } }, orderBy: { id: 'asc' } }),
      await db.notification.findMany({ where: { organization_id: a.org }, orderBy: { id: 'asc' } }),
    ]);
    const once = await snapshot();
    await run();
    expect(await snapshot()).toBe(once);
  }, 120_000);

  it('a row with no metadata gets the figure on a fresh metadata, and a bell whose data lost its amount gets it back', async () => {
    const w = await fx.newOrg();
    orgs.push(w.org);
    const bare = await db.timelineEvent.create({
      data: { organization_id: w.org, entity_type: INV, entity_id: randomUUID(), event_type: 'PAYMENT_RECEIVED', description: 'Payment of $12.50 received via Cash' },
    });
    const bell = await db.notification.create({
      data: {
        organization_id: w.org, verb: 'billing.payment_received', category: 'BILLING', priority: 'FEED', needs_action: false, object_type: 'INVOICE',
        object_id: randomUUID(), title: 'Payment received for INV-1', body: 'Amount: $77.25', data: {} as never,
      },
    });
    expect((await db.timelineEvent.findUniqueOrThrow({ where: { id: bare.id } })).metadata).toBeNull();
    await run();
    expect((await db.timelineEvent.findUniqueOrThrow({ where: { id: bare.id } })).metadata).toEqual({ amount: 12.5 });
    const after = await db.notification.findUniqueOrThrow({ where: { id: bell.id } });
    expect(after.body).toBeNull();
    expect(after.data).toEqual({ amount: '77.25' });
  });

  it('the figure survives for people with See prices: the history route still shows metadata.amount to them and leaves it out for people without', async () => {
    const w = await fx.newOrg();
    orgs.push(w.org);
    const job = await fx.addJob(w.org, w.customer);
    const inv = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
    await db.timelineEvent.create({
      data: { organization_id: w.org, entity_type: INV, entity_id: inv.id, event_type: 'PAYMENT_RECEIVED', description: 'Payment of $40.00 received via card' },
    });
    await run();
    const admin = await fx.signedInAs(w.admin);
    const seen = await admin.get(`/api/invoices/${inv.id}/timeline`);
    expect(seen.status).toBe(200);
    const entry = (seen.body.events as Array<{ event_type: string; description: string; metadata: { amount: number } }>).find((e) => e.event_type === 'PAYMENT_RECEIVED')!;
    expect(entry.description).toBe('Payment received via card');
    expect(entry.metadata.amount).toBe(40);
  });
});
