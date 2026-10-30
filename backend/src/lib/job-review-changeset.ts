/**
 * M8 - the review change-set (Roles & Permissions, PRD 6, S06.8). One pure module builds what the office review panel
 * shows: from the job's history since the round's window start, the job's current details, the round's checks and
 * decisions and whether the person may see costs, it returns the job summary item, the grouped items and the totals.
 *
 * Items are per THING, not per event: one line, one scope, one invoice line, one attachment, one note, one payment, one
 * job contact entry. Two edits to one line make one item that shows the FIRST old value and the LATEST new value. An
 * item is checked only while the history entry its check was made against is still its latest entry, so any later change
 * un-checks it with no extra write; the job summary's check is tied to the job's latest history entry the same way.
 *
 * The module reads the job's own timeline only (S06.5 to S06.7, S04.24, S04.25, S05.7 to S05.10 write everything the
 * review needs onto it). It reads the history entries' PRICE fields and never a cost: an item's changes are built from a
 * whitelist of fields, so a cost figure in an entry's metadata could not reach the panel. Costs appear only in the job
 * summary, and only for a person who may see them.
 */
import { createHash } from 'crypto';
import { formatPhoneDisplay } from './phone-format';

/** The groups of the panel, in the order the PRD gives them (the job summary comes before all of them). */
export const REVIEW_GROUP_ORDER = ['unusual', 'customer', 'lines', 'attachments', 'notes', 'payments'] as const;
export type ReviewGroupKey = (typeof REVIEW_GROUP_ORDER)[number];
/** The group an item belongs to by what it is; an unusual item is also listed in the first group. */
export type ReviewItemGroup = Exclude<ReviewGroupKey, 'unusual'>;

export const REVIEW_GROUP_LABEL: Record<ReviewGroupKey, string> = {
  unusual: 'Unusual items',
  customer: 'Customer details',
  lines: 'Lines and prices',
  attachments: 'Attachments',
  notes: 'Notes',
  payments: 'Payments',
};

/** One entry of the job's history as the review reads it. `actor_name` is who made it, resolved by the reader. */
export interface ReviewHistoryEntry {
  id: string;
  event_type: string;
  description: string;
  metadata: unknown;
  created_at: Date | string;
  actor_name: string | null;
}

export interface ReviewVisit {
  seq: number;
  scheduled_at: Date | string | null;
  outcome: 'finished' | 'cancelled' | 'open';
  finished_by: string | null;
  crew: string[];
  /** True when the job-level complete cancelled the visit (it was still open), rather than a person cancelling it. */
  cancelled_by_complete: boolean;
}

export interface ReviewSummaryLine {
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  /** Present only for a person who may see costs. */
  unit_cost?: number | null;
}

export interface ReviewSummaryInvoice {
  invoice_number: string;
  status: string;
  total: number;
  amount_due: number;
}

/** The job's current details, as the reader gathered them: everything the summary shows. */
export interface ReviewJobDetails {
  job_number: string;
  job_type: string | null;
  customer: { name: string; company_name: string | null };
  service_address: string | null;
  visits: ReviewVisit[];
  /** Lines with their cost; the module takes the cost out unless the person may see costs. */
  lines: ReviewSummaryLine[];
  discount_amount: number;
  total: number;
  total_cost?: number | null;
  invoices: ReviewSummaryInvoice[];
  /** What is still owed on the job; null when the job has no contract total yet. */
  balance: number | null;
  file_count: number;
  note_count: number;
}

export interface ReviewCheck {
  item_key: string;
  /** The history entry the check was made against. */
  entry_id: string;
  checked_by?: string | null;
  checked_at?: Date | string | null;
}

/** What a reviewer can decide for a customer item (S06.11). "Update the customer" is the register's "Replace on the customer". */
export const CHOICE = {
  ADD: 'ADD',
  UPDATE: 'UPDATE',
  THIS_JOB_ONLY: 'THIS_JOB_ONLY',
  /** An entry removed before the review: a tick that applies nothing. */
  NONE: 'NONE',
} as const;
export type ReviewChoice = (typeof CHOICE)[keyof typeof CHOICE];

export interface ReviewDecision {
  /** The job contact entry the decision is about. */
  entry_id: string;
  choice: string;
  /** The history entry the decision (the tick) was made against: the item is checked only while it is still the latest. */
  event_id: string;
  decided_by?: string | null;
  decided_at?: Date | string | null;
}

export interface ReviewChangeSetInput {
  entries: readonly ReviewHistoryEntry[];
  /** Where the round's change-set begins: nothing at or before it is shown. */
  windowStart: Date | string;
  details: ReviewJobDetails;
  /** The latest entry on the job's whole timeline: the job summary's check is tied to it. */
  jobLatestEntryId: string | null;
  checks: readonly ReviewCheck[];
  decisions: readonly ReviewDecision[];
  /** The customer's own name fields as they stand now, shown beside the job's value of a changed name (S06.11). */
  customerNow?: { first_name: string; last_name: string; company_name: string | null };
  /** "See costs": costs appear in the summary only with it. Prices always do. */
  mayCosts: boolean;
  /**
   * When the round was finished, for a job in Ready to close (S06.20): what changed after it is listed apart as "Since the
   * review". Omit it, or pass null, for a round still open: there is no such list.
   */
  finishedAt?: Date | string | null;
}

export interface ReviewChange {
  label: string;
  old: string | null;
  new: string | null;
}

