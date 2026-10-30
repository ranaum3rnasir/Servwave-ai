/**
 * The job's own history of money-shaped edits (PRD 6, S06.5): every job line added, changed or
 * removed, every scope-of-work change and every job discount change writes a TimelineEvent on the
 * JOB (entity_type 'JOB') carrying structured old and new values in its metadata. The office-review
 * change-set (S06.8) reads these entries, and the job's Activity panel shows their descriptions.
 *
 * Until now these edits left only a bare audit-log row ("job.line_updated" + a line id), which is
 * org-wide compliance data, not the job's story, and held no values.
 *
 * Shape of every entry's metadata: `{ <thing>_id, old, new }`. `old` is null for an add and `new`
 * is null for a removal. The snapshots carry PRICES and never COSTS (unit_cost, markup_percent,
 * internal_cost are never copied in). Descriptions carry no dollar figures: prose cannot be
 * redacted, so the amounts live in the metadata, where `redactJobChangePrices` can strip them for a
 * reader who may not see pricing.
 *
 * S06.6 adds the same entries for the job's INVOICES: every line added, changed or removed and every
 * invoice discount change, draft or sent, writes a JOB entry in the same `{ old, new }` shape, tagged
 * with the invoice (`invoice_id`, `invoice_number`). An invoice with no job of its own writes no entry. These sit
 * beside, not instead of, the invoice-level INVOICE_EDITED entry the resend reminder reads.
 *
 * S06.7 adds the rest of what the office review reads off the job's own timeline: a note added
 * (`JOB_NOTE_ADDED`, naming the note) and the money movements on the job's invoices - a payment
 * recorded, a deposit applied, a refund issued, a payment voided - each tagged with the invoice and
 * carrying `amount` and `method` in its metadata. The money entries are nothing but money, so, like
 * the discount entries, they are dropped whole for a reader who may not see pricing (their prose
 * carries the dollar figure). They sit beside the invoice-level entries (`PAYMENT_RECEIVED`,
 * `INVOICE_REFUNDED`, `PAYMENT_VOIDED`) the invoice's own timeline keeps; `hideMirroredInvoiceEvents`
 * keeps the job's Activity from listing the same movement twice.
 *
 * Writers pass the transaction client of the edit itself, so the history entry and the edit commit
 * or roll back together. A no-op change (every snapshot field identical) writes nothing.
 *
 * S06.20: every entry is written by `write` below, which asks lib/job-review-return whether the entry is an unusual change
 * landing on a job in Ready to close (a price cut, a line removed, a discount added or raised) and, if so, sends the job back
 * to Office review in the same transaction.
 */
import { randomUUID } from 'crypto';
import type { Prisma, PaymentMethod } from '@prisma/client';
import { methodLabel } from '../services/payments-report';
import { ATTACHMENT_EVENTS } from './job-review-changeset';
import { returnToReviewOnUnusualChange } from './job-review-return';

export const JOB_CHANGE_EVENT = {
  LINE_ADDED: 'JOB_LINE_ADDED',
  LINE_CHANGED: 'JOB_LINE_CHANGED',
  LINE_REMOVED: 'JOB_LINE_REMOVED',
  SCOPE_ADDED: 'JOB_SCOPE_ADDED',
  SCOPE_CHANGED: 'JOB_SCOPE_CHANGED',
  SCOPE_REMOVED: 'JOB_SCOPE_REMOVED',
  DISCOUNT_CHANGED: 'JOB_DISCOUNT_CHANGED',
  INVOICE_LINE_ADDED: 'JOB_INVOICE_LINE_ADDED',
  INVOICE_LINE_CHANGED: 'JOB_INVOICE_LINE_CHANGED',
  INVOICE_LINE_REMOVED: 'JOB_INVOICE_LINE_REMOVED',
  INVOICE_DISCOUNT_CHANGED: 'JOB_INVOICE_DISCOUNT_CHANGED',
} as const;

/** S06.7: a note added to the job. */
export const JOB_NOTE_EVENT = { ADDED: 'JOB_NOTE_ADDED' } as const;

