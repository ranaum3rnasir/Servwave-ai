import { describe, it, expect, vi, beforeAll } from 'vitest';

// The global setup.ts mocks '../lib/numbering'; bypass it so we exercise the REAL allocator
// (numbering-logistic-order.test.ts precedent).
type NumberingModule = typeof import('../lib/numbering');
let numbering: NumberingModule;
beforeAll(async () => {
  numbering = await vi.importActual<NumberingModule>('../lib/numbering');
});

const ORG = '00000000-0000-0000-0000-0000000000f1';
const LEAD = '00000000-0000-0000-0000-0000000000f2';
const CUSTOMER = '00000000-0000-0000-0000-0000000000f3';
const JOB = '00000000-0000-0000-0000-0000000000f4';

/**
 * Capture the SQL each `$queryRaw` tagged-template call renders + its bound params, and answer
 * them from a QUEUE of canned result sets (statement 1 = the counter UPDATE ... RETURNING,
 * statement 2 = the existing container-series rows the skip reads). `Prisma.raw`/`Prisma.empty`
 * fragments carry a `strings` array and are spliced into the text; everything else is a bound
 * param -> `$1`, `$2`. This proves what the SQL actually SAYS (e.g. that the organization_id
 * tenant filter is present), not just the formatting.
 */
function captureTx(...responses: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queue = [...responses];
  const render = (strings: readonly string[], values: unknown[]) => {
      const params: unknown[] = [];
      let sql = strings[0];
      values.forEach((value, i) => {
        if (value && typeof value === 'object' && Array.isArray((value as { strings?: unknown }).strings)) {
          sql += (value as { strings: string[] }).strings.join('');
        } else {
          params.push(value);
          sql += `$${params.length}`;
        }
        sql += strings[i + 1];
      });
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  };
  const tx = {
    $queryRaw: (strings: readonly string[], ...values: unknown[]) => {
      render(strings, values);
      return Promise.resolve(queue.shift() ?? []);
    },
    // The advisory lock is an $executeRaw (pg_advisory_xact_lock returns void). It is recorded in
    // the same ordered `calls` list, so the statement ORDER is assertable, but it consumes no
    // canned result set.
    $executeRaw: (strings: readonly string[], ...values: unknown[]) => {
      render(strings, values);
      return Promise.resolve(0);
    },
  };
  return { tx, calls };
}

/** The container row's RETURNING, plus an empty container series (nothing to skip). */
function freshContainer(seq: number, containerNumber: string) {
  return captureTx([{ seq, container_number: containerNumber }], []);
}

/** As above, but the container series already holds `existing`. */
function containerWith(
  seq: number,
  containerNumber: string,
  existing: Array<{ seq: bigint; is_custom: boolean }>,
) {
  return captureTx([{ seq, container_number: containerNumber }], existing);
}

