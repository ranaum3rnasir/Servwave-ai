import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache, setCachedGrants } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { addOrFilter } from '../lib/permissions/whereCompose';

// ─────────────────────────────────────────────────────────────────────────────
// Issue 1 (harden) — a multi-read user's scope `OR` must NOT be silently clobbered
// when a list endpoint ALSO sets its own `OR` (text search). The B3-BUG-1 fix made
// scopeWhereFor return `{ OR: [...] }` for a user with 2+ distinct conditional reads
// (role read + override-implied read). Controllers spread that fragment into `where`,
// then later do `where.OR = [searchClauses]` — which silently drops the scope OR =
// a row-scope LEAK. These tests prove the scope OR survives when combined with a
// search OR, and that the pure composition helper is clobber-safe.
// ─────────────────────────────────────────────────────────────────────────────

// ── Pure helper: addOrFilter never loses a pre-existing (scope) OR ──────────────
describe('addOrFilter — clobber-safe OR composition', () => {
  it('no pre-existing OR → sets OR directly (cheap, unchanged shape)', () => {
    const where: Record<string, unknown> = { organization_id: 'org-1' };
    addOrFilter(where, [{ a: 1 }, { b: 2 }]);
    expect(where).toEqual({ organization_id: 'org-1', OR: [{ a: 1 }, { b: 2 }] });
  });

  it('a pre-existing (scope) OR is preserved: both ORs become AND-ed peers', () => {
    const scopeOr = [{ s1: true }, { s2: true }];
    const where: Record<string, unknown> = { organization_id: 'org-1', OR: scopeOr };
    addOrFilter(where, [{ q1: true }, { q2: true }]);
    expect(where.OR).toBeUndefined();
    expect(where.AND).toEqual([
      { OR: [{ s1: true }, { s2: true }] },
      { OR: [{ q1: true }, { q2: true }] },
    ]);
    // The scope disjunction is still REQUIRED (not dropped) — that's the anti-leak invariant.
    expect((where.AND as any[]).some((c) => JSON.stringify(c) === JSON.stringify({ OR: scopeOr }))).toBe(true);
  });

  it('an existing AND is appended to, not replaced', () => {
    const where: Record<string, unknown> = { AND: [{ x: 1 }], OR: [{ s: 1 }] };
    addOrFilter(where, [{ q: 1 }]);
    expect(where.AND).toEqual([{ x: 1 }, { OR: [{ s: 1 }] }, { OR: [{ q: 1 }] }]);
    expect(where.OR).toBeUndefined();
  });
});

// ── Controller: Lead list — reachable multi-read (tech: OWN_WALKTHROUGH + override OWN_LEAD) ──
const mockLead = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  tag: { findMany: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
};

function whereOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return mock.mock.calls[0][0].where as Record<string, unknown>;
}

// Recursively collect every `lead_assignees`/`walkthroughs` ownership clause anywhere in the
// where tree, so we can assert BOTH scope arms survived regardless of nesting (OR vs AND).
function deepHas(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => deepHas(n, key));
  if (node && typeof node === 'object') {
    if (key in (node as Record<string, unknown>)) return true;
    return Object.values(node as Record<string, unknown>).some((v) => deepHas(v, key));
  }
  return false;
}

