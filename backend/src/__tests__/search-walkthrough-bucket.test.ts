import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

// ---------------------------------------------------------------------------
// Two independent reasons the schedule board's own search could not find a
// walkthrough that was visibly sitting in its Walkthroughs sidebar bucket:
//
//   1. `lead_number` was never a search term. Jobs matched `job_number`, leads
//      matched only service_request / customer name / address - so typing the
//      L-number printed on the card matched nothing, on the schedule AND in
//      global search.
//
//   2. schedule scope admitted only `Walkthrough.status = SCHEDULED`, but the
//      sidebar bucket is fed by `walkthrough_status=needs_scheduling`, which
//      lead.filters.ts expands to `status = REQUESTED`. Every card in that
//      bucket was filtered out of search before the query ran. Widening the
//      status alone is not enough: findScheduleLeads then dropped the rows
//      again, because resolveCurrentWalkthrough returns null for a
//      REQUESTED-only lead and the sort keyed on a non-null scheduled_at.
// ---------------------------------------------------------------------------

const m = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

function walkthrough(over: Record<string, unknown>) {
  return {
    id: 'w', status: 'SCHEDULED', scheduled_at: null, duration_minutes: 60,
    completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null,
    created_at: new Date('2026-08-01T00:00:00.000Z'), canceller: null,
    ...over,
  };
}

function lead(over: Record<string, unknown>) {
  return {
    id: 'lead-1',
    lead_number: 'L00203',
    service_request: 'Furnace inspection',
    status: 'CONTACTED',
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    service_address_line1: '100 Test Ave',
    service_city: 'Austin',
    service_state: 'TX',
    customer: { first_name: 'John', last_name: 'Doe', company_name: null, phone: '5551234567' },
    visits: [walkthrough({ id: 'w-req', status: 'REQUESTED' })],
    ...over,
  };
}

function reset() {
  vi.clearAllMocks();
  m.lead.findMany.mockResolvedValue([lead({})]);
  m.job.findMany.mockResolvedValue([]);
  m.customer.findMany.mockResolvedValue([]);
  m.estimate.findMany.mockResolvedValue([]);
  m.invoice.findMany.mockResolvedValue([]);
}

/** Every `visits.some.status` predicate named anywhere in a where tree, however it is composed. */
function boardStatusPredicates(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(boardStatusPredicates);
  if (!node || typeof node !== 'object') return [];
  const rec = node as Record<string, any>;
  const out: unknown[] = [];
  if (rec.visits?.some?.status !== undefined) out.push(rec.visits.some.status);
  for (const v of Object.values(rec)) out.push(...boardStatusPredicates(v));
  return out;
}

function wheresOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return mock.mock.calls.map((c) => c[0].where as Record<string, unknown>);
}

/** Every `contains` term the composed OR offers, flattened, regardless of nesting depth. */
function searchedFields(where: Record<string, unknown>): string[] {
  const out: string[] = [];
  (function walk(node: unknown) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'contains' in (v as object)) out.push(k);
      else walk(v);
    }
  })(where);
  return out;
}

async function search(query: Record<string, string>) {
  mockAuthAs('admin');
  return request(app).get('/api/search').query(query).set(authHeader('admin'));
}

describe('GET /api/search - leads are searchable by their lead number', () => {
  beforeEach(reset);

  it('offers lead_number as a search term in global scope, the way jobs offer job_number', async () => {
    const res = await search({ q: 'L00203' });

    expect(res.status).toBe(200);
    expect(m.lead.findMany).toHaveBeenCalled();
    for (const w of wheresOf(m.lead.findMany)) {
      expect(searchedFields(w)).toContain('lead_number');
    }
  });

  it('offers lead_number in schedule scope too', async () => {
    const res = await search({ q: 'L00203', scope: 'schedule' });

    expect(res.status).toBe(200);
    for (const w of wheresOf(m.lead.findMany)) {
      expect(searchedFields(w)).toContain('lead_number');
    }
  });
});

describe('GET /api/search?scope=schedule - unscheduled walkthroughs are findable', () => {
  beforeEach(reset);

  it('admits every LIVE visit state, not just SCHEDULED - the board renders all of them', async () => {
    await search({ q: 'doe', scope: 'schedule' });

    for (const w of wheresOf(m.lead.findMany)) {
      // Found ANYWHERE in the where tree: the board filter is AND-composed on top of the caller's
      // Lead row-scope, which owns a top-level `visits` key of its own, so reading a fixed key
      // path here would assert over the wrong node (or over nothing at all).
      const named = boardStatusPredicates(w);
      expect(named.length).toBeGreaterThan(0);
      // This pinned ['REQUESTED', 'SCHEDULED'] until multi-visit S4. REQUESTED was retired by the
      // S1 migration and the query kept naming it - a Prisma validation error against real
      // Postgres, swallowed by safeQuery into an empty array, invisible under a mocked Prisma.
      // Sourced from LIVE_VISIT_STATUSES now, so the query cannot drift out of the enum again.
      for (const status of named) {
        expect(status).toEqual({ in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] });
      }
    }
  });

  it('returns a REQUESTED-only lead instead of dropping it for having no scheduled_at', async () => {
    const res = await search({ q: 'doe', scope: 'schedule' });

    expect(res.body.results.leads.map((l: { id: string }) => l.id)).toContain('lead-1');
  });

  it('gives an unscheduled walkthrough a null date, so the board never jumps to a bogus day', async () => {
    const res = await search({ q: 'doe', scope: 'schedule' });

    const [row] = res.body.results.leads;
    // created_at is non-null on the fixture - the old code fell back to it here.
    expect(row.date).toBeNull();
  });

  it('titles a schedule-scope walkthrough with its lead number, matching the board card', async () => {
    const res = await search({ q: 'doe', scope: 'schedule' });

    const [row] = res.body.results.leads;
    expect(row.title).toBe('L00203');
    expect(row.subtitle).toBe('John Doe');
  });

  it('orders scheduled walkthroughs ahead of unscheduled ones, soonest first', async () => {
    m.lead.findMany.mockResolvedValue([
      lead({ id: 'unscheduled', visits: [walkthrough({ status: 'REQUESTED' })] }),
      lead({
        id: 'later',
        visits: [walkthrough({ scheduled_at: new Date('2026-08-20T09:00:00.000Z') })],
      }),
      lead({
        id: 'sooner',
        visits: [walkthrough({ scheduled_at: new Date('2026-08-15T09:00:00.000Z') })],
      }),
    ]);

    const res = await search({ q: 'doe', scope: 'schedule' });

    expect(res.body.results.leads.map((l: { id: string }) => l.id)).toEqual([
      'sooner', 'later', 'unscheduled',
    ]);
  });

  it('still sources a SCHEDULED walkthrough date from its current visit', async () => {
    const scheduledAt = new Date('2026-08-15T14:00:00.000Z');
    m.lead.findMany.mockResolvedValue([
      lead({ visits: [walkthrough({ status: 'SCHEDULED', scheduled_at: scheduledAt })] }),
    ]);

    const res = await search({ q: 'doe', scope: 'schedule' });

    expect(res.body.results.leads[0].date).toBe(scheduledAt.toISOString());
  });

  it('leaves global scope alone - title stays the service request, date the created_at', async () => {
    const res = await search({ q: 'doe' });

    const [row] = res.body.results.leads;
    expect(row.title).toBe('Furnace inspection');
    expect(row.date).toBe(new Date('2026-08-01T00:00:00.000Z').toISOString());
  });
});
