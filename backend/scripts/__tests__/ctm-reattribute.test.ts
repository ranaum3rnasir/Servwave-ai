import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getTenantContext, type TenantContext } from '../../src/lib/tenant-context';
import { reattributeOrg, BATCH_SIZE, type ReattributeDeps } from '../ctm-reattribute';

/**
 * Repair pass for forwarded-answer attribution (scripts/ctm-reattribute.ts).
 *
 * Attribution is decided ONCE, when the `end` webhook lands. If CTM was
 * unreachable in that moment the roster lookup misses, the call is recorded
 * unattributed, and nothing ever revisits it - the failure is permanent for
 * that row even though the information needed to fix it is still sitting in
 * CTM. That is the cost of ingest failing open, and this script is what pays
 * it back: it re-runs the SAME resolution over rows that came out unnamed.
 *
 * It is also the repair path for the ordinary case where the data caught up
 * later - a receiving number that gets named in CTM, or a user who finally
 * has their phone filled in, retroactively explains calls already on file.
 *
 * Everything is exercised through injected fakes - a script must NEVER touch
 * the real DB or CTM from tests (local .env points at shared staging).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG_ID = 'ab0e6f4e-0000-4000-8000-000000000042';
const ACCOUNT_ID = '500001';
const SAGIV_ID = 'b0000000-0000-0000-0000-00000000000b';

const DEFAULT_ORG = { id: ORG_ID, ctm_account_id: ACCOUNT_ID };

/** A stored call that was answered on a forwarded phone and never named. */
function unattributed(id: string, filterId = '3831356') {
  return {
    id,
    agent_id: null,
    answered_by: { kind: 'external', receiving_number_id: filterId },
  };
}

function makeDeps(
  rows: Array<Record<string, any>>,
  cfg: {
    org?: { id: string; ctm_account_id: string | null } | null;
    /** call id → what the resolver returns for it (undefined = unresolvable) */
    resolutions?: Record<string, { answeredBy: Record<string, any>; agentId: string | null }>;
    /** to_number → what the ASSIGNMENT fallback returns (undefined = nobody) */
    assignments?: Record<string, { answeredBy: Record<string, any>; agentId: string }>;
  } = {},
) {
  const contexts: Array<TenantContext | undefined> = [];
  const seen = () => {
    contexts.push(getTenantContext());
  };

  // Cursor-paged reads: hand back one batch, then nothing.
  let served = false;
  // The parameter is declared although the body ignores it: the paging assertion below reads
  // `mock.calls[1][0]`, and a `vi.fn(async () => ...)` types its own calls as the empty tuple.
  const findMany = vi.fn(async (_args: Record<string, unknown>) => {
    seen();
    if (served) return [];
    served = true;
    return rows;
  });

  const update = vi.fn(async () => {
    seen();
    return {};
  });

  const resolveExternalAnswerer = vi.fn(
    async (_db: unknown, _orgId: string, answeredBy: Record<string, any>) => {
      seen();
      const row = rows.find((r) => r.answered_by === answeredBy);
      if (row?.__boom) throw new Error('resolver exploded');
      return (row && cfg.resolutions?.[row.id]) ?? null;
    },
  );

  const resolveAssignedAnswerer = vi.fn(async (_db: unknown, _orgId: string, dialed: string) => {
    seen();
    return cfg.assignments?.[dialed] ?? null;
  });

  const warmReceivingNumbers = vi.fn(async () => {
    seen();
  });

  const prisma = {
    organization: {
      findUnique: vi.fn(async () => {
        seen();
        return cfg.org === undefined ? DEFAULT_ORG : cfg.org;
      }),
    },
    callSession: { findMany, update },
  } as unknown as PrismaClient;

  const deps: ReattributeDeps = {
    prisma,
    resolveExternalAnswerer: resolveExternalAnswerer as any,
    resolveAssignedAnswerer: resolveAssignedAnswerer as any,
    warmReceivingNumbers,
  };

  return {
    deps,
    prisma,
    findMany,
    update,
    resolveExternalAnswerer,
    resolveAssignedAnswerer,
    warmReceivingNumbers,
    contexts,
  };
}

