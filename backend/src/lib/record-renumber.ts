import { Prisma, PrismaClient } from '@prisma/client';
import { formatContainerEstimateNumber } from './numbering';

/**
 * Editable record IDs (Workiz dual-run) — the shared rename engine.
 *
 * One function computes what a rename of a Customer/Lead/Estimate/Job/Invoice would
 * touch (`computeRenumber` — read-only, safe outside a transaction, used to drive the
 * preview dialog) and one function applies it (`applyRenumber` — MUST run inside the
 * same locked transaction that holds the parent row lock, and re-derives the
 * computation fresh rather than trusting a caller-supplied one).
 *
 * See md_files/plans/numbering/2026-08-19-editable-record-ids.md ("Rename transaction",
 * "Validation rules", decisions #4/#5/#6/#8) for the product rules this file encodes.
 */

export type RenumberableEntity = 'customer' | 'lead' | 'estimate' | 'job' | 'invoice';

type ContainerKind = 'CUSTOMER' | 'LEAD' | 'JOB';

/** Anchor FK columns a LogisticOrder can carry — mirrors ANCHORS in numbering.ts, narrowed
 * to the five entities this feature covers (service_plan is out of scope for v1). */
type AnchorColumn = 'customer_id' | 'lead_id' | 'job_id' | 'estimate_id' | 'invoice_id';

/**
 * One denormalized label column to keep in sync with a renamed parent.
 *
 * `fkCol` is the table's own FK pointing back at the parent — present on every target
 * except `time_entries` (schema has no job FK there at all, only the best-effort string
 * `matched_job_number`; see the plan's "Denormalized label columns to refresh"). When
 * `fkCol` is set, a row matches by FK *or* by the old label string when its FK is NULL
 * (the job_stages / estimate_reservations hazard the plan calls out explicitly). When
 * `fkCol` is absent, the ONLY link is the string itself.
 */
interface LabelTarget {
  /** SQL table name (matches the model's `@@map`), e.g. `'job_stages'`. */
  table: string;
  /** The denormalized label column to rewrite, e.g. `'job_number'` / `'job_label'`. */
  labelCol: string;
  /** The table's FK back to the parent, when one exists. */
  fkCol?: string;
}

/** One row of `RENUMBER_CONFIG` — the closed, per-entity description of a rename's blast
 * radius. Every string here is a literal in this file, never caller input. */
interface RenumberConfig {
  /** SQL table name of the entity itself. */
  table: string;
  /** The entity's own human-number column. */
  numberCol: string;
  /** Set ONLY for customer/lead/job — the three SERV10X-61 estimate containers. */
  containerKind?: ContainerKind;
  /** The LogisticOrder FK column this entity anchors via (ANCHORS in numbering.ts). For
   * customer/lead/job this is ALSO the FK column Estimate carries for container
   * ownership (`customer_id`/`lead_id`/`job_id` — same name, same column, double duty). */
  anchorColumn: AnchorColumn;
  /** Denormalized label columns to refresh — empty for customer/lead/invoice. */
  labelTargets: LabelTarget[];
}

