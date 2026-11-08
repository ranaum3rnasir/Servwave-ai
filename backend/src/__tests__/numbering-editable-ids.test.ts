import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { Mock } from 'vitest';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ALPHA_ORG_ID } from './helpers';
import { maxNumberForTx } from '../controllers/organization.controller';

// Bypass the global numbering mock from setup.ts so these tests use the REAL allocator,
// same style as numbering.test.ts.
let allocateNumber: (typeof import('../lib/numbering'))['allocateNumber'];
let formatRecordNumber: (typeof import('../lib/numbering'))['formatRecordNumber'];
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
  allocateNumber = real.allocateNumber;
  formatRecordNumber = real.formatRecordNumber;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('allocateNumber — editable/custom-number skip path (in-scope entities)', () => {
  it('fast path: counter-derived candidate is already free — one extra query, unchanged number', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal UPDATE ... RETURNING: next_value=43 means allocated candidate is 42.
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'J', padding: 5 }])
      // Probe: nothing hand-typed occupies J00042.
      .mockResolvedValueOnce([{ taken: false }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J00042');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('candidate collides with a custom row — window skips to the next free number', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal: candidate is 42.
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'J', padding: 5 }])
      // Probe: J00042 is taken (a hand-typed row).
      .mockResolvedValueOnce([{ taken: true }])
      // Window: none of the following candidates are taken.
      .mockResolvedValueOnce([]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J00043');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('window returns the taken subset — the lowest free candidate wins', async () => {
    (prisma.$queryRaw as Mock)
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'J', padding: 5 }])
      .mockResolvedValueOnce([{ taken: true }])
      // J00043/J00044 are hand-typed too; J00045 is the first survivor. Returned unordered
      // on purpose — the caller picks by candidate order, not by row order.
      .mockResolvedValueOnce([{ n: 'J00044' }, { n: 'J00043' }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J00045');
  });

  it('fallback engages only when the whole window is exhausted', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal: candidate is 42.
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'J', padding: 5 }])
      // Probe: taken.
      .mockResolvedValueOnce([{ taken: true }])
      // Window: every one of the SKIP_WINDOW candidates is taken.
      .mockResolvedValueOnce(
        Array.from({ length: 1000 }, (_, i) => ({ n: `J${String(43 + i).padStart(5, '0')}` })),
      )
      // Fallback: full-table scan finds the true next-free value.
      .mockResolvedValueOnce([{ next_free: 1050 }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J01050');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // The defect that took Northwind Services' job creation down in production: the number the
  // allocator CHECKS and the number it RETURNS were rendered by two different formatters
  // (JS padStart vs SQL lpad, which truncates past the padding width) and silently disagreed
  // for any org whose series had outgrown number_padding. Assert they are the same string —
  // this holds for every padding/prefix shape, not just the one that broke.
  it('probes the exact string it returns, even when the number is wider than the padding', async () => {
    (prisma.$queryRaw as Mock)
      // Northwind Services' shape: empty prefix, padding 5, six-digit series.
      .mockResolvedValueOnce([{ next_value: 698855, prefix: '', padding: 5 }])
      .mockResolvedValueOnce([{ taken: false }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('698854');
    // Second call is the probe; its bound parameters must contain the returned string.
    const probeArgs = (prisma.$queryRaw as Mock).mock.calls[1];
    expect(probeArgs.slice(1)).toContain(result);
  });
});

describe('allocateNumber — out-of-scope entities are byte-identical to today (regression guard)', () => {
  // logistic_order and service_plan have NO number_is_custom column — referencing it in SQL
  // would be a Postgres error. Proving exactly ONE $queryRaw call (the self-heal UPDATE, same
  // as before this change) is the critical guard that these entities' create path is
  // untouched: any accidental widening of the skip path to them would show up here as a
  // second call.
  it('logistic_order: exactly one $queryRaw call (self-heal only), unchanged', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValueOnce([{ next_value: 4, prefix: 'LO', padding: 5 }]);

    const result = await allocateNumber(prisma, 'logistic_order', ALPHA_ORG_ID);

    expect(result).toBe('LO00003');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('service_plan: exactly one $queryRaw call (self-heal only), unchanged', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValueOnce([{ next_value: 8, prefix: 'SP', padding: 5 }]);

    const result = await allocateNumber(prisma, 'service_plan', ALPHA_ORG_ID);

    expect(result).toBe('SP00007');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('maxNumberForTx — excludeCustom parameter', () => {
  // $queryRaw's resolved value is mocked either way, so a black-box unit test cannot observe
  // the SQL text change from passing excludeCustom — that predicate's correctness is verified
  // by manual review, plus the pattern numbering.integration.test.ts already established
  // against a real DB for the rest of this file's SQL. TODO: extend
  // numbering.integration.test.ts to cover excludeCustom once the number_is_custom migration
  // PR is live against the real staging DB — it cannot be done in THIS PR (see file header).
  // These tests instead just prove the added parameter doesn't throw and both branches return
  // the mocked max, for both a default/omitted call and an explicit excludeCustom=true call.
  it('excludeCustom omitted (defaults false) does not throw and returns the mocked max', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ max_num: 41 }]) } as never;
    const result = await maxNumberForTx(tx, 'jobs', 'job_number', ALPHA_ORG_ID);
    expect(result).toBe(41);
  });

  it('excludeCustom=true does not throw and returns the mocked max', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ max_num: 41 }]) } as never;
    const result = await maxNumberForTx(tx, 'jobs', 'job_number', ALPHA_ORG_ID, true);
    expect(result).toBe(41);
  });
});

describe('allocateNumber — 9-digit numeric-length regression anchor', () => {
  // $queryRaw is mocked, so we cannot literally exercise Postgres' ::int cast (max
  // 2147483647) here. This is a regression ANCHOR proving a 9-digit value flows through
  // allocateNumber's own arithmetic/formatting cleanly (no exception, correct 9-digit
  // output) when self-heal/probe results simulate one — not a proof that Postgres
  // itself never overflows. The actual Postgres-side overflow guarantee is twofold: (1)
  // excluding custom rows from the self-heal/fallback casts, per the doc comment on
  // allocateNumber above, and (2) a 9-digit Zod cap on custom numeric ids at the API
  // validation layer (record-renumber.ts's MAX_NUMERIC_DIGITS).
  it('a 9-digit trailing value flows through self-heal + probe without throwing', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal: counter-derived candidate is 999999999 (9 digits).
      .mockResolvedValueOnce([{ next_value: 1000000000, prefix: 'J', padding: 5 }])
      // Probe: that exact candidate is free.
      .mockResolvedValueOnce([{ taken: false }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J999999999');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('formatRecordNumber — the single renderer for record numbers', () => {
  // Nothing else, in TypeScript or in SQL, may render a record number. These cases pin the
  // contract that the allocator's probe/window/fallback tiers all lean on.
  it('pads up to number_padding', () => {
    expect(formatRecordNumber('L', 5, 1)).toBe('L00001');
    expect(formatRecordNumber('BG-', 4, 1)).toBe('BG-0001');
  });

  it('renders WIDER than the padding rather than truncating', () => {
    // Postgres lpad('698854', 5, '0') is '69885'. This must not be.
    expect(formatRecordNumber('', 5, 698854)).toBe('698854');
    expect(formatRecordNumber('J', 5, 225092)).toBe('J225092');
  });

  it('handles an empty prefix and a zero padding', () => {
    expect(formatRecordNumber('', 0, 42)).toBe('42');
  });
});
