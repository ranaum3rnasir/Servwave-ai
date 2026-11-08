import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The global setup.ts mocks '../lib/numbering'. Bypass it here so we exercise the REAL
// allocators (numbering-purchase-order.test.ts precedent).
type NumberingModule = typeof import('../lib/numbering');
let numbering: NumberingModule;

beforeAll(async () => {
  numbering = await vi.importActual<NumberingModule>('../lib/numbering');
});

const ORG = '00000000-0000-0000-0000-0000000000a1';
const JOB_A = '00000000-0000-0000-0000-0000000000a2';
const JOB_B = '00000000-0000-0000-0000-0000000000a3';
const CUST_A = '00000000-0000-0000-0000-0000000000a4';

// ─────────────────────────────────────────────────────────────────────────────
// Tiny Postgres emulator for the two statements the allocators emit.
//
// The purchase-order/service-plan numbering tests stub `$queryRaw` with a canned
// row, which proves only the TS formatting and is blind to what the SQL actually
// says — a self-heal exclusion would be invisible to that shape (cf.
// learning-jsdom-test-can-be-a-placebo). So instead of canning the answer we
// render the emitted SQL and EVALUATE it against in-memory rows, exactly as
// Postgres would: a predicate only takes effect if the allocator really emits it.
// Delete a filter from numbering.ts and these tests go red.
//
// The emulator is deliberately FAITHFUL, not permissive:
//   * it projects `anchor_number` only if the SELECT list actually names it, and
//     only if the column named is the one that really exists on that table;
//   * it applies the `number LIKE` sequence-domain filter only if emitted;
//   * it applies the NULL-seq `substring` fallback only if emitted.
// ─────────────────────────────────────────────────────────────────────────────

/** Anchor FK column -> id, so one document row can carry SEVERAL anchors at once. */
type DocRow = { number: string; seq: number | null; anchors?: Record<string, string> };
type OrgState = { next: number; prefix: string; padding: number };
type AnchorRow = { table: string; id: string; number: string };

interface FakeState {
  org: OrgState;
  rows: DocRow[];
  /** Anchor rows that exist and belong to ORG — the row-lock target. */
  anchors: AnchorRow[];
}

/** The REAL number column on each anchor table (verified against schema.prisma). */
const ANCHOR_NUMBER_COL: Record<string, string> = {
  jobs: 'job_number',
  invoices: 'invoice_number',
  estimates: 'estimate_number',
  leads: 'lead_number',
  customers: 'customer_number',
  service_plans: 'service_plan_number',
};

/** Rebuild the SQL text a tagged-template call produced, and collect bound params. */
function render(strings: readonly string[], values: readonly unknown[]) {
  const params: unknown[] = [];
  let sql = strings[0];
  values.forEach((value, i) => {
    // Prisma.Sql (Prisma.raw / Prisma.empty) carries a `strings` array and is
    // spliced into the statement text, not bound.
    if (value && typeof value === 'object' && Array.isArray((value as { strings?: unknown }).strings)) {
      sql += (value as { strings: string[] }).strings.join('');
    } else {
      params.push(value);
      sql += '$P';
    }
    sql += strings[i + 1];
  });
  return { sql, params };
}

/** COALESCE(MAX((substring(col FROM '[0-9]+$'))::int), 0) */
function maxTrailingInt(rows: DocRow[]): number {
  let max = 0;
  for (const row of rows) {
    const match = /[0-9]+$/.exec(row.number);
    if (match) max = Math.max(max, parseInt(match[0], 10));
  }
  return max;
}

/** Evaluate a SQL LIKE pattern (backslash = default escape char) against a value. */
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