describe('reattributeOrg', () => {
  it('falls back to the number assignee when nobody was observed picking up', async () => {
    // The path that actually resolves on the live account: no user has a phone
    // on file, so the roster match names nobody, and five of the staging rows
    // carry no receiving_number_id to match with in the first place (#1387).
    const row = { ...unattributed('cs-1'), to_number: '+16097191235' };
    const f = makeDeps([row], {
      assignments: {
        '+16097191235': {
          answeredBy: { kind: 'external', user_id: SAGIV_ID, resolved_from: 'assignment' },
          agentId: SAGIV_ID,
        },
      },
    });

    const counters = await reattributeOrg(f.deps, { orgId: ORG_ID });

    expect(f.update).toHaveBeenCalledWith({
      where: { id: 'cs-1' },
      data: {
        agent_id: SAGIV_ID,
        answered_by: { kind: 'external', user_id: SAGIV_ID, resolved_from: 'assignment' },
      },
    });
    expect(counters).toMatchObject({ scanned: 1, updated: 1, unchanged: 0 });
  });

  it('prefers the observed answerer over the assignee, and never asks for both', async () => {
    const row = { ...unattributed('cs-1'), to_number: '+16097191235' };
    const f = makeDeps([row], {
      resolutions: {
        'cs-1': {
          answeredBy: { kind: 'external', user_id: SAGIV_ID, name: 'Sagiv Peker' },
          agentId: SAGIV_ID,
        },
      },
      assignments: {
        '+16097191235': {
          answeredBy: { kind: 'external', user_id: 'someone-else', resolved_from: 'assignment' },
          agentId: 'someone-else',
        },
      },
    });

    await reattributeOrg(f.deps, { orgId: ORG_ID });

    expect(f.resolveAssignedAnswerer).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agent_id: SAGIV_ID }) }),
    );
  });

  it('leaves a row alone when neither resolver can name anyone', async () => {
    const row = { ...unattributed('cs-1'), to_number: '+16097191235' };
    const f = makeDeps([row]);

    const counters = await reattributeOrg(f.deps, { orgId: ORG_ID });

    expect(f.resolveAssignedAnswerer).toHaveBeenCalledWith(f.prisma, ORG_ID, '+16097191235');
    expect(f.update).not.toHaveBeenCalled();
    expect(counters).toMatchObject({ scanned: 1, updated: 0, unchanged: 1 });
  });

  it('fills in agent_id and answered_by for a call that now resolves', async () => {
    const row = unattributed('cs-1');
    const f = makeDeps([row], {
      resolutions: {
        'cs-1': {
          answeredBy: {
            kind: 'external',
            receiving_number_id: '3831356',
            user_id: SAGIV_ID,
            name: 'Sagiv Peker',
            email: 'sagiv@example.com',
          },
          agentId: SAGIV_ID,
        },
      },
    });

    const counters = await reattributeOrg(f.deps, { orgId: ORG_ID });

    expect(f.update).toHaveBeenCalledWith({
      where: { id: 'cs-1' },
      data: {
        agent_id: SAGIV_ID,
        answered_by: {
          kind: 'external',
          receiving_number_id: '3831356',
          user_id: SAGIV_ID,
          name: 'Sagiv Peker',
          email: 'sagiv@example.com',
        },
      },
    });
    expect(counters).toMatchObject({ scanned: 1, updated: 1, unchanged: 0, errors: 0 });
  });

  it('reuses the live ingest resolver rather than reimplementing the rule', async () => {
    const row = unattributed('cs-1');
    const f = makeDeps([row], {
      resolutions: { 'cs-1': { answeredBy: { kind: 'external' }, agentId: null } },
    });

    await reattributeOrg(f.deps, { orgId: ORG_ID });

    // A second copy of "how do we decide who answered" would drift from the
    // one webhooks use, and a repair pass that disagrees with live ingest is
    // worse than no repair pass at all.
    expect(f.resolveExternalAnswerer).toHaveBeenCalledWith(
      f.prisma,
      ORG_ID,
      row.answered_by,
      ACCOUNT_ID,
    );
  });

  it('leaves a row alone when it still cannot be resolved', async () => {
    const f = makeDeps([unattributed('cs-1')]);

    const counters = await reattributeOrg(f.deps, { orgId: ORG_ID });

    // The office line and any unnamed number stay unresolvable by design;
    // rewriting them with identical content would churn updated_at on every
    // run and make the counters lie about what the pass achieved.
    expect(f.update).not.toHaveBeenCalled();
    expect(counters).toMatchObject({ scanned: 1, updated: 0, unchanged: 1 });
  });

  it('writes nothing on a dry run but still reports what it would do', async () => {
    const f = makeDeps([unattributed('cs-1')], {
      resolutions: {
        'cs-1': { answeredBy: { kind: 'external', user_id: SAGIV_ID }, agentId: SAGIV_ID },
      },
    });

    const counters = await reattributeOrg(f.deps, { orgId: ORG_ID, dryRun: true });

    expect(f.update).not.toHaveBeenCalled();
    expect(counters).toMatchObject({ scanned: 1, updated: 1 });
  });

  it('only reads forwarded answers that are still missing an agent', async () => {
    const f = makeDeps([]);

    await reattributeOrg(f.deps, { orgId: ORG_ID });

    // Scoping matters twice over: a csr answer must never be second-guessed by
    // this pass, and scanning the whole call table on a busy org would be a
    // full scan to find a handful of rows.
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ORG_ID,
          agent_id: null,
          answered_by: { path: ['kind'], equals: 'external' },
        }),
      }),
    );
  });

  it('warms the CTM roster before resolving anything', async () => {
    const f = makeDeps([unattributed('cs-1')]);

    await reattributeOrg(f.deps, { orgId: ORG_ID });

    expect(f.warmReceivingNumbers).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(f.warmReceivingNumbers.mock.invocationCallOrder[0]).toBeLessThan(
      f.resolveExternalAnswerer.mock.invocationCallOrder[0],
    );
  });

  it('keeps going when one row fails', async () => {
    const bad = { ...unattributed('cs-bad'), __boom: true };
    const good = unattributed('cs-good');
    const f = makeDeps([bad, good], {
      resolutions: {
        'cs-good': { answeredBy: { kind: 'external', user_id: SAGIV_ID }, agentId: SAGIV_ID },
      },
    });

    const counters = await reattributeOrg(f.deps, { orgId: ORG_ID });

    // A repair pass that aborts halfway leaves the operator unsure how far it
    // got, which is worse than a counted failure.
    expect(counters).toMatchObject({ scanned: 2, updated: 1, errors: 1 });
  });

  it('refuses to run for an org that is not connected to CTM', async () => {
    const f = makeDeps([], { org: { id: ORG_ID, ctm_account_id: null } });

    await expect(reattributeOrg(f.deps, { orgId: ORG_ID })).rejects.toThrow(/not connected/i);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('refuses to run for an org that does not exist', async () => {
    const f = makeDeps([], { org: null });

    await expect(reattributeOrg(f.deps, { orgId: ORG_ID })).rejects.toThrow(/not found/i);
  });

  it('runs every query inside the target org tenant context', async () => {
    const f = makeDeps([unattributed('cs-1')], {
      resolutions: {
        'cs-1': { answeredBy: { kind: 'external', user_id: SAGIV_ID }, agentId: SAGIV_ID },
      },
    });

    await reattributeOrg(f.deps, { orgId: ORG_ID });

    // Without a tenant context the RLS guard fails closed, so a pass that
    // escaped it would silently repair nothing (or, worse, cross orgs).
    expect(f.contexts.length).toBeGreaterThan(0);
    for (const ctx of f.contexts) {
      expect(ctx?.orgId).toBe(ORG_ID);
    }
  });

  it('pages with a cursor so repaired rows cannot shift the window', async () => {
    // A full batch is what triggers a second page at all.
    const full = Array.from({ length: BATCH_SIZE }, (_, i) =>
      unattributed(`cs-${String(i).padStart(4, '0')}`),
    );
    const f = makeDeps(full);

    await reattributeOrg(f.deps, { orgId: ORG_ID });

    // Offset paging would be wrong here: fixing a row removes it from the
    // filtered set, so `skip` would step over the rows that moved up. Nor can
    // it re-fetch the first N, because the genuinely unresolvable rows never
    // leave the set and the loop would not terminate.
    const second = f.findMany.mock.calls[1][0];
    expect(second).toMatchObject({ cursor: { id: `cs-${String(BATCH_SIZE - 1).padStart(4, '0')}` }, skip: 1 });
  });

  it('stops after a short batch instead of paging for nothing', async () => {
    const f = makeDeps([unattributed('cs-1')]);

    await reattributeOrg(f.deps, { orgId: ORG_ID });

    // A batch smaller than the page size is the last one by definition.
    expect(f.findMany).toHaveBeenCalledTimes(1);
  });
});