export interface ReviewItem {
  key: string;
  group: ReviewItemGroup;
  /** What kind of thing it is, for a row's small label (and for the later slices that act on one kind). */
  kind: ReviewItemKind;
  title: string;
  /** Old value to new value, in words. Who and when travel beside it as `by` and `at`. */
  summary: string;
  changes: ReviewChange[];
  by: string | null;
  at: string;
  checked: boolean;
  checked_by: string | null;
  checked_at: string | null;
  unusual: boolean;
  /** Which of the three unusual kinds it is (the banner groups its chips by it), and the reason in words. */
  unusual_kind: UnusualKind | null;
  unusual_reason: string | null;
  latest_entry_id: string;
  /** Customer items only: what the entry is, and whether it was taken off the job before the review. */
  contact?: ReviewContact;
}

/** The decision side of a customer item (S06.11). */
export interface ReviewContact {
  /** The PRD 5 job contact entry; a decision is written against it. */
  entry_id: string;
  kind: string;
  intent: string;
  removed: boolean;
  /** The choices offered for this change, in the order shown; empty for an entry removed before the review. */
  options: ReviewChoice[];
  default_choice: ReviewChoice | null;
  /** The choice stored by the reviewer's tick or change of mind, or null. */
  decision: string | null;
  /** The choice the control shows: the stored pick while it is still offered, else the default. Null when there is no choice. */
  choice: ReviewChoice | null;
  /** The customer's value of a changed name, shown beside the job's; null for anything else. */
  customer_current: string | null;
}

/** The three things the PRD calls unusual: a deleted file, a price cut, a live customer detail change. */
export type UnusualKind = 'file_deleted' | 'price_cut' | 'customer_change';

export type ReviewItemKind =
  | 'line' | 'scope' | 'discount' | 'invoice_line' | 'invoice_discount'
  | 'attachment' | 'note' | 'payment' | 'contact';

export interface ReviewSummary {
  key: 'summary';
  title: 'Job details';
  checked: boolean;
  checked_by: string | null;
  checked_at: string | null;
  latest_entry_id: string | null;
  job_number: string;
  job_type: string | null;
  customer: { name: string; company_name: string | null };
  service_address: string | null;
  visits: Array<Omit<ReviewVisit, 'scheduled_at'> & { scheduled_at: string | null }>;
  lines: ReviewSummaryLine[];
  discount_amount: number;
  total: number;
  total_cost?: number | null;
  invoices: ReviewSummaryInvoice[];
  balance: number | null;
  file_count: number;
  note_count: number;
}

export interface ReviewGroup {
  key: ReviewGroupKey;
  label: string;
  items: ReviewItem[];
}

export interface ReviewTotals {
  /** Every item to check: the job summary and each change. */
  items: number;
  checked: number;
  unusual: number;
}

export interface ReviewChangeSet {
  summary: ReviewSummary;
  groups: ReviewGroup[];
  totals: ReviewTotals;
  /**
   * "Since the review" (S06.20): the items whose latest change landed after the round was finished, only on a job in Ready to
   * close (null otherwise). They are the same items the groups hold, listed again here, so the totals are not counted twice.
   */
  since_review: ReviewItem[] | null;
}

// ─── Reading an entry ──────────────────────────────────

type Meta = Record<string, unknown>;
const meta = (e: ReviewHistoryEntry): Meta => (e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Meta) : {});
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const time = (v: Date | string): number => new Date(v).getTime();

const money = (v: number): string => `$${v.toFixed(2)}`;
const plain = (v: number): string => String(Math.round(v * 100) / 100);

/** How a kind of event is grouped, and which item key it belongs to. */
interface Classified {
  key: string;
  group: ReviewItemGroup;
  kind: ReviewItemKind;
}

const LINE_EVENTS = ['JOB_LINE_ADDED', 'JOB_LINE_CHANGED', 'JOB_LINE_REMOVED'];
const SCOPE_EVENTS = ['JOB_SCOPE_ADDED', 'JOB_SCOPE_CHANGED', 'JOB_SCOPE_REMOVED'];
const INVOICE_LINE_EVENTS = ['JOB_INVOICE_LINE_ADDED', 'JOB_INVOICE_LINE_CHANGED', 'JOB_INVOICE_LINE_REMOVED'];
/** The history entries of a file; a file on one of the job's invoices writes a mirror of the same type on the job (S06.9). */
export const ATTACHMENT_EVENTS = ['ATTACHMENT_UPLOADED', 'ATTACHMENT_UPDATED', 'ATTACHMENT_DELETED'];
const NOTE_EVENTS = ['JOB_NOTE_ADDED', 'NOTE_DELETED'];
const PAYMENT_EVENTS = ['JOB_PAYMENT_RECORDED', 'JOB_DEPOSIT_APPLIED', 'JOB_REFUND_ISSUED', 'JOB_PAYMENT_VOIDED'];
const CONTACT_EVENTS = ['JOB_CONTACT_ENTRY_ADDED', 'JOB_CONTACT_ENTRY_CHANGED', 'JOB_CONTACT_ENTRY_CORRECTED', 'JOB_CONTACT_ENTRY_REMOVED'];

/** Every kind of history entry the review reads: the reader fetches these and nothing else. */
export const REVIEW_EVENT_TYPES: readonly string[] = [
  ...LINE_EVENTS, ...SCOPE_EVENTS, 'JOB_DISCOUNT_CHANGED', ...INVOICE_LINE_EVENTS, 'JOB_INVOICE_DISCOUNT_CHANGED',
  ...ATTACHMENT_EVENTS, ...NOTE_EVENTS, ...PAYMENT_EVENTS, ...CONTACT_EVENTS,
];

