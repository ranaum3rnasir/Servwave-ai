import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache, setCachedGrants } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// ─────────────────────────────────────────────────────────────────────────────
// QA-B2 re-verify residual — `GET /api/search` leaked org-wide estimate + invoice
// totals (and all leads/jobs) to users without the matching `read` grant, because it
// scoped with ad-hoc role literals (`role===SALES` for estimates/leads, `role===TECH`
// for jobs, NOTHING for invoices). The fix drives every scoped entity off the same
// row-scope engine the entity controllers use — `scopeWhereForReq(req, Subject)` —
// which is override-aware and fail-closed (no read grant → MATCH_NOTHING → that
// entity yields nothing). Customers skip on an ability check (`can read Customer`).
//
// These tests assert the SCOPE that reaches Prisma (not just the empty arrays), so a
// regression that re-broadens the query is caught even with empty mock results.
// ─────────────────────────────────────────────────────────────────────────────

const m = prisma as unknown as {
  job: { findMany: ReturnType<typeof vi.fn> };
  lead: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
};

const MATCH_NOTHING_ID = { in: [] as string[] };

function reset() {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  m.job.findMany.mockResolvedValue([]);
  m.lead.findMany.mockResolvedValue([]);
  m.estimate.findMany.mockResolvedValue([]);
  m.invoice.findMany.mockResolvedValue([]);
  m.customer.findMany.mockResolvedValue([]);
  m.userPermissionOverride.findMany.mockResolvedValue([]);
}

// Collect EVERY `where` a delegate's findMany was called with (search fans out into
// several tiered queries per entity).
function wheresOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return mock.mock.calls.map((c) => c[0].where as Record<string, unknown>);
}

// Does any node anywhere in the where tree contain `key`?
function deepHas(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => deepHas(n, key));
  if (node && typeof node === 'object') {
    if (key in (node as Record<string, unknown>)) return true;
    return Object.values(node as Record<string, unknown>).some((v) => deepHas(v, key));
  }
  return false;
}

// Is this where fail-closed (MATCH_NOTHING) — i.e. carries `id: { in: [] }` anywhere?
function isMatchNothing(where: Record<string, unknown>): boolean {
  return JSON.stringify(where).includes(JSON.stringify(MATCH_NOTHING_ID));
}