/** S05.7 to S05.9: a job-only phone or email added, a customer's replaced, an entry corrected or removed, with the pencil (PRD 5). Written by `record-contact-history`, which a lead's entries share. */
export { JOB_CONTACT_EVENT } from './record-contact-history';

/** S06.7: money moving on one of the job's invoices. */
export const JOB_MONEY_EVENT = {
  PAYMENT_RECORDED: 'JOB_PAYMENT_RECORDED',
  DEPOSIT_APPLIED: 'JOB_DEPOSIT_APPLIED',
  REFUND_ISSUED: 'JOB_REFUND_ISSUED',
  PAYMENT_VOIDED: 'JOB_PAYMENT_VOIDED',
} as const;

export type JobMoneyKind = keyof typeof JOB_MONEY_EVENT;

/** The invoice an invoice entry is tagged with. */
export interface JobChangeInvoice {
  id: string;
  invoice_number: string;
}

/** The transaction's client: the entry and, for an unusual change on a Ready to close job, the move back (S06.20) are written on it. */
type Db = Pick<Prisma.TransactionClient, 'timelineEvent' | 'job' | 'jobReview'>;

/** Who made the change and in which organization. `userId` null: nobody signed in (a customer paid online). */
export interface JobChangeActor {
  orgId: string;
  userId: string | null;
}

// ─── Snapshots ─────────────────────────────────────────

interface LineSource {
  description: string;
  quantity: unknown;
  unit_price: unknown;
  line_total: unknown;
  is_taxable: boolean;
  discount_type: string | null;
  discount_value: unknown;
  discount_amount: unknown;
}

export interface JobLineSnapshot {
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  is_taxable: boolean;
  discount_type: string | null;
  discount_value: number | null;
  discount_amount: number;
}

interface ScopeSource {
  title: string;
  body?: string | null;
  flat_price?: number | null;
  is_taxable?: boolean;
}

export interface JobScopeSnapshot {
  name: string;
  description: string;
  flat_price: number | null;
  is_taxable: boolean;
}

interface DiscountSource {
  discount_type: string | null;
  discount_value: unknown;
  discount_amount: unknown;
}

export interface JobDiscountSnapshot {
  discount_type: string | null;
  discount_value: number | null;
  discount_amount: number;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export function jobLineSnapshot(line: LineSource): JobLineSnapshot {
  return {
    name: line.description,
    quantity: num(line.quantity),
    unit_price: num(line.unit_price),
    line_total: num(line.line_total),
    is_taxable: line.is_taxable,
    discount_type: line.discount_type ?? null,
    discount_value: numOrNull(line.discount_value),
    discount_amount: num(line.discount_amount ?? 0),
  };
}

export function jobScopeSnapshot(scope: ScopeSource): JobScopeSnapshot {
  return {
    name: scope.title,
    description: scope.body ?? '',
    flat_price: numOrNull(scope.flat_price),
    is_taxable: scope.is_taxable ?? true,
  };
}

export function jobDiscountSnapshot(job: DiscountSource): JobDiscountSnapshot {
  return {
    discount_type: job.discount_type ?? null,
    discount_value: numOrNull(job.discount_value),
    discount_amount: num(job.discount_amount ?? 0),
  };
}

// ─── Writers ───────────────────────────────────────────

function sameSnapshot(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function write(
  db: Db,
  actor: JobChangeActor,
  /** The job whose history the entry lands on; null for an invoice that has no job of its own (it is still checked against the jobs that hold it). */
  jobId: string | null,
  eventType: string,
  description: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // The entry's id is made here, so the alert can tell this landing from the entries before it without a read-back.
  const entryId = jobId ? randomUUID() : undefined;
  if (jobId) {
    await db.timelineEvent.create({
      data: {
        id: entryId,
        organization_id: actor.orgId,
        entity_type: 'JOB',
        entity_id: jobId,
        event_type: eventType,
        description,
        metadata: metadata as Prisma.InputJsonValue,
        created_by: actor.userId,
      },
    });
  }
  // S06.20: a change M8 flags as unusual, landing on a job in Ready to close, sends it back to Office review (same transaction).
  // S06.24: it also queues the Office review attention alert for a new unusual item in Office review or Ready to close.
  await returnToReviewOnUnusualChange(db, { orgId: actor.orgId, actorId: actor.userId, jobId, change: { id: entryId, event_type: eventType, description, metadata } });
}

/** One entry for a line added (`before` null), changed, or removed (`after` null). */
export async function recordJobLineChange(
  db: Db,
  actor: JobChangeActor,
  jobId: string,
  lineId: string,
  before: JobLineSnapshot | null,
  after: JobLineSnapshot | null,
): Promise<void> {
  const subject = (after ?? before)!;
  const metadata = { line_id: lineId, old: before, new: after };
  if (!before && after) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.LINE_ADDED, `Line added: ${subject.name}`, metadata);
  }
  if (before && !after) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.LINE_REMOVED, `Line removed: ${subject.name}`, metadata);
  }
  if (before && after && !sameSnapshot(before, after)) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.LINE_CHANGED, `Line changed: ${subject.name}`, metadata);
  }
}