describe('GET /api/leads (LIST) — multi-read scope OR survives a search OR (Issue 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    clearUserOverrideCache();
    mockLead.lead.findMany.mockResolvedValue([]);
    mockLead.lead.count.mockResolvedValue(0);
    if (mockLead.tag?.findMany) mockLead.tag.findMany.mockResolvedValue([]);
  });

  it('granted tech (override update Lead) + ?search=: BOTH walkthrough and own-lead scope arms are kept', async () => {
    mockAuthAs('technician');
    // tech default role read = OWN_WALKTHROUGH (conditional); override `update Lead` synthesizes a
    // second distinct conditional read = OWN_LEAD ⇒ scopeWhereFor returns { OR: [walkthrough, own] }.
    mockLead.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'update', subject: 'Lead', effect: 'allow' },
    ]);

    const res = await request(app).get('/api/leads?search=smith').set(authHeader('technician'));

    expect(res.status).toBe(200);
    const where = whereOf(mockLead.lead.findMany);
    // The scope's two ownership arms must BOTH still be present somewhere in the tree…
    expect(deepHas(where, 'visits')).toBe(true);
    expect(deepHas(where, 'lead_assignees')).toBe(true);
    // …AND the search clauses must also be present (proving neither OR clobbered the other).
    expect(deepHas(where, 'service_request')).toBe(true);
    // Anti-regression: a bare top-level OR === only the search clauses === scope was dropped.
    // After the fix the scope OR is demoted under AND, so a top-level OR (if any) is NOT the
    // 5-clause search list standing alone without the scope.
    if (Array.isArray(where.OR)) {
      const topOr = where.OR as Record<string, unknown>[];
      const isPureSearch = topOr.every((c) => 'service_request' in c || 'customer' in c);
      expect(isPureSearch && !deepHas({ AND: where.AND }, 'visits')).toBe(false);
    }
  });

  it('granted tech (override update Lead), NO search: scope OR is the (uncontested) top-level OR', async () => {
    mockAuthAs('technician');
    mockLead.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'update', subject: 'Lead', effect: 'allow' },
    ]);

    const res = await request(app).get('/api/leads').set(authHeader('technician'));

    expect(res.status).toBe(200);
    const where = whereOf(mockLead.lead.findMany);
    // No search → scope OR stays as the plain top-level OR (the cheap path).
    expect(Array.isArray(where.OR)).toBe(true);
    expect(deepHas(where, 'visits')).toBe(true);
    expect(deepHas(where, 'lead_assignees')).toBe(true);
  });
});

// ── Controller: Invoice list — reachable multi-read (SALES role OWN_INVOICE_VIA_LEAD + override OWN_INVOICE_VIA_JOB) ──
const mockInv = prisma as unknown as {
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  payment: { aggregate: ReturnType<typeof vi.fn> };
  job: { count: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
};

describe('GET /api/invoices (LIST) — multi-read scope OR survives a search OR (Issue 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    clearUserOverrideCache();
    mockInv.invoice.findMany.mockResolvedValue([]);
    mockInv.invoice.count.mockResolvedValue(0);
    mockInv.invoice.aggregate.mockResolvedValue({ _sum: {}, _count: 0 });
    mockInv.payment.aggregate.mockResolvedValue({ _sum: {}, _count: 0 });
    mockInv.job.count.mockResolvedValue(0);
  });

  it('SALES (role read OWN_INVOICE_VIA_LEAD) + override create Invoice + ?search=: BOTH scope arms kept', async () => {
    mockAuthAs('sales');
    // SALES default role read Invoice = OWN_INVOICE_VIA_LEAD (job.estimate.lead.lead_assignees).
    setCachedGrants(TEST_USERS.sales.organization_id, 'SALES', [
      { action: 'read', subject: 'Invoice', conditions: { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } } },
    ]);
    // Per-user override create Invoice → synthesizes a SECOND distinct read = OWN_INVOICE_VIA_JOB.
    mockInv.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'create', subject: 'Invoice', effect: 'allow' },
    ]);

    const res = await request(app).get('/api/invoices?search=I00001').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = whereOf(mockInv.invoice.findMany);
    // Both scope arms (via-lead AND via-job) survive: the via-lead arm has `estimate`, both have `job`.
    expect(deepHas(where, 'estimate')).toBe(true); // unique to OWN_INVOICE_VIA_LEAD
    expect(deepHas(where, 'assignees')).toBe(true);
    // The search clauses are present too (neither OR dropped).
    expect(deepHas(where, 'invoice_number')).toBe(true);
  });
});