function makeFakeTx(state: FakeState) {
  const sqlLog: string[] = [];

  const $queryRaw = vi.fn((strings: readonly string[], ...values: unknown[]) => {
    const { sql, params } = render(strings, values);
    sqlLog.push(sql);
    const flat = sql.replace(/\s+/g, ' ').trim();

    // ── allocateNumber: UPDATE organizations … RETURNING ──────────────────────
    if (/^UPDATE organizations/i.test(flat)) {
      if (params[0] !== ORG) return Promise.resolve([]); // org not found
      // The self-heal subquery excludes anchored rows only if the SQL says so.
      // Both the seq discriminator and the legacy string heuristic are honoured,
      // so a regression fails on the NUMBER it produces, not on emulator drift.
      let visible = state.rows;
      if (/t\.seq IS NULL/i.test(flat)) {
        visible = state.rows.filter((r) => r.seq === null || r.seq === undefined);
      } else if (/NOT LIKE '%-%'/.test(flat)) {
        visible = state.rows.filter((r) => !r.number.includes('-'));
      }
      const healed = Math.max(state.org.next, maxTrailingInt(visible) + 1);
      state.org.next = healed + 1; // post-increment, exactly like the real statement
      return Promise.resolve([
        { next_value: state.org.next, prefix: state.org.prefix, padding: state.org.padding },
      ]);
    }

    // ── allocateNumber: custom-number probe + window skip ─────────────────────
    // (`supportsCustomNumbers` entities only — see numbering-editable-ids.test.ts for the
    // dedicated skip-logic coverage; these handlers just let 'job'/'customer' etc. flow
    // through THIS file's self-heal-focused tests without throwing "unexpected SQL".)
    //
    // Both handlers take the candidate STRINGS the allocator bound as parameters and answer
    // purely by set membership. They deliberately do NOT re-render a number from a numeric
    // parameter: the previous emulator did (with padStart), which quietly disagreed with the
    // Postgres `lpad` the real statement used and made a production-breaking truncation bug
    // invisible to every mocked test. An emulator must never re-derive a value the real
    // statement receives ready-made.
    if (/^SELECT EXISTS/i.test(flat) && /AS taken/i.test(flat)) {
      const [orgId, candidate] = params as [string, string];
      if (orgId !== ORG) return Promise.resolve([{ taken: false }]);
      return Promise.resolve([{ taken: state.rows.some((r) => r.number === candidate) }]);
    }
    if (/= ANY\(\$P::text\[\]\)/i.test(flat)) {
      const [orgId, window] = params as [string, string[]];
      if (orgId !== ORG) return Promise.resolve([]);
      const taken = new Set(state.rows.map((r) => r.number));
      return Promise.resolve(window.filter((n) => taken.has(n)).map((n) => ({ n })));
    }

    // ── allocateNumber: custom-number fallback (full-table scan) ──────────────
    if (/^SELECT COALESCE\(MAX/i.test(flat) && /AS next_free/i.test(flat)) {
      return Promise.resolve([{ next_free: maxTrailingInt(state.rows) + 1 }]);
    }

    // ── allocateAnchoredNumber step 1: row lock on the anchor row ─────────────
    if (/FOR (NO KEY )?UPDATE/i.test(flat)) {
      const table = /FROM (\w+)/i.exec(flat)?.[1] ?? '';
      const [anchorId, orgId] = params as [string, string];
      const hit = state.anchors.find((a) => a.table === table && a.id === anchorId);
      if (!hit || orgId !== ORG) return Promise.resolve([]);

      const row: Record<string, string> = { id: anchorId };
      const projected = /SELECT id, (\w+) AS anchor_number/i.exec(flat);
      if (projected) {
        // Postgres would reject a column that does not exist on this table.
        if (projected[1] !== ANCHOR_NUMBER_COL[table]) {
          throw new Error(`column "${projected[1]}" does not exist on relation "${table}"`);
        }
        row.anchor_number = hit.number;
      }
      return Promise.resolve([row]);
    }

    // ── allocateAnchoredNumber step 2: next per-anchor seq ────────────────────
    if (/MAX\(seq\)/i.test(flat)) {
      const anchorColumn = /AND (\w+) = \$P/i.exec(flat)?.[1] ?? '';
      const [orgId, anchorId, pattern] = params as [string, string, string | undefined];

      let mine = state.rows.filter((r) => orgId === ORG && r.anchors?.[anchorColumn] === anchorId);
      // Sequence-domain narrowing to the rows this anchor actually SHAPED.
      if (/AND number LIKE \$P/i.test(flat)) {
        mine = mine.filter((r) => likeMatch(r.number, pattern ?? ''));
      }

      const maxSeq = mine.reduce((acc, r) => Math.max(acc, r.seq ?? 0), 0);
      // NULL-seq self-heal: only if the statement really falls back to the number.
      const fallsBack = /substring\(number FROM '\[0-9\]\+\$'\)/i.test(flat);
      const next = Math.max(maxSeq, fallsBack ? maxTrailingInt(mine) : 0) + 1;
      return Promise.resolve([{ next_seq: next }]);
    }

    throw new Error(`Fake tx received unexpected SQL: ${flat}`);
  });

  return { tx: { $queryRaw } as never, sqlLog, state };
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    org: { next: 1, prefix: 'LO', padding: 5 },
    rows: [],
    anchors: [
      { table: 'jobs', id: JOB_A, number: 'J00042' },
      { table: 'jobs', id: JOB_B, number: 'J00099' },
      { table: 'customers', id: CUST_A, number: 'C00007' },
    ],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('allocateNumber — logistic_order (flat)', () => {
  it('allocates LO00001 then LO00002', async () => {
    const { tx, state } = makeFakeTx(freshState());

    const first = await numbering.allocateNumber(tx, 'logistic_order', ORG);
    state.rows.push({ number: first, seq: null });
    const second = await numbering.allocateNumber(tx, 'logistic_order', ORG);

    expect(first).toBe('LO00001');
    expect(second).toBe('LO00002');
  });

  it('throws when the organization does not exist', async () => {
    const { tx } = makeFakeTx(freshState());
    await expect(
      numbering.allocateNumber(tx, 'logistic_order', '99999999-9999-9999-9999-999999999999'),
    ).rejects.toThrow(/not found/);
  });

  it('self-heal EXCLUDES anchored rows: LO-J00001-7 must not bump the flat counter', async () => {
    // Counter has drifted behind reality (shared staging DB). Flat max is LO00003,
    // so the next flat number is LO00004. The anchored row's trailing `7` is a
    // per-anchor seq, NOT a document number — if it leaks into the self-heal MAX
    // the allocator jumps to LO00008.
    const state = freshState({
      org: { next: 1, prefix: 'LO', padding: 5 },
      rows: [
        { number: 'LO00001', seq: null },
        { number: 'LO00002', seq: null },
        { number: 'LO00003', seq: null },
        { number: 'LO-J00001-7', seq: 7, anchors: { job_id: JOB_A } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const next = await numbering.allocateNumber(tx, 'logistic_order', ORG);

    expect(next).toBe('LO00004');
    expect(next).not.toBe('LO00008');
  });

  it('self-heal still fires when the org prefix itself contains a hyphen (prefix "LO-")', async () => {
    // FINDING 3. PREFIX_REGEX (organization.controller.ts:25) is /^[A-Za-z0-9-]{1,10}$/,
    // so 'LO-' is a legal prefix and every FLAT number then renders 'LO-00001' —
    // which matches the old `number NOT LIKE '%-%'` heuristic and gets excluded from
    // the self-heal, silently turning it into a no-op and re-opening the exact drift
    // failure it exists to prevent. `seq IS NULL` is the schema's own discriminator.
    const state = freshState({
      org: { next: 1, prefix: 'LO-', padding: 5 },
      rows: [
        { number: 'LO-00001', seq: null },
        { number: 'LO-00002', seq: null },
        { number: 'LO-00003', seq: null },
        { number: 'LO-J00001-7', seq: 7, anchors: { job_id: JOB_A } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const next = await numbering.allocateNumber(tx, 'logistic_order', ORG);

    expect(next).toBe('LO-00004');
    // The two ways this can go wrong: heuristic excludes everything (no-op self-heal,
    // hands back an already-used number), or it excludes nothing (anchored seq leaks).
    expect(next).not.toBe('LO-00001');
    expect(next).not.toBe('LO-00008');
  });

  it('discriminates anchored rows by seq, not by a hyphen in the number', async () => {
    const lo = makeFakeTx(freshState());
    await numbering.allocateNumber(lo.tx, 'logistic_order', ORG);
    expect(lo.sqlLog[0]).toMatch(/t\.seq IS NULL/);
    expect(lo.sqlLog[0]).not.toMatch(/NOT LIKE/);

    const job = makeFakeTx(freshState({ org: { next: 1, prefix: 'J', padding: 5 } }));
    await numbering.allocateNumber(job.tx, 'job', ORG);
    expect(job.sqlLog[0]).not.toMatch(/seq IS NULL/);
  });
});

describe('allocateAnchoredNumber', () => {
  const anchoredInput = (anchorId: string, anchorNumber?: string) => ({
    organizationId: ORG,
    anchorTable: 'jobs' as const,
    anchorColumn: 'job_id' as const,
    anchorId,
    ...(anchorNumber === undefined ? {} : { anchorNumber }),
  });

  it('sequences 1 → 2 → 3 on a single anchor', async () => {
    const state = freshState();
    const { tx } = makeFakeTx(state);

    const results = [];
    for (let i = 0; i < 3; i++) {
      const allocated = await numbering.allocateAnchoredNumber(tx, anchoredInput(JOB_A, 'J00042'));
      state.rows.push({
        number: allocated.number,
        seq: allocated.seq,
        anchors: { job_id: JOB_A },
      });
      results.push(allocated);
    }

    expect(results.map((r) => r.number)).toEqual(['LO-J00042-1', 'LO-J00042-2', 'LO-J00042-3']);
    expect(results.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('locks the anchor row FOR NO KEY UPDATE (not FOR UPDATE) before reading MAX(seq)', async () => {
    // FINDING 1. FOR UPDATE conflicts with FOR KEY SHARE, which Postgres takes on a
    // referenced row for ANY insert carrying an FK to it. jobs is the hottest row in
    // the system and job is the default anchor, so FOR UPDATE would block every
    // concurrent job_line_item / task / attachment / note / invoice / stock_movement
    // insert against that job — plus any `UPDATE jobs SET status` — for the whole
    // create transaction. FOR NO KEY UPDATE still conflicts with ITSELF, so LO
    // allocators serialize exactly as intended, but it does not conflict with
    // FOR KEY SHARE. (The flat allocator gets this right implicitly: a plain
    // UPDATE organizations takes FOR NO KEY UPDATE.)
    const { tx, sqlLog } = makeFakeTx(freshState());
    await numbering.allocateAnchoredNumber(tx, anchoredInput(JOB_A, 'J00042'));

    expect(sqlLog).toHaveLength(2);
    const lock = sqlLog[0].replace(/\s+/g, ' ');
    expect(lock).toMatch(/FROM jobs WHERE id = \$P::uuid AND organization_id = \$P::uuid FOR NO KEY UPDATE/);
    expect(lock).not.toMatch(/(?<!NO KEY )FOR UPDATE/);
    expect(sqlLog[1]).toMatch(/MAX\(seq\)/);
  });

  it('gives each anchor its own sequence starting at 1', async () => {
    const state = freshState();
    const { tx } = makeFakeTx(state);

    const push = async (jobId: string, jobNumber: string) => {
      const allocated = await numbering.allocateAnchoredNumber(tx, anchoredInput(jobId, jobNumber));
      state.rows.push({
        number: allocated.number,
        seq: allocated.seq,
        anchors: { job_id: jobId },
      });
      return allocated.number;
    };

    expect(await push(JOB_A, 'J00042')).toBe('LO-J00042-1');
    expect(await push(JOB_B, 'J00099')).toBe('LO-J00099-1');
    expect(await push(JOB_A, 'J00042')).toBe('LO-J00042-2');
    expect(await push(JOB_B, 'J00099')).toBe('LO-J00099-2');
  });

  it('persists seq as an int so 10 sorts after 9 (string sort would not)', async () => {
    const state = freshState();
    const { tx } = makeFakeTx(state);

    for (let i = 0; i < 10; i++) {
      const allocated = await numbering.allocateAnchoredNumber(tx, anchoredInput(JOB_A, 'J00042'));
      expect(Number.isInteger(allocated.seq)).toBe(true);
      state.rows.push({
        number: allocated.number,
        seq: allocated.seq,
        anchors: { job_id: JOB_A },
      });
    }

    const numbers = state.rows.map((r) => r.number);
    expect(numbers[8]).toBe('LO-J00042-9');
    expect(numbers[9]).toBe('LO-J00042-10');

    // Numeric ordering by the persisted int column: 10 is last.
    const bySeq = [...state.rows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    expect(bySeq.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bySeq[bySeq.length - 1].number).toBe('LO-J00042-10');

    // ...which is precisely what sorting the number STRINGS would get wrong.
    const byString = [...numbers].sort();
    expect(byString[byString.length - 1]).not.toBe('LO-J00042-10');
  });

  it('takes a document prefix so estimate renumbering can reuse it', async () => {
    const { tx } = makeFakeTx(freshState());
    const allocated = await numbering.allocateAnchoredNumber(tx, {
      ...anchoredInput(JOB_A, 'J00042'),
      documentPrefix: 'E',
    });
    expect(allocated.number).toBe('E-J00042-1');
  });

  it('throws when the anchor row is missing or belongs to another org', async () => {
    const { tx } = makeFakeTx(freshState({ anchors: [] }));
    await expect(
      numbering.allocateAnchoredNumber(tx, anchoredInput(JOB_A, 'J00042')),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects identifiers outside the closed allowlist (injection guard)', async () => {
    const { tx } = makeFakeTx(freshState());
    await expect(
      numbering.allocateAnchoredNumber(tx, {
        ...anchoredInput(JOB_A, 'J00042'),
        anchorTable: 'jobs; DROP TABLE organizations' as never,
      }),
    ).rejects.toThrow(/allowlist/i);
    await expect(
      numbering.allocateAnchoredNumber(tx, {
        ...anchoredInput(JOB_A, 'J00042'),
        anchorColumn: 'job_id) OR 1=1 --' as never,
      }),
    ).rejects.toThrow(/allowlist/i);
  });

  it('rejects an allowlisted table paired with another anchor\'s column', async () => {
    const { tx } = makeFakeTx(freshState());
    await expect(
      numbering.allocateAnchoredNumber(tx, {
        ...anchoredInput(JOB_A, 'J00042'),
        anchorColumn: 'customer_id' as never,
      }),
    ).rejects.toThrow(/does not belong/i);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FINDING 2 — a NULL seq must not re-mint an already-used number
  // ───────────────────────────────────────────────────────────────────────────

  it('does not re-mint an existing number when an anchored row has a NULL seq', async () => {
    // `seq` is nullable with no CHECK, so ONE anchored row with seq=NULL (backfill,
    // import, hand-edit on the shared staging DB, or a future write path that forgets
    // to persist seq) makes COALESCE(MAX(seq),0)+1 compute 1 forever — every retry
    // produces the same already-used number, so the anchor becomes permanently
    // un-creatable. The flat allocator has an elaborate GREATEST self-heal for
    // exactly this reason; the anchored one needs the same resilience.
    const state = freshState({
      rows: [{ number: 'LO-J00042-1', seq: null, anchors: { job_id: JOB_A } }],
    });
    const { tx } = makeFakeTx(state);

    const allocated = await numbering.allocateAnchoredNumber(tx, anchoredInput(JOB_A, 'J00042'));

    expect(allocated.number).toBe('LO-J00042-2');
    expect(allocated.seq).toBe(2);
  });

  it('heals past a NULL-seq gap using the highest trailing number in the series', async () => {
    const state = freshState({
      rows: [
        { number: 'LO-J00042-1', seq: 1, anchors: { job_id: JOB_A } },
        { number: 'LO-J00042-2', seq: null, anchors: { job_id: JOB_A } },
        { number: 'LO-J00042-3', seq: null, anchors: { job_id: JOB_A } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const allocated = await numbering.allocateAnchoredNumber(tx, anchoredInput(JOB_A, 'J00042'));

    expect(allocated.number).toBe('LO-J00042-4');
    expect(allocated.seq).toBe(4);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FINDING 4 — multi-anchor documents must not corrupt a sibling anchor's series
  // ───────────────────────────────────────────────────────────────────────────

  it("a job-anchored LO that also links a customer does not advance the CUSTOMER series", async () => {
    // The spec supports multi-anchor LOs: the precedence winner shapes the number,
    // "the rest stay plain links". So LO-J00042-1 carries customer_id=C. Scoping
    // MAX(seq) by the FK column ALONE then makes the first-ever customer-anchored LO
    // on C mint LO-C00007-2 — the customer's first document is numbered -2 and -1
    // never exists. It can never collide, so the unique index never surfaces it: it
    // fails silently and is user-visible as missing document numbers.
    const state = freshState({
      rows: [
        { number: 'LO-J00042-1', seq: 1, anchors: { job_id: JOB_A, customer_id: CUST_A } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const allocated = await numbering.allocateAnchoredNumber(tx, {
      organizationId: ORG,
      anchorTable: 'customers',
      anchorColumn: 'customer_id',
      anchorId: CUST_A,
      anchorNumber: 'C00007',
    });

    expect(allocated.number).toBe('LO-C00007-1');
    expect(allocated.seq).toBe(1);
  });

  it('keeps the job series intact alongside the customer series on the same rows', async () => {
    const state = freshState({
      rows: [
        { number: 'LO-J00042-1', seq: 1, anchors: { job_id: JOB_A, customer_id: CUST_A } },
        { number: 'LO-C00007-1', seq: 1, anchors: { customer_id: CUST_A } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const job = await numbering.allocateAnchoredNumber(tx, anchoredInput(JOB_A, 'J00042'));
    expect(job.number).toBe('LO-J00042-2');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FINDING 5 — the minted string must come from the LOCKED row
  // ───────────────────────────────────────────────────────────────────────────

  it('builds the number from the locked anchor row, not from caller input', async () => {
    // The lock and the sequence domain key off anchorId; if the minted string were
    // built from a caller-supplied anchorNumber, two transactions holding locks on
    // DIFFERENT rows could both mint LO-J00042-n from disjoint sequence domains —
    // a genuine duplicate. The lock SELECT already reads the anchor row.
    const { tx, sqlLog } = makeFakeTx(freshState());

    const allocated = await numbering.allocateAnchoredNumber(tx, {
      organizationId: ORG,
      anchorTable: 'jobs',
      anchorColumn: 'job_id',
      anchorId: JOB_B, // JOB_B is J00099
    });

    expect(allocated.number).toBe('LO-J00099-1');
    expect(sqlLog[0]).toMatch(/SELECT id, job_number AS anchor_number/);
  });

  it('throws when a caller-supplied anchorNumber disagrees with the locked row', async () => {
    const { tx } = makeFakeTx(freshState());

    await expect(
      numbering.allocateAnchoredNumber(tx, {
        organizationId: ORG,
        anchorTable: 'jobs',
        anchorColumn: 'job_id',
        anchorId: JOB_A, // really J00042
        anchorNumber: 'J00099', // stale cache / wrong lookup / copy-convert path
      }),
    ).rejects.toThrow(/mismatch/i);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // escapeLikeLiteral — the sequence-domain pattern is a LIKE, not an equality
  //
  // A reviewer proved that deleting escapeLikeLiteral entirely leaves every other
  // test in this file green: no existing fixture uses an anchor number containing
  // a LIKE metacharacter, so the escaping is correct but UNPINNED. These two tests
  // pin it. Anchor numbers are NOT constrained by PREFIX_REGEX — they are read off
  // whatever is in the anchor row, and imported/backfilled orgs (Workiz) carry
  // arbitrary legacy strings, so `%`, `_` and `\` are reachable in production data.
  // ───────────────────────────────────────────────────────────────────────────

  const CUST_META = '00000000-0000-0000-0000-0000000000c1';

  it('escapes % and _ in the anchor number so the sequence domain does not OVER-match', async () => {
    // Customer number `C_1%` — `_` is LIKE's single-char wildcard and `%` its
    // multi-char one. Unescaped, the pattern `LO-C_1%-%` also matches the
    // job-shaped `LO-C11X-7` that merely LINKS this customer, so MAX(seq) reads 7
    // and this customer's FIRST logistic order is minted `-8`: the user-visible
    // "my numbers start at 8 and 1-7 don't exist" failure that FINDING 4 fixed for
    // FK scoping, re-opened by another route.
    const state = freshState({
      anchors: [
        { table: 'jobs', id: JOB_A, number: 'C11X' },
        { table: 'customers', id: CUST_META, number: 'C_1%' },
      ],
      rows: [
        { number: 'LO-C_1%-1', seq: 1, anchors: { customer_id: CUST_META } },
        { number: 'LO-C11X-7', seq: 7, anchors: { job_id: JOB_A, customer_id: CUST_META } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const allocated = await numbering.allocateAnchoredNumber(tx, {
      organizationId: ORG,
      anchorTable: 'customers',
      anchorColumn: 'customer_id',
      anchorId: CUST_META,
    });

    expect(allocated.number).toBe('LO-C_1%-2');
    expect(allocated.seq).toBe(2);
    // The unescaped outcome: the sibling series leaks in and the seq jumps.
    expect(allocated.seq).not.toBe(8);
  });

  it('escapes a backslash in the anchor number so the domain does not UNDER-match', async () => {
    // `\` is LIKE's default escape character, so an unescaped `C\1` yields the
    // pattern `LO-C\1-%` in which `\1` means "a literal 1" — the series' OWN rows
    // stop matching, MAX collapses to 0, and the allocator re-mints `LO-C\1-1`
    // forever, tripping @@unique([organization_id, number]) on every create.
    const state = freshState({
      anchors: [{ table: 'customers', id: CUST_META, number: 'C\\1' }],
      rows: [
        { number: 'LO-C\\1-1', seq: 1, anchors: { customer_id: CUST_META } },
        { number: 'LO-C\\1-2', seq: 2, anchors: { customer_id: CUST_META } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const allocated = await numbering.allocateAnchoredNumber(tx, {
      organizationId: ORG,
      anchorTable: 'customers',
      anchorColumn: 'customer_id',
      anchorId: CUST_META,
    });

    expect(allocated.number).toBe('LO-C\\1-3');
    expect(allocated.seq).toBe(3);
    // The unescaped outcome: nothing matches, seq restarts at 1, duplicate number.
    expect(allocated.seq).not.toBe(1);
  });

  it('reads the correct number column for every anchor kind', async () => {
    // Guards the ANCHORS allowlist against a guessed column name: the emulator
    // rejects any column that does not really exist on that table.
    for (const kind of numbering.ANCHOR_PRECEDENCE) {
      const { table, column } = numbering.ANCHORS[kind];
      const anchorId = '00000000-0000-0000-0000-0000000000b1';
      const { tx } = makeFakeTx(
        freshState({ anchors: [{ table, id: anchorId, number: 'X00001' }] }),
      );

      const allocated = await numbering.allocateAnchoredNumber(tx, {
        organizationId: ORG,
        anchorTable: table,
        anchorColumn: column,
        anchorId,
      });
      expect(allocated.number).toBe('LO-X00001-1');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK C — attach-later re-link: a FLAT LO that gains an anchor FK afterwards
//
// Spec §4 (line 61): the number is stamped at creation and is immutable —
// "re-linking later never renumbers". Spec §11 amendment 5 (line 145) defers the
// re-link UI but ships the schema links. So this row shape is reachable and legal:
//   number 'LO00042', seq NULL (flat — that is how it was NUMBERED),
//   job_id set        (anchored — that is what it LINKS to now).
//
// SCOPE NOTE, so nobody mistakes these for more than they are: the fake tx models
// the two SQL statements the allocators emit, NOT Postgres table constraints. These
// two tests therefore say nothing about whether a CHECK would have rejected the row
// — they pin what the ALLOCATORS do once it exists. The guard for the dropped CHECK
// itself is the migration-text test below.
// ─────────────────────────────────────────────────────────────────────────────

describe('re-linked flat LO (flat number + anchor FK)', () => {
  it('stays in the FLAT series: its number still feeds the flat self-heal', async () => {
    // The re-linked row's number is a flat one and occupies flat slot 1, so the flat
    // counter must keep counting it — `seq IS NULL` is what puts it there. The
    // sibling anchored row's trailing `7` is a per-anchor seq and must stay out.
    const state = freshState({
      org: { next: 1, prefix: 'LO', padding: 5 },
      rows: [
        { number: 'LO00001', seq: null, anchors: { job_id: JOB_A } }, // re-linked
        { number: 'LO-J00042-7', seq: 7, anchors: { job_id: JOB_A } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const next = await numbering.allocateNumber(tx, 'logistic_order', ORG);

    expect(next).toBe('LO00002');
    expect(next).not.toBe('LO00008'); // anchored seq leaked into the flat MAX
  });

  it('does NOT corrupt the anchor series it was re-linked into', async () => {
    // The row now carries job_id=JOB_A, so an FK-scoped MAX would see it. Its
    // trailing digits (42) are a FLAT document number, not a per-anchor seq — if
    // they reach the anchored allocator the job's next LO is numbered -43. The
    // `number LIKE 'LO-J00042-%'` sequence domain is what excludes it: the series is
    // the rows this anchor actually SHAPED, not merely the rows that link to it.
    const state = freshState({
      rows: [
        { number: 'LO00042', seq: null, anchors: { job_id: JOB_A } }, // re-linked
        { number: 'LO-J00042-2', seq: 2, anchors: { job_id: JOB_A } },
      ],
    });
    const { tx } = makeFakeTx(state);

    const allocated = await numbering.allocateAnchoredNumber(tx, {
      organizationId: ORG,
      anchorTable: 'jobs',
      anchorColumn: 'job_id',
      anchorId: JOB_A,
      anchorNumber: 'J00042',
    });

    expect(allocated.number).toBe('LO-J00042-3');
    expect(allocated.seq).toBe(3);
    expect(allocated.seq).not.toBe(43); // flat number's digits leaked into the series
  });
});

describe('logistic_orders migration — seq is not constrained against the anchor FKs', () => {
  // TASK C guard. This one IS about the migration: it reads the shipped SQL and
  // fails if a CHECK coupling `seq` to the anchor FKs comes back. Re-adding
  // `logistic_orders_anchored_seq_present` turns it red.
  //
  // Why it must not come back (full argument in the migration header): BOTH
  // directions of that coupling have legal counterexamples, so there is no invariant
  // to enforce. `anchor FK set => seq NOT NULL` breaks on the re-link case pinned
  // above (numbers are immutable, so seq stays NULL) — that write would 23514.
  // `seq NOT NULL => anchor FK set` breaks on an anchored LO whose anchor is deleted
  // (all six FKs are SET NULL, seq survives). `seq` describes how the NUMBER was
  // shaped; the FKs describe what the row links to. Independent axes.
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260720120000_logistic_orders_foundations/migration.sql',
  );

  const sql = readFileSync(MIGRATION, 'utf8');

  // Comments are stripped, and deliberately so: the migration EXPLAINS the dropped
  // constraint by name at length, and matching that prose would make this test
  // impossible to satisfy while keeping the reasoning. Only executable SQL counts.
  // (Safe here — this migration has no `--` inside a string literal.)
  const executableSql = sql.replace(/--[^\n]*/g, '');

  /**
   * Table CHECK constraint bodies. RLS policies are stripped first: their `WITH
   * CHECK (...)` clause is not a table constraint and legitimately names
   * organization_id, so leaving it in would scan prose it has no business scanning.
   */
  const checkBodies =
    executableSql
      .replace(/CREATE POLICY[\s\S]*?;/gi, '')
      .match(/CHECK\s*\([\s\S]*?\)\s*(?:NOT VALID)?\s*;/gi) ?? [];

  it('declares no CHECK referencing an anchor FK column', () => {
    const anchorColumns = [
      'job_id',
      'invoice_id',
      'estimate_id',
      'lead_id',
      'customer_id',
      'service_plan_id',
    ];
    for (const body of checkBodies) {
      for (const column of anchorColumns) {
        expect(
          body,
          `A CHECK on logistic_orders references "${column}". Anchor links and seq are ` +
            'independent axes — see the DELIBERATELY NO CHECK note in the migration.',
        ).not.toMatch(new RegExp(`"?${column}"?`));
      }
    }
  });

  it('no longer DECLARES the logistic_orders_anchored_seq_present constraint', () => {
    // Prose about it is expected and wanted; an ALTER TABLE adding it is not.
    expect(executableSql).not.toMatch(/logistic_orders_anchored_seq_present/);
    expect(sql).toMatch(/DELIBERATELY NO CHECK/); // the reasoning must survive
  });
});

describe('ANCHOR_PRECEDENCE / pickAnchor', () => {
  it('orders job > invoice > estimate > lead > customer > service_plan', () => {
    expect(numbering.ANCHOR_PRECEDENCE).toEqual([
      'job',
      'invoice',
      'estimate',
      'lead',
      'customer',
      'service_plan',
    ]);
  });

  it('picks the most specific anchor present', () => {
    const all = {
      job_id: 'job-1',
      invoice_id: 'inv-1',
      estimate_id: 'est-1',
      lead_id: 'lead-1',
      customer_id: 'cust-1',
      service_plan_id: 'plan-1',
    };
    expect(numbering.pickAnchor(all)).toMatchObject({ kind: 'job', id: 'job-1', table: 'jobs', column: 'job_id' });

    const { job_id: _job, ...noJob } = all;
    expect(numbering.pickAnchor(noJob)).toMatchObject({ kind: 'invoice', id: 'inv-1', column: 'invoice_id' });

    const { invoice_id: _inv, ...noInvoice } = noJob;
    expect(numbering.pickAnchor(noInvoice)).toMatchObject({ kind: 'estimate', id: 'est-1', column: 'estimate_id' });

    const { estimate_id: _est, ...noEstimate } = noInvoice;
    expect(numbering.pickAnchor(noEstimate)).toMatchObject({ kind: 'lead', id: 'lead-1', column: 'lead_id' });

    const { lead_id: _lead, ...noLead } = noEstimate;
    expect(numbering.pickAnchor(noLead)).toMatchObject({ kind: 'customer', id: 'cust-1', column: 'customer_id' });

    const { customer_id: _cust, ...planOnly } = noLead;
    expect(numbering.pickAnchor(planOnly)).toMatchObject({
      kind: 'service_plan',
      id: 'plan-1',
      table: 'service_plans',
      column: 'service_plan_id',
    });
  });

  it('returns null when there are no anchors (caller falls back to the flat allocator)', () => {
    expect(numbering.pickAnchor({})).toBeNull();
    expect(numbering.pickAnchor({ job_id: null, invoice_id: undefined, customer_id: '' })).toBeNull();
  });
});