/** One entry for a scope of work added (`before` null), changed, or removed (`after` null). */
export async function recordJobScopeChange(
  db: Db,
  actor: JobChangeActor,
  jobId: string,
  scopeId: string,
  before: JobScopeSnapshot | null,
  after: JobScopeSnapshot | null,
): Promise<void> {
  const subject = (after ?? before)!;
  const metadata = { scope_id: scopeId, old: before, new: after };
  if (!before && after) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.SCOPE_ADDED, `Scope added: ${subject.name}`, metadata);
  }
  if (before && !after) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.SCOPE_REMOVED, `Scope removed: ${subject.name}`, metadata);
  }
  if (before && after && !sameSnapshot(before, after)) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.SCOPE_CHANGED, `Scope changed: ${subject.name}`, metadata);
  }
}

/** One entry when the job's discount (type, value or resolved amount) actually moved. */
export async function recordJobDiscountChange(
  db: Db,
  actor: JobChangeActor,
  jobId: string,
  before: JobDiscountSnapshot,
  after: JobDiscountSnapshot,
): Promise<void> {
  if (sameSnapshot(before, after)) return;
  await write(db, actor, jobId, JOB_CHANGE_EVENT.DISCOUNT_CHANGED, 'Job discount changed', {
    old: before,
    new: after,
  });
}

/**
 * S06.6: one entry on the JOB for a line added (`before` null), changed, or removed (`after` null) on
 * one of its invoices. `jobId` null (an invoice with no job of its own) writes no entry, but a change that is unusual still
 * sends the jobs that hold the invoice back from Ready to close (S06.20). Descriptions carry no
 * dollar figures, for the same reason as the job-line ones.
 */
export async function recordInvoiceLineChange(
  db: Db,
  actor: JobChangeActor,
  jobId: string | null,
  invoice: JobChangeInvoice,
  lineId: string,
  before: JobLineSnapshot | null,
  after: JobLineSnapshot | null,
): Promise<void> {
  const subject = (after ?? before)!;
  const metadata = { invoice_id: invoice.id, invoice_number: invoice.invoice_number, line_id: lineId, old: before, new: after };
  const prefix = `Invoice ${invoice.invoice_number} line`;
  if (!before && after) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.INVOICE_LINE_ADDED, `${prefix} added: ${subject.name}`, metadata);
  }
  if (before && !after) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.INVOICE_LINE_REMOVED, `${prefix} removed: ${subject.name}`, metadata);
  }
  if (before && after && !sameSnapshot(before, after)) {
    return write(db, actor, jobId, JOB_CHANGE_EVENT.INVOICE_LINE_CHANGED, `${prefix} changed: ${subject.name}`, metadata);
  }
}

/** S06.6: one entry on the JOB when one of its invoices' discount amount actually moved. */
export async function recordInvoiceDiscountChange(
  db: Db,
  actor: JobChangeActor,
  jobId: string | null,
  invoice: JobChangeInvoice,
  before: number,
  after: number,
): Promise<void> {
  if (before === after) return;
  await write(
    db,
    actor,
    jobId,
    JOB_CHANGE_EVENT.INVOICE_DISCOUNT_CHANGED,
    `Invoice ${invoice.invoice_number} discount changed`,
    {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      old: { discount_amount: before },
      new: { discount_amount: after },
    },
  );
}