/**
 * The close-out's own history entries: a round opening, the Complete and Office review moves, a customer decision applied
 * and the review finished, the job marked done, reopened, sent back (the S06.18 backward move out of Office review or Ready to close, which reopens
 * the same round with its checks untouched), and the one-time upgrade of existing jobs. They record that the
 * close-out moved; none of them is a change to the job's details, so none of them un-checks the job summary or moves the
 * review's version (a finish would otherwise un-check the very summary it required to be checked). The strings are the
 * event types lib/job-review-finish, job-mark-done, job-reopen, job-back-out and job-close-out-upgrade write, and the
 * controller that completes a job (which spells the two constants below): a test pins each to its writer. Every other entry, an unusual one included, still counts.
 */
export const JOB_COMPLETED_EVENT = 'COMPLETED';
export const OFFICE_REVIEW_STARTED_EVENT = 'OFFICE_REVIEW_STARTED';
export const CLOSE_OUT_OWN_EVENT_TYPES: readonly string[] = [
  JOB_COMPLETED_EVENT, OFFICE_REVIEW_STARTED_EVENT, 'OFFICE_REVIEW_FINISHED', 'JOB_CUSTOMER_DECISION_APPLIED',
  'JOB_MARKED_DONE', 'JOB_REOPENED', 'JOB_MOVED_BACK', 'JOB_CLOSE_OUT_UPGRADED',
];

/** The entries that are about the job's invoices and the money on them: a reader who cannot open invoices does not get them. */
export const INVOICE_EVENT_TYPES: readonly string[] = [...INVOICE_LINE_EVENTS, 'JOB_INVOICE_DISCOUNT_CHANGED', ...PAYMENT_EVENTS];

/**
 * The invoices a history entry on the job names: an invoice entry names its invoice (a deposit applied names two), a file
 * entry on the job itself names none, and one that mirrors a file event on an invoice (S06.9) names that invoice.
 */
export function invoiceIdsNamedBy(e: { event_type: string; metadata?: unknown }): string[] {
  const isInvoiceEntry = INVOICE_EVENT_TYPES.includes(e.event_type);
  if (!isInvoiceEntry && !ATTACHMENT_EVENTS.includes(e.event_type)) return [];
  const m = e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : {};
  return [m.invoice_id, isInvoiceEntry ? m.deposit_invoice_id : undefined].filter((v): v is string => typeof v === 'string');
}

/** The invoices the entries of one item name, each once. */
export function invoiceIdsOf(entries: readonly { event_type: string; metadata?: unknown }[]): string[] {
  return [...new Set(entries.flatMap(invoiceIdsNamedBy))];
}

/** An entry about an invoice stays only when the person can open every invoice it names; an invoice entry naming none stays out. */
export function mayShowInvoiceEntry(e: { event_type: string; metadata?: unknown }, openable: ReadonlySet<string>): boolean {
  const ids = invoiceIdsNamedBy(e);
  if (!INVOICE_EVENT_TYPES.includes(e.event_type)) return ids.every((id) => openable.has(id));
  return ids.length > 0 && ids.every((id) => openable.has(id));
}

function classify(e: ReviewHistoryEntry): Classified | null {
  const m = meta(e);
  const t = e.event_type;
  if (LINE_EVENTS.includes(t)) return str(m.line_id) ? { key: `line:${m.line_id}`, group: 'lines', kind: 'line' } : null;
  if (SCOPE_EVENTS.includes(t)) return str(m.scope_id) ? { key: `scope:${m.scope_id}`, group: 'lines', kind: 'scope' } : null;
  if (t === 'JOB_DISCOUNT_CHANGED') return { key: 'discount:job', group: 'lines', kind: 'discount' };
  if (INVOICE_LINE_EVENTS.includes(t)) {
    return str(m.invoice_id) && str(m.line_id) ? { key: `invoice-line:${m.invoice_id}:${m.line_id}`, group: 'lines', kind: 'invoice_line' } : null;
  }
  if (t === 'JOB_INVOICE_DISCOUNT_CHANGED') {
    return str(m.invoice_id) ? { key: `invoice-discount:${m.invoice_id}`, group: 'lines', kind: 'invoice_discount' } : null;
  }
  if (ATTACHMENT_EVENTS.includes(t)) return str(m.attachment_id) ? { key: `attachment:${m.attachment_id}`, group: 'attachments', kind: 'attachment' } : null;
  if (NOTE_EVENTS.includes(t)) return str(m.note_id) ? { key: `note:${m.note_id}`, group: 'notes', kind: 'note' } : null;
  if (PAYMENT_EVENTS.includes(t)) {
    // A payment and its void are one item; a refund is its own; an entry with no id of its own is keyed by itself.
    const id = str(m.payment_id) ? `payment:${m.payment_id}` : str(m.refund_id) ? `refund:${m.refund_id}` : `payment-entry:${e.id}`;
    return { key: id, group: 'payments', kind: 'payment' };
  }
  if (CONTACT_EVENTS.includes(t)) return str(m.entry_id) ? { key: `contact:${m.entry_id}`, group: 'customer', kind: 'contact' } : null;
  return null;
}

// ─── Wording of one item ───────────────────────────────

interface LineFields {
  name: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  discount_amount: number | null;
}

/** The price-side fields of a line snapshot, and nothing else: a cost in the entry could not get past this. */
function lineFields(v: unknown): LineFields | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    name: str(r.name),
    quantity: num(r.quantity),
    unit_price: num(r.unit_price),
    line_total: num(r.line_total),
    discount_amount: num(r.discount_amount),
  };
}

interface ScopeFields { name: string | null; flat_price: number | null }

function scopeFields(v: unknown): ScopeFields | null {
  const r = asRecord(v);
  return r ? { name: str(r.name), flat_price: num(r.flat_price) } : null;
}

function discountAmountOf(v: unknown): number | null {
  const r = asRecord(v);
  return r ? num(r.discount_amount) : null;
}