describe('GET /api/search — RBAC row-scoping (QA-B2 residual leak fix)', () => {
  beforeEach(reset);

  // ── Strict technician: no read Invoice / read Customer. Estimate is no longer strict as
  // of the technician-ownership spec (2026-08-05, live QA) - TECHNICIAN now holds a CONDITIONAL
  // read Estimate grant (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR), so its search results are own-scoped
  // rather than fail-closed. ──────────────────────────────────────────────────────────────────
  describe('strict TECHNICIAN', () => {
    it('returns own jobs + own walkthrough leads + own-scoped estimates; ZERO invoices, customers', async () => {
      mockAuthAs('technician');
      const res = await request(app).get('/api/search?q=doe').set(authHeader('technician'));
      expect(res.status).toBe(200);

      // Response arrays for estimates/invoices/customers are empty (mocked findMany returns []).
      expect(res.body.results.estimates).toEqual([]);
      expect(res.body.results.invoices).toEqual([]);
      expect(res.body.results.customers).toEqual([]);

      // Customers sub-query must be SKIPPED for a tech (no read Customer).
      expect(m.customer.findMany).not.toHaveBeenCalled();

      // Invoice queries, IF run at all, are fail-closed (MATCH_NOTHING) - never org-wide.
      // (The fix may skip them entirely OR scope them to nothing.)
      for (const w of wheresOf(m.invoice.findMany)) expect(isMatchNothing(w)).toBe(true);

      // Estimate queries carry the OWN_ESTIMATE_VIA_LEAD_OR_CREATOR condition, never
      // MATCH_NOTHING and never org-wide: a technician's estimate is always lead-less, so it can
      // only ever surface via the creator arm, pinned to the technician's own id.
      const estWheres = wheresOf(m.estimate.findMany);
      expect(estWheres.length).toBeGreaterThan(0);
      for (const w of estWheres) {
        expect(isMatchNothing(w)).toBe(false);
        expect(deepHas(w, 'created_by')).toBe(true);
      }

      // Jobs scoped to OWN (assignees), leads scoped to OWN_WALKTHROUGH.
      const jobWheres = wheresOf(m.job.findMany);
      expect(jobWheres.length).toBeGreaterThan(0);
      for (const w of jobWheres) expect(deepHas(w, 'assignees')).toBe(true);

      // Walkthrough-as-entity redesign, PR-B2: OWN_WALKTHROUGH is now a nested relation
      // through the walkthroughs -> performers join (defaultGrants.ts).
      const leadWheres = wheresOf(m.lead.findMany);
      expect(leadWheres.length).toBeGreaterThan(0);
      for (const w of leadWheres) expect(deepHas(w, 'visits')).toBe(true);
      // …and a strict tech must NOT get org-wide leads (the old role-literal bug).
      for (const w of leadWheres) expect(deepHas(w, 'visits')).toBe(true);
    });
  });

  // ── SALES: own-scoped on every entity ───────────────────────────────────────
  describe('SALES', () => {
    it('scopes jobs/leads/estimates/invoices to OWN (never org-wide)', async () => {
      mockAuthAs('sales');
      const res = await request(app).get('/api/search?q=doe').set(authHeader('sales'));
      expect(res.status).toBe(200);

      // Leads → OWN_LEAD (lead_assignees).
      for (const w of wheresOf(m.lead.findMany)) {
        expect(deepHas(w, 'lead_assignees')).toBe(true);
        expect(isMatchNothing(w)).toBe(false);
      }
      // Estimates → OWN via parent lead's lead_assignees.
      const estWheres = wheresOf(m.estimate.findMany);
      expect(estWheres.length).toBeGreaterThan(0);
      for (const w of estWheres) {
        expect(deepHas(w, 'lead_assignees')).toBe(true);
        expect(isMatchNothing(w)).toBe(false);
      }
      // Jobs → OWN_JOB_VIA_ESTIMATE (lead_assignees through estimate.lead).
      const jobWheres = wheresOf(m.job.findMany);
      expect(jobWheres.length).toBeGreaterThan(0);
      for (const w of jobWheres) {
        expect(deepHas(w, 'lead_assignees')).toBe(true);
        expect(isMatchNothing(w)).toBe(false);
      }
      // Invoices → OWN_INVOICE_VIA_LEAD (job.estimate.lead.lead_assignees). The OLD bug:
      // invoices had NO scoping → org-wide. Now they must carry the owner condition.
      const invWheres = wheresOf(m.invoice.findMany);
      expect(invWheres.length).toBeGreaterThan(0);
      for (const w of invWheres) {
        expect(deepHas(w, 'lead_assignees')).toBe(true);
        expect(isMatchNothing(w)).toBe(false);
      }
      // SALES CAN read customers (default grant) → customers queried.
      expect(m.customer.findMany).toHaveBeenCalled();
    });
  });

  // ── ADMIN: org-wide (scope {}), all entities reachable ──────────────────────
  describe('ADMIN', () => {
    it('is org-wide: no MATCH_NOTHING and no per-entity owner condition forced', async () => {
      mockAuthAs('admin');
      const res = await request(app).get('/api/search?q=doe').set(authHeader('admin'));
      expect(res.status).toBe(200);

      for (const mock of [m.job.findMany, m.lead.findMany, m.estimate.findMany, m.invoice.findMany]) {
        const wheres = wheresOf(mock);
        expect(wheres.length).toBeGreaterThan(0);
        for (const w of wheres) {
          expect(isMatchNothing(w)).toBe(false);
          // No injected ownership scope for an admin.
          expect(deepHas(w, 'lead_assignees')).toBe(false);
          expect(deepHas(w, 'assignees')).toBe(false);
          expect(deepHas(w, 'visits')).toBe(false);
        }
      }
      expect(m.customer.findMany).toHaveBeenCalled();
    });

    it('digit-normalizes a phone query so a digits-only search reaches a formatted store (#350)', async () => {
      mockAuthAs('admin');
      const res = await request(app).get('/api/search?q=5551234567').set(authHeader('admin'));
      expect(res.status).toBe(200);

      // The customer sub-query's OR must carry both the digits-only form and the
      // canonical formatted form so a digits query finds a `(555) 123-4567` store.
      const customerWheres = wheresOf(m.customer.findMany);
      expect(customerWheres.length).toBeGreaterThan(0);
      const phoneContains = customerWheres.flatMap((w) =>
        ((w.OR as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((c) => (c as { phone?: { contains?: string } }).phone?.contains !== undefined)
          .map((c) => (c as { phone: { contains: string } }).phone.contains),
      );
      expect(phoneContains).toContain('5551234567');
      expect(phoneContains).toContain('(555) 123-4567');
    });

    it('also searches the phones[] relation so a phones[]-stored number is found (#460)', async () => {
      mockAuthAs('admin');
      const res = await request(app).get('/api/search?q=5551234567').set(authHeader('admin'));
      expect(res.status).toBe(200);

      const customerWheres = wheresOf(m.customer.findMany);
      expect(customerWheres.length).toBeGreaterThan(0);
      const phonesContains = customerWheres.flatMap((w) =>
        ((w.OR as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((c) => (c as { phones?: { some?: { phone?: { contains?: string } } } }).phones?.some?.phone?.contains !== undefined)
          .map((c) => (c as { phones: { some: { phone: { contains: string } } } }).phones.some.phone.contains),
      );
      expect(phonesContains).toContain('5551234567');
      expect(phonesContains).toContain('(555) 123-4567');
    });
  });

  // ── Multi-read user: scope OR + search OR both preserved (no clobber) ────────
  describe('multi-read user (OR-clobber safety)', () => {
    it('SALES + override create Invoice: both invoice scope arms AND the search OR survive', async () => {
      mockAuthAs('sales');
      // SALES role read Invoice = OWN_INVOICE_VIA_LEAD (job.estimate.lead.lead_assignees).
      setCachedGrants(TEST_USERS.sales.organization_id, 'SALES', [
        { action: 'read', subject: 'Invoice', conditions: { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } } },
      ]);
      // Per-user override `create Invoice` synthesizes a SECOND distinct read = OWN_INVOICE_VIA_JOB
      // → scopeWhereFor returns { OR: [viaLead, viaJob] }. The search term then adds its own OR.
      m.userPermissionOverride.findMany.mockResolvedValue([
        { action: 'create', subject: 'Invoice', effect: 'allow' },
      ]);

      const res = await request(app).get('/api/search?q=I00001').set(authHeader('sales'));
      expect(res.status).toBe(200);

      const invWheres = wheresOf(m.invoice.findMany);
      expect(invWheres.length).toBeGreaterThan(0);
      const w = invWheres[0];
      // Both scope arms survive: via-lead arm has `estimate`, via-job arm has `assignees`.
      expect(deepHas(w, 'estimate')).toBe(true);
      expect(deepHas(w, 'assignees')).toBe(true);
      // The search OR (invoice_number) is present too — neither OR clobbered the other.
      expect(deepHas(w, 'invoice_number')).toBe(true);
      // The scope OR was demoted under AND (not standing alone as a bare top-level OR
      // that is purely the search clauses).
      if (Array.isArray(w.OR)) {
        const topOr = w.OR as Record<string, unknown>[];
        const isPureSearch = topOr.every((c) => 'invoice_number' in c || 'job' in c);
        // If the top-level OR is purely search, the scope arms must live under AND.
        if (isPureSearch) expect(deepHas({ AND: w.AND }, 'estimate')).toBe(true);
      }
    });
  });

  // ── Granted technician: override read/create Invoice → own-scoped invoices ───
  describe('granted TECHNICIAN (override create Invoice)', () => {
    it('gets own-scoped invoices (via job) instead of zero', async () => {
      mockAuthAs('technician');
      // create Invoice override → synthesizes own-scoped read Invoice = OWN_INVOICE_VIA_JOB.
      m.userPermissionOverride.findMany.mockResolvedValue([
        { action: 'create', subject: 'Invoice', effect: 'allow' },
      ]);

      const res = await request(app).get('/api/search?q=I00001').set(authHeader('technician'));
      expect(res.status).toBe(200);

      const invWheres = wheresOf(m.invoice.findMany);
      expect(invWheres.length).toBeGreaterThan(0);
      for (const w of invWheres) {
        // Own-scoped via job assignees — NOT fail-closed, NOT org-wide.
        expect(deepHas(w, 'assignees')).toBe(true);
        expect(isMatchNothing(w)).toBe(false);
      }
    });
  });

  // ── Estimate customer-name matching reaches Estimate.customer directly (R6) ──
  describe('estimate customer-name search — direct anchor (R6)', () => {
    it('matches the search term against Estimate.customer, never lead.customer', async () => {
      mockAuthAs('admin');
      const res = await request(app).get('/api/search?q=doe').set(authHeader('admin'));
      expect(res.status).toBe(200);

      const wheres = wheresOf(m.estimate.findMany);
      expect(wheres.length).toBeGreaterThan(0);
      for (const w of wheres) {
        expect(deepHas(w, 'customer')).toBe(true);
        // The customer-name match must reach `customer` directly — never nested
        // under `lead` (row-scope may still separately carry `lead_assignees` for
        // SALES, which is unrelated to this search-term clause).
        expect(JSON.stringify(w)).not.toContain('"lead":{"customer"');
      }
    });

    it('surfaces the customer name/phone straight off Estimate.customer in the response', async () => {
      mockAuthAs('admin');
      m.estimate.findMany.mockResolvedValue([
        {
          id: 'est-1', estimate_number: 'E00042', status: 'SENT', total_amount: 500, created_at: new Date(),
          customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, phone: '5551234567' },
        },
      ]);

      const res = await request(app).get('/api/search?q=doe').set(authHeader('admin'));
      expect(res.status).toBe(200);
      expect(res.body.results.estimates[0].subtitle).toBe('Jane Doe');
      expect(res.body.results.estimates[0].phone).toBe('5551234567');
    });
  });

  // #2046 spec §2 "Global search: no change" — pinned so the section gate never grows a search
  // bucket it does not have today. `results` carries no communication/thread/call/message-shaped
  // key for any role; the Brief's search line is satisfied by omission, not a scoping rule.
  describe('no communication-shaped bucket (#2046)', () => {
    it('GET /api/search results has no communication/thread/call/message key, for SALES or ADMIN', async () => {
      for (const role of ['sales', 'admin'] as const) {
        mockAuthAs(role);
        const res = await request(app).get('/api/search?q=doe').set(authHeader(role));
        expect(res.status).toBe(200);
        const keys = Object.keys(res.body.results);
        for (const banned of ['communication', 'communications', 'threads', 'calls', 'messages']) {
          expect(keys).not.toContain(banned);
        }
      }
    });
  });
});