/** S06.7: one entry on the JOB when a note is added to it. */
export async function recordJobNoteAdded(
  db: Db,
  actor: JobChangeActor,
  jobId: string,
  noteId: string,
): Promise<void> {
  await write(db, actor, jobId, JOB_NOTE_EVENT.ADDED, 'Note added', { note_id: noteId });
}

/** What a money entry records about the movement. */
export interface JobMoneyMovement {
  amount: number;
  /** How the money moved (cash, check, card, ...); null when it has no method of its own. */
  method: string | null;
  /**
   * Money the payment reconciler recorded (a card or bank payment taken through ServWave Payments).
   * Its line reads "via ServWave Payments", never a method code.
   */
  online?: boolean;
  /** The invoice-level entry this movement also writes, so the job's Activity can show it once. */
  invoiceEventType?: string;
  paymentId?: string | null;
  refundId?: string | null;
  /** For a deposit applied: the deposit invoice the credit was drawn from. */
  depositInvoiceId?: string | null;
}

const MONEY_VERB: Record<JobMoneyKind, string> = {
  PAYMENT_RECORDED: 'payment recorded',
  DEPOSIT_APPLIED: 'deposit applied',
  REFUND_ISSUED: 'refund issued',
  PAYMENT_VOIDED: 'payment voided',
};

/** The method clause of a money line: words, never an enum code (payments go-live slice 28). */
function movementWording(kind: JobMoneyKind, movement: JobMoneyMovement): string {
  if (kind === 'DEPOSIT_APPLIED') return '';
  if (movement.online && kind === 'PAYMENT_RECORDED') return ' via ServWave Payments';
  if (!movement.method) return '';
  // The same label the payments report uses; a code it does not know is tidied, never shown raw.
  const known = methodLabel(movement.method as PaymentMethod) as string | undefined;
  const words = movement.method.replace(/_/g, ' ').toLowerCase();
  return ` via ${known ?? words.charAt(0).toUpperCase() + words.slice(1)}`;
}

/**
 * S06.7: one entry on the JOB for money that moved on one of its invoices. `jobId` null (a
 * standalone invoice) writes nothing. The description carries no figure (M4: it is on `metadata.amount`, behind See prices); the whole entry is
 * dropped for a reader who may not see pricing.
 */
export async function recordJobMoneyMovement(
  db: Db,
  actor: JobChangeActor,
  jobId: string | null | undefined,
  invoice: JobChangeInvoice,
  kind: JobMoneyKind,
  movement: JobMoneyMovement,
): Promise<void> {
  if (!jobId) return;
  const via = movementWording(kind, movement);
  await write(
    db,
    actor,
    jobId,
    JOB_MONEY_EVENT[kind],
    `Invoice ${invoice.invoice_number} ${MONEY_VERB[kind]}${via}`,
    {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      amount: movement.amount,
      method: movement.method,
      ...(movement.invoiceEventType ? { invoice_event_type: movement.invoiceEventType } : {}),
      ...(movement.paymentId ? { payment_id: movement.paymentId } : {}),
      ...(movement.refundId ? { refund_id: movement.refundId } : {}),
      ...(movement.depositInvoiceId ? { deposit_invoice_id: movement.depositInvoiceId } : {}),
    },
  );
}

/** The method a deposit applied is recorded under: it is credit already paid, not a new payment. */
export const DEPOSIT_CREDIT_METHOD = 'DEPOSIT_CREDIT';

/**
 * S06.7: one JOB entry per deposit drawn down onto one of the job's invoices (what
 * `applyDepositCreditsWithPayments` returns), when the invoice is made.
 */
export async function recordJobDepositsApplied(
  db: Db,
  actor: JobChangeActor,
  jobId: string,
  invoice: JobChangeInvoice,
  applied: ReadonlyArray<{ deposit_invoice_id: string; amount: number; payment_id: string | null }>,
): Promise<void> {
  for (const credit of applied) {
    await recordJobMoneyMovement(db, actor, jobId, invoice, 'DEPOSIT_APPLIED', {
      amount: credit.amount,
      method: DEPOSIT_CREDIT_METHOD,
      paymentId: credit.payment_id,
      depositInvoiceId: credit.deposit_invoice_id,
    });
  }
}

