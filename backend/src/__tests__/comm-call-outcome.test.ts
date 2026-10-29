import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as any;

// GET /api/communication/calls/outcome
//
// The click-to-call bridge rings the agent's phone and then dials the customer,
// so the browser is not on the call and never learns it ended. The 'end'
// webhook is the only thing that knows, and it writes the CallSession ~30-40s
// after hangup. Before this endpoint the dialer sat on a terminal "Call placed"
// forever: the user had a real conversation and the screen never moved
// (reported live 2026-08-06).
//
// This is a narrow lookup, NOT a second list endpoint - the dialer knows the
// destination and when it dialled, so it asks only "did a call to THIS number
// land since THEN". Polling the full call list would ship the org's entire
// history every few seconds.

function outcomeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ca000000-0000-0000-0000-000000000001',
    direction: 'out',
    status: 'completed',
    started_at: new Date('2026-08-06T13:23:38Z'),
    duration_sec: 19,
    organization_id: ALPHA_ORG_ID,
    ...over,
  };
}

const SINCE = '2026-08-06T13:23:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('GET /api/communication/calls/outcome - did the placed call land yet', () => {
  it('returns { call: null } while the end webhook has not arrived (no row yet)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/communication/calls/outcome')
      .query({ to_number: '+19294039424', since: SINCE })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ call: null });
  });

  it('returns the ingested call so the dialer can show a real ended state', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findFirst.mockResolvedValue(outcomeRow());

    const res = await request(app)
      .get('/api/communication/calls/outcome')
      .query({ to_number: '+19294039424', since: SINCE })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({
      id: 'ca000000-0000-0000-0000-000000000001',
      status: 'completed',
      durationSec: 19,
    });
  });

  // The dialer polls right after placing a call, so the query MUST be pinned to
  // this call: outbound only, this destination, and started at/after the moment
  // we dialled. Without the `since` floor the poll would immediately match an
  // OLD call to the same customer and report the previous call's duration as
  // this one's.
  it('scopes the lookup to outbound calls to that number since the dial moment, tenant-scoped', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findFirst.mockResolvedValue(null);

    await request(app)
      .get('/api/communication/calls/outcome')
      .query({ to_number: '+19294039424', since: SINCE })
      .set(authHeader('dispatcher'));

    const where = mockPrisma.callSession.findFirst.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.direction).toBe('out');
    expect(where.to_number).toBe('+19294039424');
    expect(where.started_at).toEqual({ gte: new Date(SINCE) });
  });

  it('400s a missing or malformed destination rather than scanning every call', async () => {
    mockAuthAs('dispatcher');

    const missing = await request(app)
      .get('/api/communication/calls/outcome')
      .query({ since: SINCE })
      .set(authHeader('dispatcher'));
    expect(missing.status).toBe(400);

    const malformed = await request(app)
      .get('/api/communication/calls/outcome')
      .query({ to_number: 'not-a-number', since: SINCE })
      .set(authHeader('dispatcher'));
    expect(malformed.status).toBe(400);

    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });

  it('400s a missing or malformed since, so the poll can never match an older call', async () => {
    mockAuthAs('dispatcher');

    const missing = await request(app)
      .get('/api/communication/calls/outcome')
      .query({ to_number: '+19294039424' })
      .set(authHeader('dispatcher'));
    expect(missing.status).toBe(400);

    const malformed = await request(app)
      .get('/api/communication/calls/outcome')
      .query({ to_number: '+19294039424', since: 'yesterday' })
      .set(authHeader('dispatcher'));
    expect(malformed.status).toBe(400);

    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });
});
