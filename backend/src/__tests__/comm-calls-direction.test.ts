import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as any;

// The CallSession API's direction vocabulary. The frontend union is
// CallDirection = 'inbound' | 'outbound' (communication-shared/phone-calls.ts)
// and every FE branch compares against the long forms — but real CTM ingest
// stores 'in'/'out' (lib/ctm/ingest.ts callDirection). Without normalization
// at the mapper, every real call renders as an incoming call with the org's
// own tracking number shown as the caller.
function callRow(id: string, direction: string) {
  return {
    id,
    direction,
    from_number: '+15551234567',
    to_number: '+15550001111',
    tracking_source: null,
    status: 'completed',
    answered_by: { kind: 'none' },
    started_at: new Date('2026-07-01T10:00:00Z'),
    duration_sec: 30,
    customer_id: null,
    lead_id: null,
    vendor_id: null,
    job_id: null,
    job_label: null,
    organization_id: ALPHA_ORG_ID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('GET /api/communication/calls — direction vocabulary', () => {
  it("maps stored 'in'/'out' (CTM ingest) to 'inbound'/'outbound' (frontend contract)", async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow('cd000000-0000-0000-0000-000000000001', 'in'),
      callRow('cd000000-0000-0000-0000-000000000002', 'out'),
    ]);

    const res = await request(app)
      .get('/api/communication/calls')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.calls.map((c: { direction: string }) => c.direction)).toEqual([
      'inbound',
      'outbound',
    ]);
  });

  it('passes seeded long-form directions through unchanged', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow('cd000000-0000-0000-0000-000000000003', 'inbound'),
      callRow('cd000000-0000-0000-0000-000000000004', 'outbound'),
    ]);

    const res = await request(app)
      .get('/api/communication/calls')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.calls.map((c: { direction: string }) => c.direction)).toEqual([
      'inbound',
      'outbound',
    ]);
  });

  it('surfaces trackingSource for inbound calls but never for outbound (ad source is an inbound-only concept)', async () => {
    // Ad source = which CTM tracking number a *caller* dialed (campaign
    // attribution). Outbound calls have no ad source; CTM may still stamp a
    // meaningless `source` on the webhook, so the API must not surface it.
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany.mockResolvedValue([
      { ...callRow('cd000000-0000-0000-0000-000000000005', 'in'), tracking_source: 'Facebook Campaign' },
      { ...callRow('cd000000-0000-0000-0000-000000000006', 'out'), tracking_source: 'Facebook Campaign' },
    ]);

    const res = await request(app)
      .get('/api/communication/calls')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const [inbound, outbound] = res.body.calls;
    expect(inbound.trackingSource).toBe('Facebook Campaign');
    expect(outbound).not.toHaveProperty('trackingSource');
  });
});
