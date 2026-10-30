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
  // PRD 10 (S10.11): the line the compose surfaces show is the SENDER'S OWN identity - the address and display name a
  // hand-written email from them would carry, resolved from the register by the same function the dispatch uses.
  const ownMailbox = (extra: Record<string, unknown> = {}) => ({
    id: 'own-mailbox-id',
    status: 'active',
    addresses: [{ local_part: 'jane.smith.acme' }],
    user: { first_name: 'Jane', last_name: 'Smith' },
    organization: { name: 'Acme Plumbing' },
    ...extra,
  });

  async function orgSending(sendingEnabled: boolean) {
    const { orgSendingIdentity } = await import('../lib/email.js');
    (orgSendingIdentity as any).mockResolvedValue({ address: 'acme@mail.test.com', name: 'Acme Plumbing', sendingEnabled });
    return orgSendingIdentity as any;
  }

  it('reports the person\'s own address and "<name> at <company>", not the company\'s', async () => {
    mockAuthAs('admin');
    await orgSending(true);
    p.mailbox.findFirst.mockResolvedValueOnce(ownMailbox());

    const res = await request(app).get('/api/communication/sending-identity').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'active',
      address: 'jane.smith.acme@mail.test.com',
      name: 'Jane Smith at Acme Plumbing',
      sendingEnabled: true,
    });
  });

  it('says "address needed", with no address, for a person who has none yet', async () => {
    mockAuthAs('admin');
    await orgSending(true);
    p.mailbox.findFirst.mockResolvedValueOnce(ownMailbox({ status: 'address_needed', addresses: [] }));

    const res = await request(app).get('/api/communication/sending-identity').set(authHeader('admin'));

    expect(res.body).toEqual({ status: 'address_needed', address: null, name: null, sendingEnabled: true });
  });

  it('says "address needed" for a person with no mailbox at all', async () => {
    mockAuthAs('admin');
    await orgSending(true);
    p.mailbox.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/communication/sending-identity').set(authHeader('admin'));

    expect(res.body).toMatchObject({ status: 'address_needed', address: null });
  });

  it('says sending is off rather than showing an address that will not send', async () => {
    // An org with email_sending_enabled=false has a perfectly well-formed From
    // address and still cannot send. Showing it unqualified would be the same
    // class of lie as "No mailbox connected" in the other direction.
    mockAuthAs('admin');
    await orgSending(false);
    p.mailbox.findFirst.mockResolvedValueOnce(ownMailbox());

    const res = await request(app).get('/api/communication/sending-identity').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.sendingEnabled).toBe(false);
  });

  it('resolves the person and the org from the token, never from the request', async () => {
    mockAuthAs('admin');
    const orgSendingIdentity = await orgSending(true);
    p.mailbox.findFirst.mockResolvedValueOnce(ownMailbox());

    await request(app)
      .get('/api/communication/sending-identity?organization_id=someone-else&user_id=someone-else')
      .set(authHeader('admin'));

    expect(orgSendingIdentity.mock.calls[0][0]).toBe(ALPHA_ORG_ID);
    expect(p.mailbox.findFirst.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID, user_id: expect.any(String) });
    expect(p.mailbox.findFirst.mock.calls[0][0].where.user_id).not.toBe('someone-else');
  });

  it('401s without auth', async () => {
    const res = await request(app).get('/api/communication/sending-identity');
    expect(res.status).toBe(401);
  });
});
