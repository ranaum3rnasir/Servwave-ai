// Master plan Task B5 (security fix S1) — POST /api/communication/calls/attribution
// (createCallAttribution) is the WebRTC softphone's stash path: the browser
// dials CTM directly, bypassing the click-to-call bridge (createCall) that
// already enforces isOutboundAllowed() before it will stash context or place a
// call. The attribution stash never checked the guard, so a softphone dial to a
// non-allowlisted number could still land its job/lead/customer context
// server-side even though it should never have been reachable during testing.
// This mirrors the O-0-style guard test in ctm-outbound-allowlist.test.ts,
// applied to the attribution endpoint.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import * as ctmClient from '../../lib/ctm/client';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from '../../__tests__/helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const JOB_ID = 'ab000000-0000-0000-0000-000000000077';
const JOB_ROW = { id: JOB_ID, job_number: 'J00077', customer_id: 'c0000000-0000-0000-0000-000000000042' };

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // setup.ts default: allowlist inert (mirrors an unset allowlist).
  client.isOutboundAllowed.mockReturnValue(true);
  p.pendingCallAttribution.create.mockResolvedValue({ id: 'f0000000-0000-0000-0000-000000000001' });
  p.pendingCallAttribution.deleteMany.mockResolvedValue({ count: 0 });
});

describe('POST /api/communication/calls/attribution — outbound allowlist guard (S1)', () => {
  it('409s NOT_IN_TEST_ALLOWLIST for a non-allowlisted destination — no stash written, no resolves', async () => {
    mockAuthAs('dispatcher');
    client.isOutboundAllowed.mockReturnValue(false);

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567', job_id: JOB_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_IN_TEST_ALLOWLIST');
    expect(res.body.error).toBeTruthy();
    // Blocked BEFORE any context resolution or stash write.
    expect(p.job.findUnique).not.toHaveBeenCalled();
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
    // The guard was consulted with the normalized E.164 destination.
    expect(client.isOutboundAllowed).toHaveBeenCalledWith('+15551234567');
  });

  it('an allowlisted destination stashes as before (202 queued:true)', async () => {
    mockAuthAs('dispatcher');
    client.isOutboundAllowed.mockReturnValue(true);
    p.job.findUnique.mockResolvedValue(JOB_ROW);

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '+15555550199', job_id: JOB_ID });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    expect(p.pendingCallAttribution.create).toHaveBeenCalled();
    expect(client.isOutboundAllowed).toHaveBeenCalledWith('+15555550199');
  });

  it('the other allowlisted test number also stashes as before', async () => {
    mockAuthAs('dispatcher');
    client.isOutboundAllowed.mockReturnValue(true);

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '+19294039424' });

    expect(res.status).toBe(202);
    expect(client.isOutboundAllowed).toHaveBeenCalledWith('+19294039424');
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
