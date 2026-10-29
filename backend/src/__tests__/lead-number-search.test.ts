import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// The leads LIST search was the last search surface that could not match a lead by its
// own number: typing a lead number plainly visible in the Lead # column returned
// "No results found". Every other list controller already searched its own number -
// customer.controller (customer_number), job.controller (job_number), estimate.controller
// (estimate_number), invoice.controller (invoice_number + job.job_number) - and global
// search picked up lead_number in #1234. Only lead.controller's own list was left out.
//
// The /api/search case below therefore guards EXISTING behaviour: it is here so the two
// surfaces cannot drift apart again, since the list is what regressed while global search
// was fine.
//
// A digit-only term like '01197' also feeds phoneSearchClauses/phoneRelationSearchClauses,
// so these assert on CONTAINMENT rather than OR length - the phone clauses are expected
// company and their count is not what is under test here.
// ─────────────────────────────────────────────────────────────────────────────

const m = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  m.lead.findMany.mockResolvedValue([]);
  m.lead.count.mockResolvedValue(0);
  m.job.findMany.mockResolvedValue([]);
  m.customer.findMany.mockResolvedValue([]);
  m.estimate.findMany.mockResolvedValue([]);
  m.invoice.findMany.mockResolvedValue([]);
});

/** Every `where.OR` array reachable in the composed clause, flattened. */
function orClausesOf(where: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.OR)) out.push(...(obj.OR as Record<string, unknown>[]));
      Object.values(obj).forEach(walk);
    }
  };
  walk(where);
  return out;
}

function hasLeadNumberClause(where: unknown, term: string): boolean {
  return orClausesOf(where).some(
    (c) =>
      JSON.stringify(c) ===
      JSON.stringify({ lead_number: { contains: term, mode: 'insensitive' } }),
  );
}

describe('lead number is searchable', () => {
  it('GET /api/leads matches on lead_number', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/leads?search=01197').set(authHeader('admin'));

    const where = m.lead.findMany.mock.calls[0][0].where;
    expect(hasLeadNumberClause(where, '01197')).toBe(true);
  });

  it('GET /api/leads matches a lead_number case-insensitively (L-prefixed format)', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/leads?search=l00119').set(authHeader('admin'));

    const where = m.lead.findMany.mock.calls[0][0].where;
    expect(hasLeadNumberClause(where, 'l00119')).toBe(true);
  });

  it('GET /api/search matches on lead_number', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/search?q=01197').set(authHeader('admin'));

    const wheres = m.lead.findMany.mock.calls.map((c) => c[0].where);
    expect(wheres.length).toBeGreaterThan(0);
    expect(wheres.some((w) => hasLeadNumberClause(w, '01197'))).toBe(true);
  });

  it('does not add a lead_number clause when no search term is supplied', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/leads').set(authHeader('admin'));

    const where = m.lead.findMany.mock.calls[0][0].where;
    expect(orClausesOf(where).some((c) => 'lead_number' in c)).toBe(false);
  });
});
