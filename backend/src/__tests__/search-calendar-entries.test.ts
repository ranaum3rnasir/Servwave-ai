import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

// ---------------------------------------------------------------------------
// Slice 09 — the scheduler's fourth schedulable type (scheduleModel.ts EventType
// 'calendar-entry') gains its own bucket in GET /api/search?scope=schedule,
// matched on TITLE ONLY (spec §3: entries carry no record number, so title is
// the only handle) and org-scoped through the caller's `read CalendarEntry`
// grant — DISPATCHER and ADMIN by default (defaultGrants.ts); SALES has none
// unless overridden, and must get back an EMPTY array, not a missing key or a
// 403 that would blank the rest of the search response.
// ---------------------------------------------------------------------------

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'ce-1',
    title: 'Dave PTO',
    start: new Date('2026-09-10T09:00:00.000Z'),
    ...over,
  };
}

function reset() {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  (prisma.lead.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.estimate.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.servicePlan.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.calendarEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([entry()]);
}

async function search(query: Record<string, string>, as: 'admin' | 'dispatcher' | 'sales' = 'dispatcher') {
  mockAuthAs(as);
  return request(app).get('/api/search').query(query).set(authHeader(as));
}

describe('GET /api/search?scope=schedule - calendar entries (Events)', () => {
  beforeEach(reset);

  it('returns the event whose title was typed, under results.calendarEntries', async () => {
    const res = await search({ q: 'Dave', scope: 'schedule' });

    expect(res.status).toBe(200);
    expect(res.body.results.calendarEntries).toHaveLength(1);
    expect(res.body.results.calendarEntries[0]).toMatchObject({
      id: 'ce-1',
      entity_type: 'calendar-entry',
      title: 'Dave PTO',
    });
    expect(res.body.results.calendarEntries[0].date).toBe('2026-09-10T09:00:00.000Z');
  });

  it('matches on title only — a description-only hit is not returned', async () => {
    // The mock is a stand-in for a real WHERE clause: assert the query only ever
    // asks Prisma to search `title`, never `description`.
    await search({ q: 'birthday', scope: 'schedule' });

    const where = (prisma.calendarEntry.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toHaveProperty('title');
    expect(where).not.toHaveProperty('description');
  });

  it('is tenant-scoped', async () => {
    await search({ q: 'Dave', scope: 'schedule' });

    const where = (prisma.calendarEntry.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where as Record<string, unknown>;
    expect(where.organization_id).toBe(TEST_USERS.dispatcher.organization_id);
  });

  it('excludes an event outside the rangeStart/rangeEnd window', async () => {
    await search({
      q: 'Dave',
      scope: 'schedule',
      rangeStart: '2026-10-01T00:00:00.000Z',
      rangeEnd: '2026-10-31T00:00:00.000Z',
    });

    const where = (prisma.calendarEntry.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where as Record<string, unknown>;
    // The event fixture starts 2026-09-10, well outside an October window — the
    // handler must have composed a range predicate that would exclude it, not
    // merely accepted the params without using them.
    const raw = JSON.stringify(where);
    expect(raw).toContain('2026-10-01');
    expect(raw).toContain('2026-10-31');
  });

  it('caps results at 5, like its sibling buckets', async () => {
    await search({ q: 'Dave', scope: 'schedule' });

    const args = (prisma.calendarEntry.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.take).toBe(5);
  });

  it('a caller without read CalendarEntry gets an empty array, not a missing key', async () => {
    const res = await search({ q: 'Dave', scope: 'schedule' }, 'sales');

    expect(res.status).toBe(200);
    expect(res.body.results.calendarEntries).toEqual([]);
    expect(prisma.calendarEntry.findMany).not.toHaveBeenCalled();
  });

  it('leaves global (non-schedule) search alone — the group is empty and unqueried', async () => {
    const res = await search({ q: 'Dave' });

    expect(res.status).toBe(200);
    expect(res.body.results.calendarEntries).toEqual([]);
    expect(prisma.calendarEntry.findMany).not.toHaveBeenCalled();
  });
});
