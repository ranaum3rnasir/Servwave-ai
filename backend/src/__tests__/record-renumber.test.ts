import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  validateNumberFormat,
  isInvoiceRenumberLocked,
  computeRenumber,
  applyRenumber,
  RENUMBER_CONFIG,
} from '../lib/record-renumber';

const ORG_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  // Neither vitest.config.ts nor setup.ts clears mocks globally (house
  // convention — see numbering.test.ts) so every prisma delegate call/args
  // history would otherwise accumulate across tests in this file.
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Tiny in-memory Prisma-delegate emulator, shared by every computeRenumber /
// applyRenumber test below. Mutates the SAME row objects the test passed in,
// so a test can call applyRenumber and then assert directly on its own
// fixture rows to see what got written — no separate "assert the mock was
// called with X" bookkeeping needed.
// ─────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchesWhere(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((sub) => matchesWhere(row, sub))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Row[]).every((sub) => matchesWhere(row, sub))) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('equals' in cond) {
        const want = (cond as { equals: unknown; mode?: string }).equals;
        if ((cond as { mode?: string }).mode === 'insensitive') {
          if (String(row[key] ?? '').toLowerCase() !== String(want ?? '').toLowerCase()) return false;
        } else if (row[key] !== want) {
          return false;
        }
        continue;
      }
      if ('not' in cond) {
        if (row[key] === (cond as { not: unknown }).not) return false;
        continue;
      }
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

// `model` is a mocked Prisma delegate (real Prisma type at compile time, a plain
// vi.fn()-bearing object at runtime — see setup.ts's `vi.mock('../lib/prisma', ...)`),
// so its methods are cast to `Mock` individually rather than typed up front.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installTable(model: any, rows: Row[]): Row[] {
  const findFirst = model.findFirst as Mock | undefined;
  const findMany = model.findMany as Mock | undefined;
  const update = model.update as Mock | undefined;
  const updateMany = model.updateMany as Mock | undefined;

  if (findFirst) {
    findFirst.mockImplementation(async ({ where }: { where: Row }) => rows.find((r) => matchesWhere(r, where)) ?? null);
  }
  if (findMany) {
    findMany.mockImplementation(async ({ where }: { where: Row }) => rows.filter((r) => matchesWhere(r, where)));
  }
  if (update) {
    update.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matchesWhere(r, where));
      if (!row) throw new Error(`mock update: no row matches ${JSON.stringify(where)}`);
      Object.assign(row, data);
      return { ...row };
    });
  }
  if (updateMany) {
    updateMany.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
      const matched = rows.filter((r) => matchesWhere(r, where));
      matched.forEach((r) => Object.assign(r, data));
      return { count: matched.length };
    });
  }
  return rows;
}

// ─── Faithful emulator for the ONE raw-SQL shape record-renumber.ts emits
// (the anchored-LO cascade SELECT) — evaluates the FK filter and the LIKE
// filter against fixture rows exactly as Postgres would, rather than canning
// a per-test answer (a dropped predicate in the implementation must fail
// these tests; a canned mock would not). Mirrors the render()/likeMatch()
// technique in numbering-logistic-order.test.ts. ───