describe('allocateContainerEstimateNumber', () => {
  it('formats <container_number>-<seq> from the RETURNING row', async () => {
    const { tx } = freshContainer(3, 'L00005');
    expect(await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG)).toEqual({
      estimate_number: 'L00005-3',
      container_kind: 'LEAD',
      container_seq: 3,
    });
  });

  it('emits a TENANT-SCOPED atomic increment on the lead table', async () => {
    const { tx, calls } = freshContainer(1, 'L00005');
    await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    const { sql, params } = calls[0];
    expect(sql).toMatch(/UPDATE leads/);
    expect(sql).toMatch(/SET estimate_seq = estimate_seq \+ 1/);
    // The organization_id predicate is the tenant guard - deleting it MUST fail this test.
    expect(sql).toMatch(/WHERE id = \$1::uuid AND organization_id = \$2::uuid/);
    expect(sql).toMatch(/RETURNING estimate_seq AS seq, lead_number AS container_number/);
    expect(params).toEqual([LEAD, ORG]);
  });

  it('targets customers.customer_number for a customer container', async () => {
    const { tx, calls } = freshContainer(10, 'C00010');
    const allocated = await numbering.allocateContainerEstimateNumber(tx as never, 'customer', CUSTOMER, ORG);
    expect(allocated.estimate_number).toBe('C00010-10');
    expect(allocated.container_kind).toBe('CUSTOMER');
    expect(calls[0].sql).toMatch(/UPDATE customers/);
    expect(calls[0].sql).toMatch(/RETURNING estimate_seq AS seq, customer_number AS container_number/);
  });

  it('targets jobs.job_number for a job container', async () => {
    const { tx, calls } = freshContainer(7, 'J00007');
    const allocated = await numbering.allocateContainerEstimateNumber(tx as never, 'job', JOB, ORG);
    expect(allocated.estimate_number).toBe('J00007-7');
    expect(allocated.container_kind).toBe('JOB');
    expect(calls[0].sql).toMatch(/UPDATE jobs/);
  });

  it('throws when the container row is missing / not in the org (empty RETURNING)', async () => {
    const { tx } = captureTx([]);
    await expect(
      numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG),
    ).rejects.toThrow(/not found in organization/);
  });

  // ── follow-up 2a: skip / self-heal ────────────────────────────────────────────────────────
  //
  // Numbers here are WIDER than a default `number_padding` of 5 on purpose. The pre-existing
  // custom-number cases in numbering.integration.test.ts used C00007/C00500 - numbers that FIT
  // the padding - and stayed green straight through the production outage in #1873. A fixture
  // that fits the padding cannot catch this class of bug.

  it('skips a hand-typed estimate sitting exactly where the container counter lands', async () => {
    // The proven prod repro: lead at estimate_seq = 2 (so the counter hands out 3) whose
    // container already holds a hand-typed `01287-3`. The old allocator returned `01287-3` and
    // the insert died with P2002 - and because the seq bump rolls back with the failed
    // transaction, every retry minted the identical number. Permanently pinned.
    const { tx } = containerWith(3, '699063', [{ seq: 3n, is_custom: true }]);
    const allocated = await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    expect(allocated.estimate_number).toBe('699063-4');
    expect(allocated.container_seq).toBe(4);
  });

  it('skips a RUN of taken numbers rather than failing the create', async () => {
    const { tx } = containerWith(3, '699063', [
      { seq: 3n, is_custom: true }, { seq: 4n, is_custom: true }, { seq: 5n, is_custom: true },
    ]);
    const allocated = await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    expect(allocated.estimate_number).toBe('699063-6');
  });

  it('self-heals a container counter that has drifted BEHIND its own issued estimates', async () => {
    // estimate_seq says 2, but the allocator itself already issued -4 (a restored row, a
    // cross-branch insert). Trusting the counter alone re-issues a taken number for ever.
    const { tx } = containerWith(2, '699063', [
      { seq: 3n, is_custom: false }, { seq: 4n, is_custom: false },
    ]);
    const allocated = await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    expect(allocated.estimate_number).toBe('699063-5');
  });

  it('does NOT drag the series up to a far-off hand-typed number (product rule 2)', async () => {
    // `699063-900` was hand-typed. The sequence must not re-base onto it: next is still 3.
    // It is still TAKEN, though - which is what the skip half of the algorithm is for, and why
    // the self-heal MAX and the skip read different row sets.
    const { tx } = containerWith(3, '699063', [{ seq: 900n, is_custom: true }]);
    const allocated = await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    expect(allocated.estimate_number).toBe('699063-3');
  });

  it('scopes the skip query to the org and to THIS container series, as a bound regex', async () => {
    const { tx, calls } = freshContainer(1, '699063');
    await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    expect(calls).toHaveLength(3);
    const { sql, params } = calls[2];
    expect(sql).toMatch(/FROM estimates/);
    expect(sql).toMatch(/WHERE organization_id = \$1::uuid/);
    expect(sql).toMatch(/AND estimate_number ~ \$2/);
    // Anchored full-string regex, so `699063-3-1` can never be misread as this series' seq 1.
    expect(params).toEqual([ORG, '^699063-[0-9]+$', 15]);
    // The candidate is never rendered in SQL - one formatter only (#1873).
    expect(sql).not.toMatch(/lpad/);
  });

  it('takes a transaction-scoped advisory lock on (org, container number) before reading', async () => {
    // The container-row lock is keyed on the ROW; uniqueness is keyed on the NUMBER, and a lead
    // and a job can both be numbered `555555`. Without this statement the two take different
    // locks, both derive from an empty taken set, and both mint `555555-1`.
    const { tx, calls } = freshContainer(1, '555555');
    await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    const lock = calls[1];
    expect(lock.sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\(\$1 \|\| ':' \|\| \$2, 0\)\)/);
    expect(lock.params).toEqual([ORG, '555555']);
    // It must precede the read it protects, and follow the UPDATE that reveals the number.
    expect(calls[0].sql).toMatch(/UPDATE leads/);
    expect(calls[2].sql).toMatch(/FROM estimates/);
  });

  it('escapes regex metacharacters in a hand-typed container number', async () => {
    const { tx, calls } = freshContainer(1, 'A+B.C');
    await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    expect(calls[2].params[1]).toBe('^A\\+B\\.C-[0-9]+$');
  });
});

describe('formatContainerEstimateNumber', () => {
  it('is the single renderer for a container estimate number', () => {
    expect(numbering.formatContainerEstimateNumber('699063', 4)).toBe('699063-4');
    // The seq is NOT padded - number_padding shapes the container's own number, not the suffix.
    expect(numbering.formatContainerEstimateNumber('L00005', 12)).toBe('L00005-12');
  });
});
