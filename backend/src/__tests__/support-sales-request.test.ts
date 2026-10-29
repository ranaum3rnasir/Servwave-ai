// The Phone header's "Reach sales" composer used to toast and throw the message
// away - nothing left the browser. It now posts here, and the recipient is
// server-owned: the client never names a destination, so the composer cannot be
// turned into an open relay by a crafted request body.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

async function salesSender() {
  const { sendSalesContactEmail } = await import('../lib/email.js');
  return sendSalesContactEmail as unknown as ReturnType<typeof vi.fn>;
}

describe('POST /api/support/sales-request', () => {
  it('sends the composed message to info@servwave.com', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'sent' });

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({
        subject: 'Raise call limits (Main)',
        message: 'We keep hitting the calling allowance.',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'sent', to: 'info@servwave.com' });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.to).toBe('info@servwave.com');
    expect(arg.organizationId).toBe(ALPHA_ORG_ID);
    expect(arg.subject).toBe('Raise call limits (Main)');
    expect(arg.message).toBe('We keep hitting the calling allowance.');
    // Not supplied by the client any more - a reply goes to the account that wrote in.
    expect(arg.replyTo).toBe(TEST_USERS.admin.email);
  });

  it('tells the inbox who sent it - user, org and role come off the session', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'sent' });

    await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello' });

    const arg = send.mock.calls[0][0];
    expect(arg.sender).toEqual({
      id: TEST_USERS.admin.id,
      name: 'Test Admin',
      email: TEST_USERS.admin.email,
      role: 'ADMIN',
    });
    expect(arg.organizationId).toBe(ALPHA_ORG_ID);
  });

  it('passes on what they are asking about', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'sent' });

    await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello', topic: 'limits' });

    expect(send.mock.calls[0][0].topic).toBe('limits');
  });

  it('treats a message with no preset topic as a custom one, not a failure', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'sent' });

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello' });

    expect(res.status).toBe(200);
    expect(send.mock.calls[0][0].topic).toBeNull();
  });

  it('rejects a topic that is not one of the composer\'s presets', async () => {
    mockAuthAs('admin');
    const send = await salesSender();

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello', topic: 'free-text' });

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores any recipient the client tries to supply', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'sent' });

    await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({
        subject: 'Hi',
        message: 'Hello',
        to: 'attacker@evil.com',
      });

    expect(send.mock.calls[0][0].to).toBe('info@servwave.com');
  });

  it('reports a provider failure instead of claiming the message was sent', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'failed', error: 'provider rejected' });

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
  });

  it('reports a skipped dispatch (kill switch / no mailer) rather than a silent success', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'skipped', reason: 'no_api_key' });

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello' });

    expect(res.status).toBe(502);
  });

  // A suppressed recipient is a deliberate, permanent policy block: our sales
  // inbox hard-bounced or complained, so the next attempt fails identically.
  // Telling the owner to "try again shortly" sends them round a loop that
  // cannot end - the same false promise the org kill switch used to make.
  it('reports a suppressed recipient as a 409 and does not tell the owner to retry', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'skipped', reason: 'suppressed' });

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/info@servwave\.com/);
    expect(res.body.error).not.toMatch(/try again/i);
  });

  // The org's own email kill switch can no longer reach this sender at all
  // (lib/email.ts bypassOrgSendingGate), so a controller that still mapped
  // org_disabled would be describing a state that cannot occur. A genuine
  // upstream fault stays a 502 that IS worth retrying.
  it('still reports a provider outage as a retryable 502', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'skipped', reason: 'no_api_key' });

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/try again/i);
  });

  it('rejects an empty message', async () => {
    mockAuthAs('admin');
    const send = await salesSender();

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: '   ' });

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores any reply address the client tries to supply', async () => {
    mockAuthAs('admin');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'sent' });

    await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('admin'))
      .send({ subject: 'Hi', message: 'Hello', replyTo: 'attacker@evil.com' });

    expect(send.mock.calls[0][0].replyTo).toBe(TEST_USERS.admin.email);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/support/sales-request')
      .send({ subject: 'Hi', message: 'Hello' });

    expect(res.status).toBe(401);
  });

  it('is open to every role - a technician can still reach sales', async () => {
    mockAuthAs('technician');
    const send = await salesSender();
    send.mockResolvedValue({ status: 'sent' });

    const res = await request(app)
      .post('/api/support/sales-request')
      .set(authHeader('technician'))
      .send({ subject: 'Hi', message: 'Hello' });

    expect(res.status).toBe(200);
  });
});