function renderSql(strings: readonly string[], values: readonly unknown[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let sql = strings[0];
  values.forEach((value, i) => {
    if (value && typeof value === 'object' && Array.isArray((value as { strings?: unknown }).strings)) {
      sql += (value as { strings: string[] }).strings.join('');
    } else {
      params.push(value);
      sql += '$P';
    }
    sql += strings[i + 1];
  });
  return { sql: sql.replace(/\s+/g, ' ').trim(), params };
}

function likeMatch(value: string, pattern: string): boolean {
  const quote = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1;
      re += quote(pattern[i] ?? '');
    } else if (c === '%') {
      re += '.*';
    } else if (c === '_') {
      re += '.';
    } else {
      re += quote(c);
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

/** Installs an EMPTY table for every one of the job entity's 10 label-target tables.
 * Every job-entity computeRenumber/applyRenumber call iterates all 10 configured
 * targets regardless of what a given test cares about, so any such test must install
 * something (even []) for each — a raw un-installed vi.fn() resolves to `undefined`,
 * not `[]`. Call this first, then re-install specific tables with real fixtures. */
function installEmptyJobLabelTargets(): void {
  installTable(prisma.jobStage, []);
  installTable(prisma.rfq, []);
  installTable(prisma.stockApproval, []);
  installTable(prisma.estimateReservation, []);
  installTable(prisma.timeEntry, []);
  installTable(prisma.callSession, []);
  installTable(prisma.message, []);
  installTable(prisma.whatsAppMessage, []);
  installTable(prisma.email, []);
  installTable(prisma.pendingCallAttribution, []);
}

function installAnchoredLoQueryRaw(mockFn: Mock, fixtures: Row[]): void {
  mockFn.mockImplementation((strings: readonly string[], ...values: unknown[]) => {
    const { sql, params } = renderSql(strings, values);
    if (!/FROM logistic_orders/i.test(sql)) {
      throw new Error(`fake $queryRaw received unexpected SQL: ${sql}`);
    }
    const anchorColumn = /AND (\w+) = \$P::uuid/.exec(sql)?.[1];
    if (!anchorColumn) throw new Error(`could not find anchor column in SQL: ${sql}`);
    const [paramOrgId, paramAnchorId, likePattern] = params as [string, string, string];
    const rows = fixtures.filter(
      (r) =>
        r.organization_id === paramOrgId &&
        r[anchorColumn] === paramAnchorId &&
        r.seq !== null &&
        r.seq !== undefined &&
        likeMatch(r.number as string, likePattern),
    );
    return Promise.resolve(rows.map((r) => ({ id: r.id, number: r.number, seq: r.seq })));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// validateNumberFormat
// ─────────────────────────────────────────────────────────────────────────

describe('validateNumberFormat', () => {
  it('trims surrounding whitespace', () => {
    const result = validateNumberFormat('  698637  ');
    expect(result).toEqual({ ok: true, value: '698637' });
  });

  it('rejects an empty string', () => {
    const result = validateNumberFormat('');
    expect(result.ok).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    const result = validateNumberFormat('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects a value over 20 characters', () => {
    const result = validateNumberFormat('A'.repeat(21));
    expect(result.ok).toBe(false);
  });

  it('accepts a value at exactly 20 characters', () => {
    const value = 'A'.repeat(20);
    const result = validateNumberFormat(value);
    expect(result).toEqual({ ok: true, value });
  });

  it('rejects a value containing a slash', () => {
    const result = validateNumberFormat('123/456');
    expect(result.ok).toBe(false);
  });

  it('rejects a value with an invalid character (space, symbol)', () => {
    expect(validateNumberFormat('12 34').ok).toBe(false);
    expect(validateNumberFormat('12#34').ok).toBe(false);
  });

  it('accepts a 9-digit purely-numeric value', () => {
    const result = validateNumberFormat('123456789');
    expect(result).toEqual({ ok: true, value: '123456789' });
  });

  it('rejects a 10-digit purely-numeric value', () => {
    const result = validateNumberFormat('1234567890');
    expect(result.ok).toBe(false);
  });

  it('accepts a non-numeric 20-char value mixing the allowed charset', () => {
    const value = 'AbC-123.def_456-XYZ0'; // 20 chars, letters/digits/./_/-
    expect(value.length).toBe(20);
    const result = validateNumberFormat(value);
    expect(result).toEqual({ ok: true, value });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isInvoiceRenumberLocked
// ─────────────────────────────────────────────────────────────────────────

describe('isInvoiceRenumberLocked', () => {
  const PAID = { voided_at: null };
  const VOIDED_PAYMENT = { voided_at: new Date('2026-08-19T00:00:00Z') };

  it('is false for an unsent invoice with no payments', () => {
    expect(isInvoiceRenumberLocked({ sent_at: null, payments: [] })).toBe(false);
  });

  it('is true once sent_at is set, even with no payments', () => {
    expect(
      isInvoiceRenumberLocked({ sent_at: new Date('2026-08-19T00:00:00Z'), payments: [] }),
    ).toBe(true);
  });

  it('is true for a collected payment even when sent_at is still null (on-site cash)', () => {
    expect(isInvoiceRenumberLocked({ sent_at: null, payments: [PAID] })).toBe(true);
  });

  it('is false when the only payment against it was voided', () => {
    expect(isInvoiceRenumberLocked({ sent_at: null, payments: [VOIDED_PAYMENT] })).toBe(false);
  });

  it('is true when a voided payment sits alongside a live one', () => {
    expect(isInvoiceRenumberLocked({ sent_at: null, payments: [VOIDED_PAYMENT, PAID] })).toBe(true);
  });

  // The regression this predicate was rewritten for. Voiding an invoice zeroes amount_due
  // without a cent changing hands, so the old residual derivation
  // (total - deposit - credits - amount_due) reported the FULL total as collected and locked
  // a voided, never-sent, never-paid invoice out of being renumbered. Payment rows are the
  // only honest evidence that money moved.
  it('is false for a voided invoice that was never sent and never paid', () => {
    expect(isInvoiceRenumberLocked({ sent_at: null, payments: [] })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RENUMBER_CONFIG shape sanity (guards the fixtures below against typos)
// ─────────────────────────────────────────────────────────────────────────

describe('RENUMBER_CONFIG', () => {
  it('sets containerKind only for customer/lead/job', () => {
    expect(RENUMBER_CONFIG.customer.containerKind).toBe('CUSTOMER');
    expect(RENUMBER_CONFIG.lead.containerKind).toBe('LEAD');
    expect(RENUMBER_CONFIG.job.containerKind).toBe('JOB');
    expect(RENUMBER_CONFIG.estimate.containerKind).toBeUndefined();
    expect(RENUMBER_CONFIG.invoice.containerKind).toBeUndefined();
  });

  it('gives every entity an anchorColumn matching ANCHORS', () => {
    expect(RENUMBER_CONFIG.customer.anchorColumn).toBe('customer_id');
    expect(RENUMBER_CONFIG.lead.anchorColumn).toBe('lead_id');
    expect(RENUMBER_CONFIG.estimate.anchorColumn).toBe('estimate_id');
    expect(RENUMBER_CONFIG.job.anchorColumn).toBe('job_id');
    expect(RENUMBER_CONFIG.invoice.anchorColumn).toBe('invoice_id');
  });

  it('customer/lead/invoice have no label targets; estimate has exactly one', () => {
    expect(RENUMBER_CONFIG.customer.labelTargets).toHaveLength(0);
    expect(RENUMBER_CONFIG.lead.labelTargets).toHaveLength(0);
    expect(RENUMBER_CONFIG.invoice.labelTargets).toHaveLength(0);
    expect(RENUMBER_CONFIG.estimate.labelTargets).toEqual([
      { table: 'estimate_reservations', labelCol: 'estimate_number', fkCol: 'estimate_id' },
    ]);
  });

  it('job has all 6 label-target groups (10 physical tables)', () => {
    const tables = RENUMBER_CONFIG.job.labelTargets.map((t) => t.table);
    expect(tables).toEqual(
      expect.arrayContaining([
        'job_stages',
        'rfqs',
        'stock_approvals',
        'estimate_reservations',
        'time_entries',
        'call_sessions',
        'messages',
        'whatsapp_messages',
        'emails',
        'pending_call_attributions',
      ]),
    );
    expect(tables).toHaveLength(10);
    const timeEntriesTarget = RENUMBER_CONFIG.job.labelTargets.find((t) => t.table === 'time_entries');
    expect(timeEntriesTarget?.fkCol).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeRenumber — container-estimate cascade (customer/lead/job)
// ─────────────────────────────────────────────────────────────────────────

describe('computeRenumber — container-estimate cascade', () => {
  it('includes a container estimate with number_is_custom=false, and excludes a custom sibling (decision #5 immunity)', async () => {
    const JOB_ID = 'job-1';
    installTable(prisma.job, [
      { id: JOB_ID, job_number: 'OLD-J', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, [
      {
        id: 'est-auto',
        estimate_number: 'OLD-J-1',
        organization_id: ORG_ID,
        container_kind: 'JOB',
        job_id: JOB_ID,
        customer_id: null,
        lead_id: null,
        container_seq: 1,
        number_is_custom: false,
        original_number: null,
      },
      {
        id: 'est-custom',
        estimate_number: 'HAND-TYPED',
        organization_id: ORG_ID,
        container_kind: 'JOB',
        job_id: JOB_ID,
        customer_id: null,
        lead_id: null,
        container_seq: 2,
        number_is_custom: true, // immune — must never be touched by the parent cascade
        original_number: null,
      },
    ]);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);
    installEmptyJobLabelTargets();

    const result = await computeRenumber(prisma, 'job', JOB_ID, ORG_ID, 'NEW-J');

    expect(result.derived).toHaveLength(1);
    expect(result.derived[0]).toMatchObject({
      table: 'estimates',
      id: 'est-auto',
      oldValue: 'OLD-J-1',
      newValue: 'NEW-J-1',
      conflict: false,
    });
    expect(result.derived.some((d) => d.id === 'est-custom')).toBe(false);
  });

  it('customer container cascade uses customer_id and CUSTOMER container_kind', async () => {
    const CUST_ID = 'cust-1';
    installTable(prisma.customer, [
      { id: CUST_ID, customer_number: 'C-OLD', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, [
      {
        id: 'est-1',
        estimate_number: 'C-OLD-1',
        organization_id: ORG_ID,
        container_kind: 'CUSTOMER',
        customer_id: CUST_ID,
        lead_id: null,
        job_id: null,
        container_seq: 1,
        number_is_custom: false,
        original_number: null,
      },
    ]);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);

    const result = await computeRenumber(prisma, 'customer', CUST_ID, ORG_ID, 'C-NEW');

    expect(result.derived).toEqual([
      expect.objectContaining({ table: 'estimates', id: 'est-1', newValue: 'C-NEW-1' }),
    ]);
  });

  it('lead container cascade uses lead_id and LEAD container_kind', async () => {
    const LEAD_ID = 'lead-1';
    installTable(prisma.lead, [
      { id: LEAD_ID, lead_number: 'L-OLD', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, [
      {
        id: 'est-1',
        estimate_number: 'L-OLD-1',
        organization_id: ORG_ID,
        container_kind: 'LEAD',
        lead_id: LEAD_ID,
        customer_id: null,
        job_id: null,
        container_seq: 1,
        number_is_custom: false,
        original_number: null,
      },
    ]);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);

    const result = await computeRenumber(prisma, 'lead', LEAD_ID, ORG_ID, 'L-NEW');

    expect(result.derived).toEqual([
      expect.objectContaining({ table: 'estimates', id: 'est-1', newValue: 'L-NEW-1' }),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeRenumber — anchored logistic-order cascade (synthetic fixtures —
// prod has ZERO anchored LOs in any org, so this is the only place this
// logic is ever exercised; see the plan's explicit callout).
// ─────────────────────────────────────────────────────────────────────────

describe('computeRenumber — anchored logistic-order cascade', () => {
  it('includes an anchored LO matching FK+LIKE, excludes a flat LO (seq null), and excludes a same-FK LO shaped by a DIFFERENT anchor string', async () => {
    const JOB_ID = 'job-1';
    installTable(prisma.job, [
      { id: JOB_ID, job_number: 'OLD-J', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, []); // no container cascade needed for this test
    const loFixtures: Row[] = [
      { id: 'lo-anchored', number: 'LO-OLD-J-1', seq: 1, organization_id: ORG_ID, job_id: JOB_ID },
      // Flat LO — seq NULL is the authoritative flat/anchored discriminator.
      { id: 'lo-flat', number: 'LO00003', seq: null, organization_id: ORG_ID, job_id: null },
      // Same FK column set (job_id = JOB_ID) but the number was shaped by a
      // DIFFERENT anchor string entirely — must be excluded by the LIKE filter,
      // not just the FK filter (the "combination is required" case).
      { id: 'lo-other-anchor', number: 'LO-SOMEOTHERJOB-5', seq: 5, organization_id: ORG_ID, job_id: JOB_ID },
    ];
    installTable(prisma.logisticOrder, loFixtures);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, loFixtures);
    installEmptyJobLabelTargets();

    const result = await computeRenumber(prisma, 'job', JOB_ID, ORG_ID, 'NEW-J');

    expect(result.derived).toHaveLength(1);
    expect(result.derived[0]).toMatchObject({
      table: 'logistic_orders',
      id: 'lo-anchored',
      oldValue: 'LO-OLD-J-1',
      newValue: 'LO-NEW-J-1',
      conflict: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeRenumber — estimate entity (not a container; still anchors LOs)
// ─────────────────────────────────────────────────────────────────────────

describe('computeRenumber — estimate (no container cascade of its own)', () => {
  it('never queries for a container-estimate cascade, but still runs the anchored-LO cascade', async () => {
    const EST_ID = 'est-1';
    installTable(prisma.estimate, [
      { id: EST_ID, estimate_number: 'OLD-E', organization_id: ORG_ID, original_number: null },
    ]);
    const loFixtures: Row[] = [
      { id: 'lo-1', number: 'LO-OLD-E-1', seq: 1, organization_id: ORG_ID, estimate_id: EST_ID },
    ];
    installTable(prisma.logisticOrder, loFixtures);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, loFixtures);
    installTable(prisma.estimateReservation, []);

    const result = await computeRenumber(prisma, 'estimate', EST_ID, ORG_ID, 'NEW-E');

    // No container cascade: estimate.findMany (the container-lookup call) is never invoked —
    // the only estimate.findFirst calls are the parent load/conflict check above.
    expect((prisma.estimate.findMany as Mock)).not.toHaveBeenCalled();
    expect(result.derived).toEqual([
      expect.objectContaining({ table: 'logistic_orders', id: 'lo-1', newValue: 'LO-NEW-E-1' }),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeRenumber — denormalized label refreshes
// ─────────────────────────────────────────────────────────────────────────

describe('computeRenumber — label refreshes', () => {
  const JOB_ID = 'job-1';

  function setupJobWithNoCascadeChildren() {
    installTable(prisma.job, [
      { id: JOB_ID, job_number: 'OLD-J', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, []);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);
  }

  it('a job rename triggers all 10 label-target tables (the 6 named groups)', async () => {
    setupJobWithNoCascadeChildren();
    installTable(prisma.jobStage, [{ id: 'js-1', job_id: JOB_ID, job_number: 'x', organization_id: ORG_ID }]);
    installTable(prisma.rfq, [{ id: 'rfq-1', job_id: JOB_ID, job_number: 'x', organization_id: ORG_ID }]);
    installTable(prisma.stockApproval, [{ id: 'sa-1', job_id: JOB_ID, job_number: 'x', organization_id: ORG_ID }]);
    installTable(prisma.estimateReservation, [{ id: 'er-1', job_id: JOB_ID, job_number: 'x', organization_id: ORG_ID }]);
    installTable(prisma.timeEntry, [{ id: 'te-1', matched_job_number: 'OLD-J', organization_id: ORG_ID }]);
    installTable(prisma.callSession, [{ id: 'cs-1', job_id: JOB_ID, job_label: 'x', organization_id: ORG_ID }]);
    installTable(prisma.message, [{ id: 'msg-1', job_id: JOB_ID, job_label: 'x', organization_id: ORG_ID }]);
    installTable(prisma.whatsAppMessage, [{ id: 'wam-1', job_id: JOB_ID, job_label: 'x', organization_id: ORG_ID }]);
    installTable(prisma.email, [{ id: 'em-1', job_id: JOB_ID, job_label: 'x', organization_id: ORG_ID }]);
    installTable(prisma.pendingCallAttribution, [{ id: 'pca-1', job_id: JOB_ID, job_label: 'x', organization_id: ORG_ID }]);

    const result = await computeRenumber(prisma, 'job', JOB_ID, ORG_ID, 'NEW-J');

    const tables = result.labelRefreshes.map((r) => r.table).sort();
    expect(tables).toEqual(
      [
        'call_sessions',
        'emails',
        'estimate_reservations',
        'job_stages',
        'messages',
        'pending_call_attributions',
        'rfqs',
        'stock_approvals',
        'time_entries',
        'whatsapp_messages',
      ].sort(),
    );
    expect(result.labelRefreshes.every((r) => r.newValue === 'NEW-J')).toBe(true);
    expect(result.labelRefreshes.every((r) => r.conflict === false)).toBe(true);
  });

  it('an estimate rename triggers exactly the estimate_reservations.estimate_number target', async () => {
    const EST_ID = 'est-1';
    installTable(prisma.estimate, [
      { id: EST_ID, estimate_number: 'OLD-E', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);
    installTable(prisma.estimateReservation, [
      { id: 'er-1', estimate_id: EST_ID, estimate_number: 'x', job_id: null, job_number: null, organization_id: ORG_ID },
    ]);

    const result = await computeRenumber(prisma, 'estimate', EST_ID, ORG_ID, 'NEW-E');

    expect(result.labelRefreshes).toEqual([
      expect.objectContaining({ table: 'estimate_reservations', id: 'er-1', column: 'estimate_number', newValue: 'NEW-E' }),
    ]);
  });

  it('customer/lead/invoice renames trigger no label refreshes at all', async () => {
    installTable(prisma.customer, [
      { id: 'cust-1', customer_number: 'C-OLD', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.lead, [{ id: 'lead-1', lead_number: 'L-OLD', organization_id: ORG_ID, original_number: null }]);
    installTable(prisma.invoice, [
      { id: 'inv-1', invoice_number: 'I-OLD', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, []);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);

    const customerResult = await computeRenumber(prisma, 'customer', 'cust-1', ORG_ID, 'C-NEW');
    const leadResult = await computeRenumber(prisma, 'lead', 'lead-1', ORG_ID, 'L-NEW');
    const invoiceResult = await computeRenumber(prisma, 'invoice', 'inv-1', ORG_ID, 'I-NEW');

    expect(customerResult.labelRefreshes).toEqual([]);
    expect(leadResult.labelRefreshes).toEqual([]);
    expect(invoiceResult.labelRefreshes).toEqual([]);
  });

  it('a single job_stages call matches BOTH an FK-linked row and a NULL-FK/string-matched row', async () => {
    setupJobWithNoCascadeChildren();
    installTable(prisma.jobStage, [
      // FK-linked — matches regardless of its current (possibly stale) label.
      { id: 'js-fk', job_id: JOB_ID, job_number: 'SOME-STALE-VALUE', organization_id: ORG_ID },
      // No FK — the string is the ONLY link, so it must equal the OLD number exactly.
      { id: 'js-string', job_id: null, job_number: 'OLD-J', organization_id: ORG_ID },
      // No FK and a non-matching string — must be excluded.
      { id: 'js-unrelated', job_id: null, job_number: 'UNRELATED', organization_id: ORG_ID },
    ]);
    installTable(prisma.rfq, []);
    installTable(prisma.stockApproval, []);
    installTable(prisma.estimateReservation, []);
    installTable(prisma.timeEntry, []);
    installTable(prisma.callSession, []);
    installTable(prisma.message, []);
    installTable(prisma.whatsAppMessage, []);
    installTable(prisma.email, []);
    installTable(prisma.pendingCallAttribution, []);

    const result = await computeRenumber(prisma, 'job', JOB_ID, ORG_ID, 'NEW-J');

    const jobStageRefreshes = result.labelRefreshes.filter((r) => r.table === 'job_stages');
    expect(jobStageRefreshes.map((r) => r.id).sort()).toEqual(['js-fk', 'js-string']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeRenumber — conflict detection (decision #6: every conflict across
// every entity is surfaced at once, all-or-nothing)
// ─────────────────────────────────────────────────────────────────────────

describe('computeRenumber — conflict detection', () => {
  it('flags a parent conflict when another row in the same table already owns the wanted number', async () => {
    installTable(prisma.customer, [
      { id: 'cust-1', customer_number: 'C-OLD', organization_id: ORG_ID, original_number: null },
      { id: 'cust-2', customer_number: 'C-NEW', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, []);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);

    const result = await computeRenumber(prisma, 'customer', 'cust-1', ORG_ID, 'C-NEW');

    expect(result.parentConflict).toBe(true);
    expect(result.parentConflictWithId).toBe('cust-2');
    expect(result.hasConflicts).toBe(true);
  });

  it('flags a parent conflict case-insensitively (existing row differs only in case)', async () => {
    installTable(prisma.customer, [
      { id: 'cust-1', customer_number: 'C-OLD', organization_id: ORG_ID, original_number: null },
      { id: 'cust-2', customer_number: 'c-new', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, []);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);

    const result = await computeRenumber(prisma, 'customer', 'cust-1', ORG_ID, 'C-NEW');

    expect(result.parentConflict).toBe(true);
    expect(result.hasConflicts).toBe(true);
  });

  it('flags a derived-child conflict even when the parent itself has NO conflict', async () => {
    const JOB_ID = 'job-1';
    installTable(prisma.job, [
      { id: JOB_ID, job_number: 'OLD-J', organization_id: ORG_ID, original_number: null },
      // No other job owns 'NEW-J' — the PARENT is conflict-free.
    ]);
    installTable(prisma.estimate, [
      {
        id: 'est-auto',
        estimate_number: 'OLD-J-1',
        organization_id: ORG_ID,
        container_kind: 'JOB',
        job_id: JOB_ID,
        customer_id: null,
        lead_id: null,
        container_seq: 1,
        number_is_custom: false,
        original_number: null,
      },
      // An unrelated estimate already squats on the computed derived value.
      {
        id: 'est-squatter',
        estimate_number: 'NEW-J-1',
        organization_id: ORG_ID,
        container_kind: null,
        job_id: null,
        customer_id: null,
        lead_id: null,
        container_seq: null,
        number_is_custom: false,
        original_number: null,
      },
    ]);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);
    installEmptyJobLabelTargets();

    const result = await computeRenumber(prisma, 'job', JOB_ID, ORG_ID, 'NEW-J');

    expect(result.parentConflict).toBe(false);
    expect(result.derived).toEqual([
      expect.objectContaining({ id: 'est-auto', conflict: true, conflictWithId: 'est-squatter' }),
    ]);
    expect(result.hasConflicts).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// applyRenumber
// ─────────────────────────────────────────────────────────────────────────

describe('applyRenumber', () => {
  it('re-derives fresh inside the transaction and throws on conflict, writing NOTHING', async () => {
    installTable(prisma.customer, [
      { id: 'cust-1', customer_number: 'C-OLD', organization_id: ORG_ID, original_number: null },
      { id: 'cust-2', customer_number: 'C-NEW', organization_id: ORG_ID, original_number: null },
    ]);
    installTable(prisma.estimate, []);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyRenumber(prisma as any, 'customer', 'cust-1', ORG_ID, 'C-NEW')).rejects.toThrow(/conflict/i);

    expect((prisma.customer.update as Mock)).not.toHaveBeenCalled();
  });

  it('on a clean run: writes parent number_is_custom=true, sets original_number only on the first change, and leaves derived children\'s own number_is_custom untouched', async () => {
    const JOB_ID = 'job-1';
    const jobRows = installTable(prisma.job, [
      { id: JOB_ID, job_number: 'OLD-J', organization_id: ORG_ID, original_number: null },
    ]);
    const estimateRows = installTable(prisma.estimate, [
      {
        id: 'est-auto',
        estimate_number: 'OLD-J-1',
        organization_id: ORG_ID,
        container_kind: 'JOB',
        job_id: JOB_ID,
        customer_id: null,
        lead_id: null,
        container_seq: 1,
        number_is_custom: false,
        original_number: null,
      },
    ]);
    const loFixtures: Row[] = [
      { id: 'lo-1', number: 'LO-OLD-J-1', seq: 1, organization_id: ORG_ID, job_id: JOB_ID },
    ];
    installTable(prisma.logisticOrder, loFixtures);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, loFixtures);
    const jobStageRows = installTable(prisma.jobStage, [
      { id: 'js-1', job_id: JOB_ID, job_number: 'OLD-J', organization_id: ORG_ID },
    ]);
    installTable(prisma.rfq, []);
    installTable(prisma.stockApproval, []);
    installTable(prisma.estimateReservation, []);
    installTable(prisma.timeEntry, []);
    installTable(prisma.callSession, []);
    installTable(prisma.message, []);
    installTable(prisma.whatsAppMessage, []);
    installTable(prisma.email, []);
    installTable(prisma.pendingCallAttribution, []);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const computation = await applyRenumber(prisma as any, 'job', JOB_ID, ORG_ID, 'NEW-J');

    expect(computation.hasConflicts).toBe(false);

    // Parent: number written, marked custom, original_number set (was null).
    expect(jobRows[0]).toMatchObject({ job_number: 'NEW-J', number_is_custom: true, original_number: 'OLD-J' });

    // Derived container estimate: number rewritten + original_number set, but its
    // OWN number_is_custom is untouched by the cascade (decision #5).
    expect(estimateRows[0]).toMatchObject({
      estimate_number: 'NEW-J-1',
      original_number: 'OLD-J-1',
      number_is_custom: false,
    });

    // Derived anchored LO: number rewritten, no number_is_custom/original_number columns.
    expect(loFixtures[0]).toMatchObject({ number: 'LO-NEW-J-1' });
    expect(loFixtures[0].number_is_custom).toBeUndefined();

    // Label refresh: job_stages.job_number rewritten.
    expect(jobStageRows[0]).toMatchObject({ job_number: 'NEW-J' });
  });

  it('does NOT overwrite an already-set original_number on a second rename', async () => {
    const CUST_ID = 'cust-1';
    const customerRows = installTable(prisma.customer, [
      { id: CUST_ID, customer_number: 'SECOND-OLD', organization_id: ORG_ID, original_number: 'VERY-FIRST-EVER' },
    ]);
    installTable(prisma.estimate, []);
    installTable(prisma.logisticOrder, []);
    installAnchoredLoQueryRaw(prisma.$queryRaw as Mock, []);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyRenumber(prisma as any, 'customer', CUST_ID, ORG_ID, 'THIRD-NUMBER');

    expect(customerRows[0]).toMatchObject({
      customer_number: 'THIRD-NUMBER',
      original_number: 'VERY-FIRST-EVER', // unchanged — NOT overwritten with 'SECOND-OLD'
    });
  });
});