function diff(label: string, before: string | null, after: string | null): ReviewChange[] {
  return before === after ? [] : [{ label, old: before, new: after }];
}

const fmtQty = (v: number | null) => (v == null ? null : plain(v));
const fmtMoney = (v: number | null) => (v == null ? null : money(v));

/** What changed on a line, field by field; an add lists what it was added as, a removal what it was. */
function lineChanges(before: LineFields | null, after: LineFields | null): ReviewChange[] {
  const b = before;
  const a = after;
  if (!b && !a) return [];
  const get = <K extends keyof LineFields>(r: LineFields | null, k: K) => (r ? r[k] : null);
  return [
    ...diff('Name', get(b, 'name'), get(a, 'name')),
    ...diff('Quantity', fmtQty(get(b, 'quantity')), fmtQty(get(a, 'quantity'))),
    ...diff('Unit price', fmtMoney(get(b, 'unit_price')), fmtMoney(get(a, 'unit_price'))),
    ...diff('Line total', fmtMoney(get(b, 'line_total')), fmtMoney(get(a, 'line_total'))),
    ...((get(b, 'discount_amount') ?? 0) !== (get(a, 'discount_amount') ?? 0)
      ? [{ label: 'Line discount', old: fmtMoney(get(b, 'discount_amount') ?? 0), new: fmtMoney(get(a, 'discount_amount') ?? 0) }]
      : []),
  ];
}

function scopeChanges(before: ScopeFields | null, after: ScopeFields | null): ReviewChange[] {
  return [
    ...diff('Name', before?.name ?? null, after?.name ?? null),
    ...diff('Price', fmtMoney(before?.flat_price ?? null), fmtMoney(after?.flat_price ?? null)),
  ];
}

const sentence = (changes: ReviewChange[]): string =>
  changes.map((c) => `${c.label} ${c.old ?? 'none'} to ${c.new ?? 'none'}`).join('; ');

/** "Added", "Removed", "Added then removed" or the field-by-field change of a thing with old and new snapshots. */
function lifecycle(before: unknown, after: unknown, existedBefore: boolean, wording: string): string {
  if (!before && after) return `${wording} added`;
  if (before && !after) return `${wording} removed`;
  if (!before && !after) return existedBefore ? `${wording} removed` : `${wording} added, then removed`;
  return '';
}

// ─── Building the items ────────────────────────────────

interface Folded {
  classified: Classified;
  entries: ReviewHistoryEntry[];
}

function firstOf<T>(list: T[]): T { return list[0]!; }
function lastOf<T>(list: T[]): T { return list[list.length - 1]!; }

function attachmentName(entries: ReviewHistoryEntry[]): string {
  for (const e of [...entries].reverse()) {
    const fromMeta = str(meta(e).display_name);
    if (fromMeta) return fromMeta;
    const m = /^(?:Invoice \S+: )?(?:File uploaded|Attachment updated|Attachment deleted): (.+?)(?: \(uploaded by .*\))?$/.exec(e.description);
    if (m) return m[1]!;
  }
  return str(meta(firstOf(entries)).file_name) ?? 'a file';
}

const PRICE_CUT = {
  removed: 'A line was removed',
  lowered: 'A price was lowered',
  discount: 'A discount was added or raised',
} as const;
const FILE_DELETED = 'A file was deleted';
const CUSTOMER_CHANGE = 'A customer detail changed';

/** The kind of unusual item a reason belongs to. */
const KIND_OF_REASON: Record<string, UnusualKind> = {
  [PRICE_CUT.removed]: 'price_cut',
  [PRICE_CUT.lowered]: 'price_cut',
  [PRICE_CUT.discount]: 'price_cut',
  [FILE_DELETED]: 'file_deleted',
  [CUSTOMER_CHANGE]: 'customer_change',
};

interface Built {
  title: string;
  summary: string;
  changes: ReviewChange[];
  unusual_reason: string | null;
  contact?: ReviewContact;
}

function buildLine(f: Folded): Built {
  const first = meta(firstOf(f.entries));
  const last = meta(lastOf(f.entries));
  const before = lineFields(first.old);
  const added = before ? null : lineFields(first.new);
  const after = lineFields(last.new);
  const name = after?.name ?? before?.name ?? added?.name ?? lineFields(last.old)?.name ?? 'Line';
  return buildPriced(`Line: ${name}`, before, added, after, 'Line');
}

/**
 * Shared by job lines and invoice lines: the wording and the price-cut rule are the same.
 *
 * A line is judged against its BASELINE: its value when the window opened (`before`), or, for a line added inside the
 * window, the value it had when it was added (`added`). A first review's window opens at the job's creation, so nearly
 * every line is added inside it, and a price cut or a removal on it must still be flagged.
 */
function buildPriced(title: string, before: LineFields | null, added: LineFields | null, after: LineFields | null, prefix: string): Built {
  const baseline = before ?? added;
  let unusual: string | null = null;
  if (baseline && !after) unusual = PRICE_CUT.removed;
  else if (baseline && after && baseline.unit_price != null && after.unit_price != null && after.unit_price < baseline.unit_price) unusual = PRICE_CUT.lowered;
  else if (baseline && after && (after.discount_amount ?? 0) > (baseline.discount_amount ?? 0)) unusual = PRICE_CUT.discount;

  // A line added and then cut reads as the cut, from what it was added as to what it is now.
  const cutAfterAdd = unusual !== null && unusual !== PRICE_CUT.removed && added !== null;
  const wording = cutAfterAdd ? '' : lifecycle(before, after, before !== null, prefix);
  const list = lineChanges(cutAfterAdd ? added : before, after);
  const detail = wording || sentence(list);
  const addedAs = !before && after && !cutAfterAdd ? ` ${after.quantity != null ? `${plain(after.quantity)} x ` : ''}${fmtMoney(after.unit_price) ?? ''}`.trimEnd() : '';
  return { title, summary: wording ? `${wording}${addedAs}` : detail || 'No net change', changes: list, unusual_reason: unusual };
}