export const RENUMBER_CONFIG: Record<RenumberableEntity, RenumberConfig> = {
  customer: {
    table: 'customers',
    numberCol: 'customer_number',
    containerKind: 'CUSTOMER',
    anchorColumn: 'customer_id',
    labelTargets: [],
  },
  lead: {
    table: 'leads',
    numberCol: 'lead_number',
    containerKind: 'LEAD',
    anchorColumn: 'lead_id',
    labelTargets: [],
  },
  estimate: {
    table: 'estimates',
    numberCol: 'estimate_number',
    anchorColumn: 'estimate_id',
    labelTargets: [{ table: 'estimate_reservations', labelCol: 'estimate_number', fkCol: 'estimate_id' }],
  },
  job: {
    table: 'jobs',
    numberCol: 'job_number',
    containerKind: 'JOB',
    anchorColumn: 'job_id',
    labelTargets: [
      { table: 'job_stages', labelCol: 'job_number', fkCol: 'job_id' },
      { table: 'rfqs', labelCol: 'job_number', fkCol: 'job_id' },
      { table: 'stock_approvals', labelCol: 'job_number', fkCol: 'job_id' },
      { table: 'estimate_reservations', labelCol: 'job_number', fkCol: 'job_id' },
      // No FK at all on time_entries — matched_job_number is the only link.
      { table: 'time_entries', labelCol: 'matched_job_number' },
      { table: 'call_sessions', labelCol: 'job_label', fkCol: 'job_id' },
      { table: 'messages', labelCol: 'job_label', fkCol: 'job_id' },
      { table: 'whatsapp_messages', labelCol: 'job_label', fkCol: 'job_id' },
      { table: 'emails', labelCol: 'job_label', fkCol: 'job_id' },
      { table: 'pending_call_attributions', labelCol: 'job_label', fkCol: 'job_id' },
    ],
  },
  invoice: {
    table: 'invoices',
    numberCol: 'invoice_number',
    anchorColumn: 'invoice_id',
    labelTargets: [],
  },
};

// ============================================================================
// Prisma delegate resolution — RENUMBER_CONFIG speaks SQL table names (matching
// numbering.ts's own convention); Prisma Client exposes camelCase model delegates.
// This is the ONLY place that bridges the two, and only for the closed set of
// tables this feature ever touches.
// ============================================================================

