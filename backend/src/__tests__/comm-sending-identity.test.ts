// The compose surfaces used to render a flat "No mailbox connected". That was
// honest when it was written - there was no per-org sending identity to show,
// and inventing one would have been the dishonesty SRVW-88 set out to remove.
//
// It stopped being true once every org got a real From address (the shared
// sending domain, or its own once verified). The label was then telling an
// owner that sending was impossible while the send path worked fine. The fix is
// not to drop the honesty rule but to feed it the truth, which needs an
// endpoint that reports the SAME address a send would actually use.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('GET /api/communication/sending-identity', () => {
  it('reports the shared-domain address built from the org name', async () => {
    mockAuthAs('admin');
    const { orgSendingIdentity } = await import('../lib/email.js');
    (orgSendingIdentity as any).mockResolvedValue({
      address: 'northwind@mail.servwave.com',
      name: 'Northwind Services',
      sendingEnabled: true,
    });

    const res = await request(app)
      .get('/api/communication/sending-identity')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      address: 'northwind@mail.servwave.com',
      name: 'Northwind Services',
      sendingEnabled: true,
    });
  });

  it('says sending is off rather than showing an address that will not send', async () => {
    // An org with email_sending_enabled=false has a perfectly well-formed From
    // address and still cannot send. Showing it unqualified would be the same
    // class of lie as "No mailbox connected" in the other direction.
    mockAuthAs('admin');
    const { orgSendingIdentity } = await import('../lib/email.js');
    (orgSendingIdentity as any).mockResolvedValue({
      address: 'northwind@mail.servwave.com',
      name: 'Northwind Services',
      sendingEnabled: false,
    });

    const res = await request(app)
      .get('/api/communication/sending-identity')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.sendingEnabled).toBe(false);
  });

  it('resolves the org from the token, never from the request', async () => {
    mockAuthAs('admin');
    const { orgSendingIdentity } = await import('../lib/email.js');
    (orgSendingIdentity as any).mockResolvedValue({
      address: 'northwind@mail.servwave.com',
      name: 'Northwind Services',
      sendingEnabled: true,
    });

    await request(app)
      .get('/api/communication/sending-identity?organization_id=someone-else')
      .set(authHeader('admin'));

    expect((orgSendingIdentity as any).mock.calls[0][0]).toBe(ALPHA_ORG_ID);
  });

  it('401s without auth', async () => {
    const res = await request(app).get('/api/communication/sending-identity');
    expect(res.status).toBe(401);
  });
});