// ─── Reading back ──────────────────────────────────────

const PRICE_KEYS = ['unit_price', 'line_total', 'flat_price', 'discount_type', 'discount_value', 'discount_amount'];
const CHANGE_EVENT_TYPES = new Set<string>(Object.values(JOB_CHANGE_EVENT));
const MONEY_ONLY_EVENT_TYPES = new Set<string>([
  JOB_CHANGE_EVENT.DISCOUNT_CHANGED,
  JOB_CHANGE_EVENT.INVOICE_DISCOUNT_CHANGED,
  ...Object.values(JOB_MONEY_EVENT),
]);

function withoutPrices(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const out: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const k of PRICE_KEYS) delete out[k];
  return out;
}

/**
 * For a reader who may not see pricing: the entries stay (what changed, who, when, quantities)
 * but their prices are removed from old and new, and the discount entries and the money movements
 * (S06.7), which are nothing but money, are dropped. Entries of any other type pass through
 * untouched.
 */
export function redactJobChangePrices<T extends { event_type: string; metadata?: unknown }>(events: T[]): T[] {
  return events
    .filter((ev) => !MONEY_ONLY_EVENT_TYPES.has(ev.event_type))
    .map((ev) => {
      const meta = ev.metadata;
      if (!CHANGE_EVENT_TYPES.has(ev.event_type) || !meta || typeof meta !== 'object' || Array.isArray(meta)) return ev;
      const m = meta as Record<string, unknown>;
      return { ...ev, metadata: { ...m, old: withoutPrices(m.old), new: withoutPrices(m.new) } };
    });
}

/**
 * S06.9: a file uploaded, renamed or deleted on one of the job's invoices writes the same kind of mirror on the JOB
 * (the file events keep their own type), tagged with the invoice. The review panel reads it from the job's history.
 * This is the invoice a JOB entry is the mirror of an invoice file event for, or null for any other entry.
 */
export function invoiceFileMirrorOf(ev: { entity_type?: string; event_type: string; metadata?: unknown }): string | null {
  if (ev.entity_type !== 'JOB' || !ATTACHMENT_EVENTS.includes(ev.event_type)) return null;
  const meta = ev.metadata;
  const invoiceId = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).invoice_id : null;
  return typeof invoiceId === 'string' ? invoiceId : null;
}

/** The invoice-level entry and its job mirror are written one after the other in one request. */
const MIRROR_WINDOW_MS = 5000;

const asTime = (at: unknown): number => new Date(at as string | Date).getTime();

/**
 * S06.7: a money movement writes an entry on the invoice's own timeline (`PAYMENT_RECEIVED`, ...) and
 * its mirror on the JOB; a file event on an invoice (S06.9) does the same. The job's Activity reads both, so each movement would list twice. A mirror
 * names the invoice-level entry it stands for (`invoice_id`, `invoice_event_type`); that entry, written
 * in the same request, is left out. An entry with no mirror beside it (anything recorded before the
 * mirrors existed, or by a door that does not write one) stays.
 */
export function hideMirroredInvoiceEvents<
  T extends { entity_type?: string; entity_id?: string; event_type: string; created_at?: unknown; metadata?: unknown },
>(events: T[]): T[] {
  const mirrors = events
    .filter(
      (ev) =>
        ev.entity_type === 'JOB' &&
        ((Object.values(JOB_MONEY_EVENT) as string[]).includes(ev.event_type) || ATTACHMENT_EVENTS.includes(ev.event_type)),
    )
    .map((ev) => ({ at: asTime(ev.created_at), meta: (ev.metadata ?? {}) as Record<string, unknown> }))
    .filter((m) => typeof m.meta.invoice_id === 'string' && typeof m.meta.invoice_event_type === 'string');
  if (mirrors.length === 0) return events;
  return events.filter(
    (ev) =>
      ev.entity_type !== 'INVOICE' ||
      !mirrors.some(
        (m) =>
          m.meta.invoice_id === ev.entity_id &&
          m.meta.invoice_event_type === ev.event_type &&
          Math.abs(m.at - asTime(ev.created_at)) <= MIRROR_WINDOW_MS,
      ),
  );
}