const TABLE_DELEGATE: Record<string, string> = {
  customers: 'customer',
  leads: 'lead',
  estimates: 'estimate',
  jobs: 'job',
  invoices: 'invoice',
  logistic_orders: 'logisticOrder',
  job_stages: 'jobStage',
  rfqs: 'rfq',
  stock_approvals: 'stockApproval',
  estimate_reservations: 'estimateReservation',
  time_entries: 'timeEntry',
  call_sessions: 'callSession',
  messages: 'message',
  whatsapp_messages: 'whatsAppMessage',
  emails: 'email',
  pending_call_attributions: 'pendingCallAttribution',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDelegate = Record<string, (...args: any[]) => any>;

function getDelegate(db: Prisma.TransactionClient | PrismaClient, table: string): AnyDelegate {
  const key = TABLE_DELEGATE[table];
  if (!key) {
    throw new Error(`record-renumber: no Prisma delegate mapped for table "${table}"`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any)[key];
}

// ============================================================================
// Validation rules (plan "Validation rules")
// ============================================================================

const MAX_LENGTH = 20;
const MAX_NUMERIC_DIGITS = 9; // 999999999 — the largest value guaranteed not to overflow
// the int4 cast every allocator self-heal / maxNumberForTx / skip fallback performs on
// a trailing digit-run (see numbering.ts's allocateNumber doc comment).
const CHARSET_RE = /^[A-Za-z0-9._-]+$/; // no slash — flows into email attachment filenames
const PURE_NUMERIC_RE = /^[0-9]+$/;

export type ValidationResult = { ok: true; value: string } | { ok: false; error: string };

export function validateNumberFormat(raw: string): ValidationResult {
  const value = (raw ?? '').trim();

  if (value.length === 0) {
    return { ok: false, error: 'Number cannot be empty' };
  }
  if (value.length > MAX_LENGTH) {
    return { ok: false, error: `Number must be ${MAX_LENGTH} characters or fewer` };
  }
  if (!CHARSET_RE.test(value)) {
    return { ok: false, error: 'Number may only contain letters, digits, periods, underscores, and hyphens' };
  }
  if (PURE_NUMERIC_RE.test(value) && value.length > MAX_NUMERIC_DIGITS) {
    return { ok: false, error: `A purely numeric number cannot exceed ${MAX_NUMERIC_DIGITS} digits` };
  }

  return { ok: true, value };
}

// ============================================================================
// Invoice renumber lock (decision #8) — deliberately its own predicate, distinct
// from isInvoiceEditable's looser SENT/PARTIAL-still-editable policy.
// ============================================================================

export function isInvoiceRenumberLocked(invoice: {
  sent_at: Date | null;
  /** Every Payment row against the invoice, voided ones included - the caller must not
   *  pre-filter, or a voided payment silently becomes a live one here. */
  payments: Array<{ voided_at: Date | null }>;
}): boolean {
  if (invoice.sent_at !== null) return true;
  // Payment ROWS, never the residual (total - deposit - credits - amount_due) that
  // amountPaidOf derives. Voiding an invoice zeroes amount_due without a cent changing
  // hands, so the residual reports the whole total as collected and locks a voided,
  // never-sent, never-paid invoice out of a rename it is perfectly entitled to. A voided
  // payment is money that was un-collected, so it does not lock either.
  return invoice.payments.some((p) => p.voided_at === null);
}

// ============================================================================
// LIKE-pattern escaping — same technique as numbering.ts's (unexported) helper.
// ============================================================================

function escapeLikeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

// ============================================================================
// Rename computation
// ============================================================================

export interface DerivedChange {
  table: string;
  id: string;
  column: string;
  oldValue: string;
  newValue: string;
  conflict: boolean;
  /** The id of the row currently squatting on `newValue` in that table, when `conflict`. */
  conflictWithId?: string;
}

export interface RenumberComputation {
  entity: RenumberableEntity;
  parentId: string;
  oldNumber: string;
  newNumber: string;
  parentConflict: boolean;
  parentConflictWithId?: string;
  /** Container estimates + anchored logistic orders — NEVER label rows (labels have no
   * uniqueness constraint, so they can never conflict). */
  derived: DerivedChange[];
  /** Denormalized label rows — `conflict` is always false here. */
  labelRefreshes: DerivedChange[];
  /** True iff `parentConflict` or any `derived[].conflict`. */
  hasConflicts: boolean;
}

/** Build the WHERE clause for one label target: FK match, or (FK-less/NULL-FK) string
 * match on the old label — see LabelTarget's doc comment. Shared by the read (computeRenumber)
 * and the write (applyRenumber) so the two can never target different rows. */
function labelTargetWhere(
  target: LabelTarget,
  orgId: string,
  parentId: string,
  oldNumber: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!target.fkCol) {
    return { organization_id: orgId, [target.labelCol]: oldNumber };
  }
  return {
    organization_id: orgId,
    OR: [{ [target.fkCol]: parentId }, { AND: [{ [target.fkCol]: null }, { [target.labelCol]: oldNumber }] }],
  };
}

/**
 * Read-only. Computes everything a rename of `entity`/`parentId` to `newNumberRaw` would
 * touch, without taking any lock and without writing anything. Safe to call from a plain
 * (non-transaction) Prisma client for the preview endpoint; called again — this exact
 * function — inside the locked transaction by `applyRenumber`, so preview and apply can
 * never disagree in shape, only in whether the parent has changed underneath a stale
 * preview (which re-computing inside the lock catches).
 *
 * Throws (does NOT return a computation with conflicts) only for genuinely exceptional
 * caller-input errors: `parentId` not found in this org, or `newNumberRaw` fails
 * `validateNumberFormat`. Conflicts (another row already owning a wanted number) are a
 * normal, expected outcome and are reported in the returned computation instead.
 */
export async function computeRenumber(
  db: Prisma.TransactionClient | PrismaClient,
  entity: RenumberableEntity,
  parentId: string,
  orgId: string,
  newNumberRaw: string,
): Promise<RenumberComputation> {
  const validated = validateNumberFormat(newNumberRaw);
  if (!validated.ok) {
    throw new Error(`Invalid record number: ${validated.error}`);
  }
  const newNumber = validated.value;

  const config = RENUMBER_CONFIG[entity];
  const parentDelegate = getDelegate(db, config.table);

  const parent = await parentDelegate.findFirst({ where: { id: parentId, organization_id: orgId } });
  if (!parent) {
    throw new Error(`${entity} ${parentId} not found in organization ${orgId}`);
  }
  const oldNumber: string = parent[config.numberCol];

  const parentConflictRow = await parentDelegate.findFirst({
    where: {
      organization_id: orgId,
      id: { not: parentId },
      [config.numberCol]: { equals: newNumber, mode: 'insensitive' },
    },
  });
  const parentConflict = !!parentConflictRow;
  const parentConflictWithId = parentConflictRow ? (parentConflictRow.id as string) : undefined;

  const derived: DerivedChange[] = [];

  // ── Container-estimate cascade (customer/lead/job only) ──
  if (config.containerKind) {
    const estimateDelegate = getDelegate(db, 'estimates');
    const containerEstimates: Array<{ id: string; estimate_number: string; container_seq: number | null }> =
      await estimateDelegate.findMany({
        where: {
          organization_id: orgId,
          container_kind: config.containerKind,
          [config.anchorColumn]: parentId,
          number_is_custom: false,
        },
      });

    for (const est of containerEstimates) {
      // Same single renderer the allocator mints with (lib/numbering) - a cascade must not
      // re-implement the format, or a rename could produce a string the allocator would never
      // issue. container_seq is non-null for every row this query can return: container_kind and
      // container_seq are written together, by the allocator and by the backfill alike.
      const newValue = formatContainerEstimateNumber(newNumber, est.container_seq as number);
      const conflictRow = await estimateDelegate.findFirst({
        where: {
          organization_id: orgId,
          id: { not: est.id },
          estimate_number: { equals: newValue, mode: 'insensitive' },
        },
      });
      derived.push({
        table: 'estimates',
        id: est.id,
        column: 'estimate_number',
        oldValue: est.estimate_number,
        newValue,
        conflict: !!conflictRow,
        conflictWithId: conflictRow ? (conflictRow.id as string) : undefined,
      });
    }
  }

  // ── Anchored logistic-order cascade (all 5 entities) ──
  // Combination of the FK filter AND the number-LIKE filter is required, not redundant:
  // a LO can carry a secondary, non-precedence-winning FK without that FK having shaped
  // its number (see allocateAnchoredNumber's "Sequence domain" doc comment).
  const likePattern = `LO-${escapeLikeLiteral(oldNumber)}-%`;
  const anchoredRows = await db.$queryRaw<Array<{ id: string; number: string; seq: number }>>`
    SELECT id, number, seq
    FROM logistic_orders
    WHERE organization_id = ${orgId}::uuid
      AND ${Prisma.raw(config.anchorColumn)} = ${parentId}::uuid
      AND seq IS NOT NULL
      AND number LIKE ${likePattern}
  `;
  const logisticOrderDelegate = getDelegate(db, 'logistic_orders');
  for (const lo of anchoredRows) {
    const newValue = `LO-${newNumber}-${lo.seq}`;
    const conflictRow = await logisticOrderDelegate.findFirst({
      where: {
        organization_id: orgId,
        id: { not: lo.id },
        number: { equals: newValue, mode: 'insensitive' },
      },
    });
    derived.push({
      table: 'logistic_orders',
      id: lo.id,
      column: 'number',
      oldValue: lo.number,
      newValue,
      conflict: !!conflictRow,
      conflictWithId: conflictRow ? (conflictRow.id as string) : undefined,
    });
  }

  // ── Denormalized label refreshes — never conflicts (no uniqueness on a label column) ──
  const labelRefreshes: DerivedChange[] = [];
  for (const target of config.labelTargets) {
    const delegate = getDelegate(db, target.table);
    const where = labelTargetWhere(target, orgId, parentId, oldNumber);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Array<Record<string, any>> = await delegate.findMany({ where });
    for (const row of rows) {
      labelRefreshes.push({
        table: target.table,
        id: row.id as string,
        column: target.labelCol,
        oldValue: (row[target.labelCol] ?? '') as string,
        newValue: newNumber,
        conflict: false,
      });
    }
  }

  const hasConflicts = parentConflict || derived.some((d) => d.conflict);

  return {
    entity,
    parentId,
    oldNumber,
    newNumber,
    parentConflict,
    parentConflictWithId,
    derived,
    labelRefreshes,
    hasConflicts,
  };
}

/**
 * Must be called with `tx` as part of the SAME transaction that already holds the row
 * lock on the parent (the controller locks it before calling this — see phase 2). Always
 * re-derives the computation via `computeRenumber(tx, ...)` — never trusts a caller-supplied
 * `RenumberComputation`, even a fresh-looking one — and throws if `hasConflicts`. On
 * success, writes the parent's own number + `number_is_custom=true` + `original_number`
 * (set only if currently null — the first change of any kind), every derived
 * container-estimate's number + `original_number` (same first-change-only rule; its OWN
 * `number_is_custom` is left untouched — a parent-driven cascade never marks a child
 * custom, only a direct edit on that child's own row does), every anchored LO's number
 * (no `number_is_custom`/`original_number` columns on LogisticOrder — out of scope), and
 * every label-refresh row's label column. Never touches `estimate_seq` or LO `seq`.
 *
 * Returns the (conflict-free) computation that was applied, for the controller to build
 * its response/audit metadata from.
 */
export async function applyRenumber(
  tx: Prisma.TransactionClient,
  entity: RenumberableEntity,
  parentId: string,
  orgId: string,
  newNumberRaw: string,
): Promise<RenumberComputation> {
  const computation = await computeRenumber(tx, entity, parentId, orgId, newNumberRaw);
  if (computation.hasConflicts) {
    const conflictCount = (computation.parentConflict ? 1 : 0) + computation.derived.filter((d) => d.conflict).length;
    throw new Error(
      `Cannot rename ${entity} ${parentId}: ${conflictCount} conflicting number(s) already exist in this organization`,
    );
  }

  const config = RENUMBER_CONFIG[entity];
  const parentDelegate = getDelegate(tx, config.table);

  // Parent write. original_number is set ONLY on the first change ever (COALESCE
  // semantics, computed in JS off the row we already have to hand).
  const parentRow: { original_number: string | null } | null = await parentDelegate.findFirst({
    where: { id: parentId, organization_id: orgId },
  });
  await parentDelegate.update({
    where: { id: parentId },
    data: {
      [config.numberCol]: computation.newNumber,
      number_is_custom: true,
      original_number: parentRow?.original_number ?? computation.oldNumber,
    },
  });

  // Derived writes — container estimates (string + original_number, own number_is_custom
  // untouched) and anchored logistic orders (string only, no original_number column).
  const estimateDelegate = getDelegate(tx, 'estimates');
  const logisticOrderDelegate = getDelegate(tx, 'logistic_orders');
  for (const d of computation.derived) {
    if (d.table === 'estimates') {
      const row: { original_number: string | null } | null = await estimateDelegate.findFirst({
        where: { id: d.id },
      });
      await estimateDelegate.update({
        where: { id: d.id },
        data: {
          estimate_number: d.newValue,
          original_number: row?.original_number ?? d.oldValue,
        },
      });
    } else if (d.table === 'logistic_orders') {
      await logisticOrderDelegate.update({ where: { id: d.id }, data: { number: d.newValue } });
    }
  }

  // Label refreshes — one batched updateMany per target, re-running the SAME predicate
  // the read used (fresh, inside this transaction — not the possibly-stale ids from the
  // computation above), so a row created concurrently under the parent lock still lands.
  for (const target of config.labelTargets) {
    const delegate = getDelegate(tx, target.table);
    const where = labelTargetWhere(target, orgId, parentId, computation.oldNumber);
    await delegate.updateMany({ where, data: { [target.labelCol]: computation.newNumber } });
  }

  return computation;
}
