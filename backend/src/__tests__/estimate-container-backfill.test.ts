/**
 * Tests for the estimate-container backfill (editable record IDs foundation).
 *
 * Strategy mirrors numbering.test.ts: import { prisma } from '../lib/prisma' (the
 * global setup.ts mock — findMany/update are already vi.fn()) and drive it directly.
 * runWithOrg is the REAL implementation (AsyncLocalStorage) — it is not mocked
 * anywhere in setup.ts, so exercising it here just proves the backfill actually
 * runs its DB work inside that context; the mocked prisma calls don't care about
 * the tenant guard either way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  parseContainerNumber,
  classifyContainerEstimates,
  resolveRenamedContainers,
  renameKey,
  runEstimateContainerBackfillForOrg,
} from '../lib/estimate-container-backfill';

const ORG_A = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseContainerNumber', () => {
  it('parses a simple container number', () => {
    expect(parseContainerNumber('L00005-1')).toEqual({ base: 'L00005', seq: 1 });
  });

  it('parses a bare Workiz-imported parent number', () => {
    expect(parseContainerNumber('698159-3')).toEqual({ base: '698159', seq: 3 });
  });

  it('returns null for a flat legacy estimate number', () => {
    expect(parseContainerNumber('E00001')).toBeNull();
  });

  it('returns null for a bare number with no trailing suffix at all', () => {
    expect(parseContainerNumber('698470')).toBeNull();
  });

  it('matches on the LAST hyphen only when the base itself contains a hyphen', () => {
    expect(parseContainerNumber('LO-42-7')).toEqual({ base: 'LO-42', seq: 7 });
  });
});

describe('classifyContainerEstimates', () => {
  function maps(overrides: Partial<{ LEAD: [string, string][]; CUSTOMER: [string, string][]; JOB: [string, string][] }> = {}) {
    return {
      LEAD: new Map(overrides.LEAD ?? []),
      CUSTOMER: new Map(overrides.CUSTOMER ?? []),
      JOB: new Map(overrides.JOB ?? []),
    };
  }

  it('resolves a lead match as kind LEAD', () => {
    const result = classifyContainerEstimates(
      [{ id: 'est-1', estimate_number: 'L00005-1' }],
      maps({ LEAD: [['L00005', 'lead-1']] }),
    );
    expect(result.resolved).toEqual([{ id: 'est-1', base: 'L00005', seq: 1, kind: 'LEAD' }]);
    expect(result.unmatched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it('resolves a job match as kind JOB', () => {
    const result = classifyContainerEstimates(
      [{ id: 'est-2', estimate_number: 'J00007-2' }],
      maps({ JOB: [['J00007', 'job-1']] }),
    );
    expect(result.resolved).toEqual([{ id: 'est-2', base: 'J00007', seq: 2, kind: 'JOB' }]);
  });

  it('resolves a customer match as kind CUSTOMER', () => {
    const result = classifyContainerEstimates(
      [{ id: 'est-3', estimate_number: 'C00010-1' }],
      maps({ CUSTOMER: [['C00010', 'cust-1']] }),
    );
    expect(result.resolved).toEqual([{ id: 'est-3', base: 'C00010', seq: 1, kind: 'CUSTOMER' }]);
  });

  it('reports zero candidates as unmatched', () => {
    const result = classifyContainerEstimates(
      [{ id: 'est-4', estimate_number: '999999-1' }],
      maps(),
    );
    expect(result.unmatched).toEqual([{ id: 'est-4', estimateNumber: '999999-1' }]);
    expect(result.resolved).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it('reports candidates present in BOTH the LEAD and JOB maps as ambiguous, listing both', () => {
    const result = classifyContainerEstimates(
      [{ id: 'est-5', estimate_number: '12345-1' }],
      maps({ LEAD: [['12345', 'lead-9']], JOB: [['12345', 'job-9']] }),
    );
    expect(result.resolved).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        id: 'est-5',
        estimateNumber: '12345-1',
        candidates: [
          { kind: 'LEAD', id: 'lead-9' },
          { kind: 'JOB', id: 'job-9' },
        ],
      },
    ]);
  });

  it('classifies a realistic mixed batch into accurate aggregate counters (regression anchor)', () => {
    const estimates = [
      { id: 'e-lead-1', estimate_number: 'L00001-1' },
      { id: 'e-lead-2', estimate_number: 'L00002-1' },
      { id: 'e-lead-3', estimate_number: 'L00003-1' },
      { id: 'e-job-1', estimate_number: 'J00001-1' },
      { id: 'e-job-2', estimate_number: 'J00002-1' },
      { id: 'e-cust-1', estimate_number: 'C00001-1' },
      { id: 'e-unmatched-1', estimate_number: '404404-1' },
    ];
    const result = classifyContainerEstimates(
      estimates,
      maps({
        LEAD: [
          ['L00001', 'lead-1'],
          ['L00002', 'lead-2'],
          ['L00003', 'lead-3'],
        ],
        JOB: [
          ['J00001', 'job-1'],
          ['J00002', 'job-2'],
        ],
        CUSTOMER: [['C00001', 'cust-1']],
      }),
    );
    expect(result.resolved).toHaveLength(3 + 2 + 1);
    expect(result.resolved.filter((r) => r.kind === 'LEAD')).toHaveLength(3);
    expect(result.resolved.filter((r) => r.kind === 'JOB')).toHaveLength(2);
    expect(result.resolved.filter((r) => r.kind === 'CUSTOMER')).toHaveLength(1);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0].id).toBe('e-unmatched-1');
    expect(result.ambiguous).toHaveLength(0);
  });
});

describe('runEstimateContainerBackfillForOrg', () => {
  function mockOrgEstimates(
    rows: Array<{
      id: string;
      estimate_number: string;
      lead_id?: string | null;
      customer_id?: string | null;
      job_id?: string | null;
    }>,
  ) {
    (prisma.estimate.findMany as Mock).mockResolvedValue(rows);
  }
  function mockRenames(
    rows: Array<{ action: string; resource_id: string; metadata: Record<string, unknown> }> = [],
  ) {
    (prisma.auditLog.findMany as Mock).mockResolvedValue(rows);
  }
  function mockOrgParents(opts: {
    leads?: Array<{ id: string; lead_number: string }>;
    customers?: Array<{ id: string; customer_number: string }>;
    jobs?: Array<{ id: string; job_number: string }>;
  }) {
    (prisma.lead.findMany as Mock).mockResolvedValue(opts.leads ?? []);
    (prisma.customer.findMany as Mock).mockResolvedValue(opts.customers ?? []);
    (prisma.job.findMany as Mock).mockResolvedValue(opts.jobs ?? []);
  }

  it('dry-run classifies but never calls prisma.estimate.update', async () => {
    mockOrgEstimates([{ id: 'est-1', estimate_number: 'L00005-1' }]);
    mockOrgParents({ leads: [{ id: 'lead-1', lead_number: 'L00005' }] });

    const result = await runEstimateContainerBackfillForOrg(
      { prisma: prisma as any },
      { orgId: ORG_A, dryRun: true },
    );

    expect(prisma.estimate.update).not.toHaveBeenCalled();
    expect(result.counters).toEqual({
      scanned: 1, resolved: 1, recoveredByRename: 0, unmatched: 0, ambiguous: 0,
    });
  });

  it('a clean org (no ambiguity) writes container_kind/container_seq for every resolved row', async () => {
    mockOrgEstimates([
      { id: 'est-1', estimate_number: 'L00005-1' },
      { id: 'est-2', estimate_number: 'E00001' }, // flat — filtered out before classification
      { id: 'est-3', estimate_number: '999999-9' }, // unmatched
    ]);
    mockOrgParents({ leads: [{ id: 'lead-1', lead_number: 'L00005' }] });
    mockRenames();
    (prisma.estimate.update as Mock).mockResolvedValue({});

    const result = await runEstimateContainerBackfillForOrg(
      { prisma: prisma as any },
      { orgId: ORG_A },
    );

    expect(prisma.estimate.update).toHaveBeenCalledTimes(1);
    expect(prisma.estimate.update).toHaveBeenCalledWith({
      where: { id: 'est-1' },
      data: { container_kind: 'LEAD', container_seq: 1 },
    });
    expect(result.counters).toEqual({
      scanned: 2, resolved: 1, recoveredByRename: 0, unmatched: 1, ambiguous: 0,
    });
    expect(result.unmatched).toEqual([{ id: 'est-3', estimateNumber: '999999-9' }]);
  });

  it('an org with even ONE ambiguous row throws before any write, with the ambiguous id/number in the message', async () => {
    mockOrgEstimates([
      { id: 'est-1', estimate_number: 'L00005-1' }, // clean, would resolve
      { id: 'est-2', estimate_number: '12345-1' }, // ambiguous
    ]);
    mockOrgParents({
      leads: [
        { id: 'lead-1', lead_number: 'L00005' },
        { id: 'lead-2', lead_number: '12345' },
      ],
      jobs: [{ id: 'job-1', job_number: '12345' }],
    });

    await expect(
      runEstimateContainerBackfillForOrg({ prisma: prisma as any }, { orgId: ORG_A }),
    ).rejects.toThrow(/est-2|12345-1/);

    expect(prisma.estimate.update).not.toHaveBeenCalled();
  });
});

// ── Rename recovery (follow-up 2c) ───────────────────────────────────────────────────────────
//
// The first pass matches an estimate's number against the CURRENT parent numbers, so it cannot
// reach a row whose container has since been renamed — the very rows a container rename left
// behind. Measured on prod 2026-08-27: 10 of Northwind Services' 56 orphans, `699063-2` (lead now
// `01287`) among them.
describe('resolveRenamedContainers', () => {
  const fks = { lead_id: null, customer_id: null, job_id: null };

  it('recovers a row whose OWN lead was renumbered away from the base', () => {
    const renames = new Set([renameKey('lead.renumbered', 'lead-1', '699063')]);
    const { resolved, stillUnmatched } = resolveRenamedContainers(
      [{ id: 'est-1', estimate_number: '699063-2', ...fks, lead_id: 'lead-1', customer_id: 'cust-1' }],
      renames,
    );
    expect(resolved).toEqual([{ id: 'est-1', base: '699063', seq: 2, kind: 'LEAD' }]);
    expect(stillUnmatched).toHaveLength(0);
  });

  it('does NOT recover from a rename of a DIFFERENT record of the same kind', () => {
    // The audit fact must be about the estimate's own FK, not merely "some lead once held 699063".
    const renames = new Set([renameKey('lead.renumbered', 'lead-OTHER', '699063')]);
    const { resolved, stillUnmatched } = resolveRenamedContainers(
      [{ id: 'est-1', estimate_number: '699063-2', ...fks, lead_id: 'lead-1' }],
      renames,
    );
    expect(resolved).toHaveLength(0);
    expect(stillUnmatched).toEqual([{ id: 'est-1', estimateNumber: '699063-2' }]);
  });

  it('leaves a row alone when TWO of its own FKs both claim the base', () => {
    const renames = new Set([
      renameKey('lead.renumbered', 'lead-1', '699063'),
      renameKey('job.renumbered', 'job-1', '699063'),
    ]);
    const { resolved, stillUnmatched } = resolveRenamedContainers(
      [{ id: 'est-1', estimate_number: '699063-2', ...fks, lead_id: 'lead-1', job_id: 'job-1' }],
      renames,
    );
    expect(resolved).toHaveLength(0);
    expect(stillUnmatched).toHaveLength(1);
  });

  it('leaves a row alone when nothing in the audit trail matches', () => {
    const { resolved, stillUnmatched } = resolveRenamedContainers(
      [{ id: 'est-1', estimate_number: '698711-1', ...fks, customer_id: 'cust-1' }],
      new Set(),
    );
    expect(resolved).toHaveLength(0);
    expect(stillUnmatched).toHaveLength(1);
  });
});

describe('runEstimateContainerBackfillForOrg — rename recovery wiring', () => {
  function mockOrgParents2() {
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.customer.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
  }

  it('writes a row the number-derived pass could not match, and counts it separately', async () => {
    (prisma.estimate.findMany as Mock).mockResolvedValue([
      { id: 'est-1', estimate_number: '699063-2', lead_id: 'lead-1', customer_id: 'cust-1', job_id: null },
    ]);
    mockOrgParents2();
    (prisma.auditLog.findMany as Mock).mockResolvedValue([
      { action: 'lead.renumbered', resource_id: 'lead-1', metadata: { old_number: '699063', new_number: '01287' } },
    ]);
    (prisma.estimate.update as Mock).mockResolvedValue({});

    const result = await runEstimateContainerBackfillForOrg({ prisma: prisma as never }, { orgId: ORG_A });

    expect(prisma.estimate.update).toHaveBeenCalledWith({
      where: { id: 'est-1' },
      data: { container_kind: 'LEAD', container_seq: 2 },
    });
    expect(result.counters).toEqual({
      scanned: 1, resolved: 1, recoveredByRename: 1, unmatched: 0, ambiguous: 0,
    });
  });

  it('only scans rows that still lack container_kind', async () => {
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    mockOrgParents2();

    await runEstimateContainerBackfillForOrg({ prisma: prisma as never }, { orgId: ORG_A, dryRun: true });

    expect(prisma.estimate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: ORG_A, container_kind: null } }),
    );
    // No unmatched rows -> the audit-log read never happens.
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});