function buildScope(f: Folded): Built {
  const before = scopeFields(meta(firstOf(f.entries)).old);
  const added = before ? null : scopeFields(meta(firstOf(f.entries)).new);
  const last = meta(lastOf(f.entries));
  const after = scopeFields(last.new);
  const name = after?.name ?? before?.name ?? added?.name ?? scopeFields(last.old)?.name ?? 'Scope';
  // Judged against what it was when the window opened, or when it was added inside the window (see buildPriced).
  const baseline = before ?? added;
  let unusual: string | null = null;
  if (baseline && !after) unusual = PRICE_CUT.removed;
  else if (baseline && after && baseline.flat_price != null && after.flat_price != null && after.flat_price < baseline.flat_price) unusual = PRICE_CUT.lowered;
  const cutAfterAdd = unusual === PRICE_CUT.lowered && added !== null;
  const wording = cutAfterAdd ? '' : lifecycle(before, after, before !== null, 'Scope');
  const changes = scopeChanges(cutAfterAdd ? added : before, after);
  return { title: `Scope: ${name}`, summary: wording || sentence(changes) || 'No net change', changes, unusual_reason: unusual };
}

function buildDiscount(f: Folded, title: string): Built {
  const before = discountAmountOf(meta(firstOf(f.entries)).old) ?? 0;
  const after = discountAmountOf(meta(lastOf(f.entries)).new) ?? 0;
  const changes = diff('Discount', money(before), money(after));
  return {
    title,
    summary: changes.length ? sentence(changes) : 'No net change',
    changes,
    unusual_reason: after > before ? PRICE_CUT.discount : null,
  };
}

function buildInvoiceLine(f: Folded): Built {
  const first = meta(firstOf(f.entries));
  const last = meta(lastOf(f.entries));
  const before = lineFields(first.old);
  const added = before ? null : lineFields(first.new);
  const after = lineFields(last.new);
  const name = after?.name ?? before?.name ?? added?.name ?? lineFields(last.old)?.name ?? 'Line';
  const number = str(last.invoice_number) ?? str(first.invoice_number) ?? '';
  return buildPriced(`Invoice ${number} line: ${name}`.replace('  ', ' '), before, added, after, 'Invoice line');
}

function buildAttachment(f: Folded): Built {
  const name = attachmentName(f.entries);
  // A file on one of the job's invoices names the invoice (its history entry is tagged with it, S06.9).
  const invoice = str(meta(firstOf(f.entries)).invoice_number);
  const title = invoice ? `Invoice ${invoice} file: ${name}` : `File: ${name}`;
  const deleted = f.entries.find((e) => e.event_type === 'ATTACHMENT_DELETED');
  const uploaded = f.entries.find((e) => e.event_type === 'ATTACHMENT_UPLOADED');
  if (deleted) {
    const m = meta(deleted);
    const by = str(m.deleted_by_name) ?? deleted.actor_name ?? 'someone';
    const from = str(m.uploaded_by_name);
    return {
      title,
      summary: `Deleted by ${by}${from ? `, uploaded by ${from}` : ''}`,
      changes: [{ label: 'File', old: name, new: null }],
      unusual_reason: FILE_DELETED,
    };
  }
  if (uploaded) return { title, summary: 'Uploaded', changes: [{ label: 'File', old: null, new: name }], unusual_reason: null };
  return { title, summary: 'Renamed or described', changes: [], unusual_reason: null };
}

function buildNote(f: Folded): Built {
  const deleted = f.entries.find((e) => e.event_type === 'NOTE_DELETED');
  const added = f.entries.find((e) => e.event_type === 'JOB_NOTE_ADDED');
  const text = (deleted && str(meta(deleted).note_content)) ?? (added && str(meta(added).note_content)) ?? null;
  const shown = text ? (text.length > 140 ? `${text.slice(0, 140)}...` : text) : 'a note';
  if (deleted) {
    const m = meta(deleted);
    const by = str(m.deleted_by_name) ?? deleted.actor_name ?? 'someone';
    const wrote = str(m.written_by_name);
    return {
      title: 'Note',
      summary: `Deleted by ${by}${wrote ? `, written by ${wrote}` : ''}: ${shown}`,
      changes: [{ label: 'Note', old: shown, new: null }],
      unusual_reason: null,
    };
  }
  return { title: 'Note', summary: `Added: ${shown}`, changes: [{ label: 'Note', old: null, new: shown }], unusual_reason: null };
}

const PAYMENT_VERB: Record<string, string> = {
  JOB_PAYMENT_RECORDED: 'Payment recorded',
  JOB_DEPOSIT_APPLIED: 'Deposit applied',
  JOB_REFUND_ISSUED: 'Refund issued',
  JOB_PAYMENT_VOIDED: 'Payment voided',
};

