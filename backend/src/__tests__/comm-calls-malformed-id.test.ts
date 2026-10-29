import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as any;

// A malformed `:id` on the comm-calls routes reached Prisma's `where: { id }`.
// Those columns are Postgres `uuid`, so the driver throws P2023 and each
// controller's catch turned it into a 500 - found live on staging 2026-08-06:
//
//   GET /api/communication/calls/definitely-not-a-route  ->  500
//   GET /api/communication/calls/<well-formed-but-absent> ->  404   (correct)
//
// A 500 says "the server broke"; it did not. A client-side placeholder, a
// truncated deep link or a hand-typed URL is a CLIENT error, and it must be
// indistinguishable from a genuinely absent row - neither names a real
// resource. `requireUuidParam` (middleware, already used elsewhere) fails fast
// with the same 404 before Prisma is touched.
//
// Every `:id` route on this router shares the defect, so every one is covered
// here - fixing only the one that happened to be noticed would leave four
// identical 500s behind.

const MALFORMED = 'definitely-not-a-route';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('comm-calls :id routes - a malformed id is a 404, never a 500', () => {
  it('GET /calls/:id 404s on a malformed id without touching Prisma', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .get(`/api/communication/calls/${MALFORMED}`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Call not found');
    // The point of the guard: Prisma is never reached, so it can never throw
    // P2023 and no error is logged for what is really a client mistake.
    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });

  it('GET /calls/:id/recording 404s on a malformed id', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .get(`/api/communication/calls/${MALFORMED}/recording`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });

  it('GET /calls/:id/transcript 404s on a malformed id', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .get(`/api/communication/calls/${MALFORMED}/transcript`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });

  it('PATCH /calls/:id/job 404s on a malformed id', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .patch(`/api/communication/calls/${MALFORMED}/job`)
      .send({ job_id: null })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
  });

  it('PATCH /calls/:id/lead 404s on a malformed id', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .patch(`/api/communication/calls/${MALFORMED}/lead`)
      .send({ lead_id: null })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
  });

  // The guard must not shadow the literal route that sits alongside `:id`.
  // `/calls/outcome` is a real endpoint whose path segment is not a UUID, so a
  // guard applied too broadly (on the router rather than per-route) would 404
  // it and silently break the dialer's ended state.
  it('leaves the sibling literal route /calls/outcome reachable', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/communication/calls/outcome')
      .query({ to_number: '+19294039424', since: '2026-08-06T13:23:00.000Z' })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ call: null });
  });

  // A well-formed id that matches no row must keep returning 404 from the
  // handler, i.e. the guard narrows nothing that already worked.
  it('still 404s a well-formed but absent id via the handler', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/communication/calls/00000000-0000-4000-8000-000000000000')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
    expect(mockPrisma.callSession.findFirst).toHaveBeenCalled();
  });
});