function methodWords(method: unknown): string {
  const raw = str(method);
  if (!raw) return '';
  const words = raw.replace(/_/g, ' ').toLowerCase();
  return ` via ${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function buildPayment(f: Folded): Built {
  const parts = f.entries.map((e) => {
    const m = meta(e);
    const amount = num(m.amount);
    return `${PAYMENT_VERB[e.event_type] ?? 'Payment'}${amount != null ? ` ${money(amount)}` : ''}${methodWords(m.method)}`;
  });
  const first = meta(firstOf(f.entries));
  const number = str(first.invoice_number);
  const amount = num(first.amount);
  return {
    title: number ? `Invoice ${number}` : 'Payment',
    summary: parts.join(', then '),
    changes: [{ label: 'Amount', old: null, new: amount != null ? money(amount) : null }],
    unusual_reason: null,
  };
}

const CONTACT_LABEL: Record<string, string> = {
  PHONE: 'Phone', EMAIL: 'Email', FIRST_NAME: 'First name', LAST_NAME: 'Last name', COMPANY_NAME: 'Company name',
};

function contactValue(kind: string, v: unknown): string | null {
  const r = asRecord(v);
  const value = r ? str(r.value) : null;
  if (!value) return null;
  const ext = r && kind === 'PHONE' ? str(r.extension) : null;
  return `${kind === 'PHONE' ? formatPhoneDisplay(value) : value}${ext ? ` ext. ${ext}` : ''}`;
}

const NAME_KINDS = ['FIRST_NAME', 'LAST_NAME', 'COMPANY_NAME'];

/** The choices offered for an entry and the one that starts selected (PRD 6, M8): a phone or email defaults to Add, a name to This job only. */
function choicesFor(kind: string, intent: string, removed: boolean): { options: ReviewChoice[]; default_choice: ReviewChoice | null } {
  if (removed) return { options: [], default_choice: null };
  if (NAME_KINDS.includes(kind)) return { options: [CHOICE.THIS_JOB_ONLY, CHOICE.UPDATE], default_choice: CHOICE.THIS_JOB_ONLY };
  // A phone or email: an add has nothing to replace, so Update is offered only for a change.
  return {
    options: intent === 'CHANGED' ? [CHOICE.ADD, CHOICE.UPDATE, CHOICE.THIS_JOB_ONLY] : [CHOICE.ADD, CHOICE.THIS_JOB_ONLY],
    default_choice: CHOICE.ADD,
  };
}

function customerCurrent(kind: string, now: ReviewChangeSetInput['customerNow']): string | null {
  if (!now) return null;
  if (kind === 'FIRST_NAME') return now.first_name;
  if (kind === 'LAST_NAME') return now.last_name;
  if (kind === 'COMPANY_NAME') return now.company_name;
  return null;
}

function buildContact(f: Folded, decisions: ReadonlyMap<string, ReviewDecision>, customerNow: ReviewChangeSetInput['customerNow']): Built {
  const first = firstOf(f.entries);
  const last = lastOf(f.entries);
  const fm = meta(first);
  const lm = meta(last);
  const kind = str(lm.kind) ?? str(fm.kind) ?? 'PHONE';
  const intent = str(fm.intent) ?? str(lm.intent) ?? 'ADDED';
  const label = CONTACT_LABEL[kind] ?? 'Detail';
  const removed = last.event_type === 'JOB_CONTACT_ENTRY_REMOVED';
  const before = contactValue(kind, fm.old);
  const after = removed ? null : contactValue(kind, lm.new);
  const entryId = String(fm.entry_id ?? lm.entry_id);
  const adder = first.actor_name ?? 'someone';
  const remover = last.actor_name ?? 'someone';
  const summary = removed
    ? `${label} ${contactValue(kind, fm.new) ?? before ?? ''}`.trim() + `: added by ${adder}, removed by ${remover}`
    : before
      ? `${label} ${before} to ${after}`
      : `${label} ${after} added for this job only`;
  const { options, default_choice } = choicesFor(kind, intent, removed);
  const stored = decisions.get(entryId)?.choice ?? null;
  const picked = options.find((o) => o === stored) ?? null;
  return {
    title: label,
    summary,
    changes: removed ? [] : [{ label, old: before, new: after }],
    // A live customer detail change is unusual; one taken off the job before the review reaches nobody.
    unusual_reason: removed ? null : CUSTOMER_CHANGE,
    contact: {
      entry_id: entryId, kind, intent, removed, options, default_choice, decision: stored,
      choice: picked ?? default_choice,
      customer_current: removed ? null : customerCurrent(kind, customerNow),
    },
  };
}

function build(f: Folded, decisions: ReadonlyMap<string, ReviewDecision>, customerNow: ReviewChangeSetInput['customerNow']): Built {
  switch (f.classified.kind) {
    case 'line': return buildLine(f);
    case 'scope': return buildScope(f);
    case 'discount': return buildDiscount(f, 'Job discount');
    case 'invoice_line': return buildInvoiceLine(f);
    case 'invoice_discount': return buildDiscount(f, `Invoice ${str(meta(lastOf(f.entries)).invoice_number) ?? ''} discount`.replace('  ', ' '));
    case 'attachment': return buildAttachment(f);
    case 'note': return buildNote(f);
    case 'payment': return buildPayment(f);
    case 'contact': return buildContact(f, decisions, customerNow);
  }
}

// ─── The change-set ────────────────────────────────────

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());

/**
 * Where a history entry stands among entries written in the same moment. A lead's entries are carried onto the job in one
 * transaction (S05.15), so their history entries can share a millisecond (the column keeps no finer time) and their
 * random ids say nothing about order. A carried entry therefore sorts by the lead entry it came from, in the lead's own
 * order: that entry's date, then its id. Every other entry has no rank and falls back on its own id.
 */
function carriedRank(e: ReviewHistoryEntry): string {
  const m = meta(e);
  const at = m.carried_from_lead === true ? str(m.entry_created_at) : null;
  const source = str(m.source_entry_id);
  return at && source ? `${at}/${source}` : '';
}

/** The order every list of history entries is read in: when they happened, then (for a tie) carriedRank, then the id. */
const byEntryOrder = (a: ReviewHistoryEntry, b: ReviewHistoryEntry): number =>
  time(a.created_at) - time(b.created_at) || carriedRank(a).localeCompare(carriedRank(b)) || a.id.localeCompare(b.id);

export function buildReviewChangeSet(input: ReviewChangeSetInput): ReviewChangeSet {
  const windowStart = time(input.windowStart);
  const inWindow = input.entries
    .filter((e) => time(e.created_at) > windowStart)
    .sort(byEntryOrder);

  const folded = new Map<string, Folded>();
  for (const e of inWindow) {
    const c = classify(e);
    if (!c) continue;
    const slot = folded.get(c.key);
    if (slot) slot.entries.push(e);
    else folded.set(c.key, { classified: c, entries: [e] });
  }

  const checkOf = new Map(input.checks.map((c) => [c.item_key, c]));
  const decisions = new Map(input.decisions.map((d) => [d.entry_id, d]));

  const items: ReviewItem[] = [...folded.values()].map((f) => {
    const built = build(f, decisions, input.customerNow);
    const latest = lastOf(f.entries);
    // A customer item is ticked by its decision, every other item by its check; both name the entry they were made against.
    const decision = built.contact ? decisions.get(built.contact.entry_id) : undefined;
    const check: Pick<ReviewCheck, 'entry_id' | 'checked_by' | 'checked_at'> | undefined = built.contact
      ? decision && { entry_id: decision.event_id, checked_by: decision.decided_by, checked_at: decision.decided_at }
      : checkOf.get(f.classified.key);
    const checked = check?.entry_id === latest.id;
    return {
      key: f.classified.key,
      group: f.classified.group,
      kind: f.classified.kind,
      title: built.title,
      summary: built.summary,
      changes: built.changes,
      by: latest.actor_name,
      at: new Date(latest.created_at).toISOString(),
      checked,
      checked_by: checked ? check?.checked_by ?? null : null,
      checked_at: checked ? iso(check?.checked_at) : null,
      unusual: built.unusual_reason !== null,
      unusual_kind: built.unusual_reason ? KIND_OF_REASON[built.unusual_reason]! : null,
      unusual_reason: built.unusual_reason,
      latest_entry_id: latest.id,
      ...(built.contact ? { contact: built.contact } : {}),
    };
  });

  const groups: ReviewGroup[] = REVIEW_GROUP_ORDER.map((key) => ({
    key,
    label: REVIEW_GROUP_LABEL[key],
    items: key === 'unusual' ? items.filter((i) => i.unusual) : items.filter((i) => i.group === key),
  }));

  const summaryCheck = checkOf.get('summary');
  const summaryChecked = input.jobLatestEntryId !== null && summaryCheck?.entry_id === input.jobLatestEntryId;
  const d = input.details;
  const summary: ReviewSummary = {
    key: 'summary',
    title: 'Job details',
    checked: summaryChecked,
    checked_by: summaryChecked ? summaryCheck?.checked_by ?? null : null,
    checked_at: summaryChecked ? iso(summaryCheck?.checked_at) : null,
    latest_entry_id: input.jobLatestEntryId,
    job_number: d.job_number,
    job_type: d.job_type,
    customer: d.customer,
    service_address: d.service_address,
    visits: d.visits.map((v) => ({ ...v, scheduled_at: iso(v.scheduled_at) })),
    lines: d.lines.map(({ unit_cost, ...priced }) => (input.mayCosts ? { ...priced, unit_cost: unit_cost ?? null } : priced)),
    discount_amount: d.discount_amount,
    total: d.total,
    ...(input.mayCosts ? { total_cost: d.total_cost ?? null } : {}),
    invoices: d.invoices,
    balance: d.balance,
    file_count: d.file_count,
    note_count: d.note_count,
  };

  const finishedAt = input.finishedAt == null ? null : time(input.finishedAt);

  return {
    summary,
    groups,
    totals: {
      items: items.length + 1,
      checked: items.filter((i) => i.checked).length + (summaryChecked ? 1 : 0),
      unusual: items.filter((i) => i.unusual).length,
    },
    since_review: finishedAt === null ? null : items.filter((i) => time(i.at) > finishedAt),
  };
}

// ─── Is a change unusual, as it lands ──────────────────

/** The entries that fold into one item with this one: the same kind of thing, the same item key. */
const ITEM_FAMILIES: readonly (readonly string[])[] = [
  LINE_EVENTS, SCOPE_EVENTS, ['JOB_DISCOUNT_CHANGED'], INVOICE_LINE_EVENTS, ['JOB_INVOICE_DISCOUNT_CHANGED'],
  ATTACHMENT_EVENTS, NOTE_EVENTS, PAYMENT_EVENTS, CONTACT_EVENTS,
];

/** Every type of entry that can fold into the same item as an entry of this type; empty for a type the review does not read. */
export function itemEventTypesOf(eventType: string): string[] {
  return [...(ITEM_FAMILIES.find((family) => family.includes(eventType)) ?? [])];
}

/**
 * The types of entry whose landing can make an item unusual: a change or removal of a priced thing, a discount, a deleted
 * file, a customer detail added, changed or corrected. An add at the price it was added at, a raise, an upload, a note, a
 * payment and the removal of a customer detail can never make an item unusual, so a writer that lands one has nothing to ask.
 * A test pins this list to the panel's own answer for every kind of entry.
 */
const UNUSUAL_CAPABLE_EVENT_TYPES: readonly string[] = [
  'JOB_LINE_CHANGED', 'JOB_LINE_REMOVED', 'JOB_SCOPE_CHANGED', 'JOB_SCOPE_REMOVED', 'JOB_DISCOUNT_CHANGED',
  'JOB_INVOICE_LINE_CHANGED', 'JOB_INVOICE_LINE_REMOVED', 'JOB_INVOICE_DISCOUNT_CHANGED',
  'ATTACHMENT_DELETED',
  'JOB_CONTACT_ENTRY_ADDED', 'JOB_CONTACT_ENTRY_CHANGED', 'JOB_CONTACT_ENTRY_CORRECTED',
];

export const canBeUnusual = (eventType: string): boolean => UNUSUAL_CAPABLE_EVENT_TYPES.includes(eventType);

/**
 * Every type of entry that can fold into an item that is unusual: the families that hold an unusual-capable type. A note, a
 * payment and the like are left out, so reading a window for its unusual items never fetches them.
 */
export const UNUSUAL_RELEVANT_EVENT_TYPES: readonly string[] = ITEM_FAMILIES.filter((family) => family.some(canBeUnusual)).flat();

export interface UnusualChange {
  /** The item the change belongs to (the panel's own key for it). */
  key: string;
  kind: UnusualKind;
  /** The panel's words for why it is unusual: "A price was lowered", "A file was deleted", "A customer detail changed". */
  reason: string;
  /** The panel's title for the item: "Line: Faucet", "File: Front door.png", "Phone". */
  title: string;
  /**
   * The invoices the item is about (an invoice line, an invoice discount, a file on an invoice); empty for the rest. The panel
   * leaves the item out for a reader who cannot open one of them, so whatever repeats the item must do the same.
   */
  invoice_ids: string[];
}

/**
 * Whether the item an entry just landed on is unusual, by the panel's own rule: `history` is every entry of the round's
 * window on the job (in any order; entries of other items are ignored), `landed` the one that just arrived. The item is
 * folded and judged exactly as the panel does it (against its baseline, not against the last edit), so a cut that a later
 * small raise did not undo is still unusual, and the answer here and the panel's unusual flag can never disagree.
 * Null when the item is ordinary, or the entry is not one the review reads.
 */
export function unusualChangeOf(history: readonly ReviewHistoryEntry[], landed: ReviewHistoryEntry): UnusualChange | null {
  const classified = classify(landed);
  if (!classified) return null;
  const entries = history
    .filter((e) => classify(e)?.key === classified.key)
    .sort(byEntryOrder);
  if (entries.length === 0) return null;
  const built = build({ classified, entries }, new Map(), undefined);
  if (!built.unusual_reason) return null;
  return { key: classified.key, kind: KIND_OF_REASON[built.unusual_reason]!, reason: built.unusual_reason, title: built.title, invoice_ids: invoiceIdsOf(entries) };
}

/**
 * Every unusual item of a window, once each, in the order they first appear: `history` is the entries of the window on the job
 * (in any order). Each item is folded and judged exactly as the panel does it, so the list is the panel's unusual group by
 * construction. Used when a job ENTERS Office review (the attention alert lists what is already there).
 */
export function unusualChangesOf(history: readonly ReviewHistoryEntry[]): UnusualChange[] {
  const folded = new Map<string, Folded>();
  const ordered = [...history].sort(byEntryOrder);
  for (const e of ordered) {
    const classified = classify(e);
    if (!classified) continue;
    const slot = folded.get(classified.key);
    if (slot) slot.entries.push(e);
    else folded.set(classified.key, { classified, entries: [e] });
  }
  const found: UnusualChange[] = [];
  for (const f of folded.values()) {
    const built = build(f, new Map(), undefined);
    if (built.unusual_reason) {
      found.push({ key: f.classified.key, kind: KIND_OF_REASON[built.unusual_reason]!, reason: built.unusual_reason, title: built.title, invoice_ids: invoiceIdsOf(f.entries) });
    }
  }
  return found;
}

// ─── What is left, and the version ─────────────────────

/** Every item of the review once each (the unusual group lists some a second time), the job summary excluded. */
export const changeItems = (set: ReviewChangeSet): ReviewItem[] => set.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);

/** The names of what is still unchecked, the job summary first: what Finish review waits for and the panel's "what is left" line names. */
export function itemsLeft(set: ReviewChangeSet): string[] {
  return [
    ...(set.summary.checked ? [] : [set.summary.title]),
    ...changeItems(set).filter((i) => !i.checked).map((i) => i.title),
  ];
}

/**
 * The review's version: one short fingerprint of everything Finish review depends on, so a client that sends the version
 * it loaded is refused when anything has moved since. It is built from the answer itself, so it moves with everything
 * the answer can show: the job's latest history entry (any change on the job, whether or not the review lists it), every
 * item with its latest entry, its check and its decision, the customer's own value shown beside a changed name, and the
 * job summary's figures. Costs are left out, so two people with different money switches see the same version of the
 * same review. A check or a decision is part of it, so two reviewers working at once see each other's work as a change.
 */
export function reviewVersion(set: ReviewChangeSet): string {
  const { summary } = set;
  const material = {
    latest: summary.latest_entry_id,
    summary: {
      checked: summary.checked,
      job_type: summary.job_type,
      customer: summary.customer,
      address: summary.service_address,
      visits: summary.visits.map((v) => [v.seq, v.outcome, v.scheduled_at, v.finished_by, v.crew]),
      lines: summary.lines.map((l) => [l.name, l.quantity, l.unit_price, l.line_total]),
      discount: summary.discount_amount,
      total: summary.total,
      invoices: summary.invoices,
      balance: summary.balance,
      files: summary.file_count,
      notes: summary.note_count,
    },
    items: changeItems(set).map((i) => [i.key, i.latest_entry_id, i.checked, i.contact?.choice ?? null, i.contact?.decision ?? null, i.contact?.customer_current ?? null]),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 24);
}
