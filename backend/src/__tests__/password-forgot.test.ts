/**
 * POST /api/auth/password/forgot - ask for a reset link (password reset spec §5.2, slice 04;
 * conductor brief §3.1 enumeration, §3.2 rate limits, §3.8 audit).
 *
 * Seams: the HTTP response (status, body, timing) and what leaves the system - the email sender and
 * the auth provider are mocked at their boundaries. The users table and the audit log are small
 * in-memory fakes, because the per-email cap is a count over the audit log. Every token is
 * generated per run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';

import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { sendPasswordResetEmail } from '../lib/email';
import { settlePasswordResetWork, FORGOT_RESPONSE_DELAY_MS } from '../lib/password-reset';
import { TEST_USERS } from './helpers';

const admin = supabaseAdmin.auth.admin as unknown as { generateLink: Mock };
const sendEmail = sendPasswordResetEmail as unknown as Mock;

interface FakeUser {
  id: string;
  email: string;
  first_name: string;
  organization_id: string;
  is_active: boolean;
  has_login: boolean;
}
interface AuditRow {
  org_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const ORG_ID = TEST_USERS.admin.organization_id;
const ACTIVE: FakeUser = {
  id: 'b0000000-0000-4000-8000-000000000001',
  email: 'dana@example.test',
  first_name: 'Dana',
  organization_id: ORG_ID,
  is_active: true,
  has_login: true,
};
const DEACTIVATED: FakeUser = { ...ACTIVE, id: 'b0000000-0000-4000-8000-000000000002', email: 'gone@example.test', is_active: false };
// Revoking a login deletes the auth account and clears has_login (user.controller revokeLogin).
const REVOKED: FakeUser = { ...ACTIVE, id: 'b0000000-0000-4000-8000-000000000003', email: 'revoked@example.test', has_login: false };

let users: FakeUser[];
let audit: AuditRow[];
let hashedToken: string;

type Where = Record<string, unknown> & { email?: { equals?: string; mode?: string } | string };

beforeEach(() => {
  vi.clearAllMocks();
  users = [ACTIVE, DEACTIVATED, REVOKED];
  audit = [];
  hashedToken = randomBytes(28).toString('hex');

  (prisma.user.findFirst as Mock).mockImplementation(async ({ where }: { where: Where }) => {
    const wanted = typeof where.email === 'string' ? where.email : where.email?.equals;
    const insensitive = typeof where.email === 'object' && where.email?.mode === 'insensitive';
    return (
      users.find(
        (u) =>
          (insensitive ? u.email.toLowerCase() === wanted?.toLowerCase() : u.email === wanted) &&
          (where.is_active === undefined || u.is_active === where.is_active) &&
          (where.has_login === undefined || u.has_login === where.has_login),
      ) ?? null
    );
  });
  (prisma.$transaction as Mock).mockImplementation(async (fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: typeof prisma) => unknown)(prisma) : Promise.all(fn as unknown[]),
  );
  (prisma.$executeRaw as unknown as Mock).mockResolvedValue(1);
  (prisma.auditLog.create as Mock).mockImplementation(async ({ data }: { data: Omit<AuditRow, 'created_at'> }) => {
    audit.push({ ...data, created_at: new Date() });
    return data;
  });
  (prisma.auditLog.count as Mock).mockImplementation(
    async ({ where }: { where: { resource_id: string; action: { in: string[] }; created_at: { gte: Date } } }) =>
      audit.filter(
        (r) => r.resource_id === where.resource_id && where.action.in.includes(r.action) && r.created_at >= where.created_at.gte,
      ).length,
  );
  admin.generateLink.mockImplementation(async () => ({
    data: { properties: { hashed_token: hashedToken, action_link: `https://auth.example.test/verify?token=${hashedToken}` }, user: {} },
    error: null,
  }));
  sendEmail.mockResolvedValue(true);
});

async function forgot(email: unknown, ip = '198.51.100.7') {
  const res = await request(app).post('/api/auth/password/forgot').set('X-Forwarded-For', ip).send({ email });
  await settlePasswordResetWork();
  return res;
}

/** Every string the logger was handed, flattened. */
const logged = () =>
  JSON.stringify([(logger.info as Mock).mock.calls, (logger.warn as Mock).mock.calls, (logger.error as Mock).mock.calls]);

describe('POST /api/auth/password/forgot', () => {
  it('emails an active user with a login one link to the reset page', async () => {
    const res = await forgot(ACTIVE.email);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(admin.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: ACTIVE.email });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({
      to: ACTIVE.email,
      firstName: 'Dana',
      resetUrl: `http://localhost:5173/reset-password?token=${hashedToken}`,
      organizationId: ORG_ID,
    });
  });

  it('matches the email whatever its case and surrounding spaces', async () => {
    await forgot('  DANA@Example.TEST ');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(admin.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: ACTIVE.email });
  });

  it.each([
    ['an unknown email', 'nobody@example.test'],
    ['a deactivated user', DEACTIVATED.email],
    ['a user whose login was revoked', REVOKED.email],
  ])('answers %s exactly as a known one, and sends nothing', async (_label, email) => {
    const known = await forgot(ACTIVE.email);
    vi.clearAllMocks();

    const other = await forgot(email);

    expect(other.status).toBe(known.status);
    expect(other.body).toEqual(known.body);
    expect(other.headers['content-type']).toBe(known.headers['content-type']);
    expect(other.headers['content-length']).toBe(known.headers['content-length']);
    expect(admin.generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects something that is not an email address', async () => {
    for (const bad of ['not-an-email', '', 42, undefined]) {
      const res = await forgot(bad);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Enter a valid email address.');
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('records the request in the audit log for a matched user, without the token', async () => {
    await forgot(ACTIVE.email);

    const rows = audit.filter((r) => r.action === 'user.password_reset_requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: ORG_ID, resource_type: 'User', resource_id: ACTIVE.id });
    expect(JSON.stringify(rows[0])).not.toContain(hashedToken);
  });

  it('records nothing for an email that matched no one', async () => {
    await forgot('nobody@example.test');
    expect(audit).toHaveLength(0);
  });

  it('never writes the link or its token to a log line', async () => {
    await forgot(ACTIVE.email);
    expect(logged()).not.toContain(hashedToken);
  });

  describe('per-email limit: at most 3 links per 15 minutes, across every IP', () => {
    it('a fourth request gets the same answer and sends no email', async () => {
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push(await forgot(ACTIVE.email, `198.51.100.${i + 1}`));

      expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(new Set(answers.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(sendEmail).toHaveBeenCalledTimes(3);
      expect(admin.generateLink).toHaveBeenCalledTimes(3);
    });

    it('counts links an admin sent', async () => {
      for (let i = 0; i < 3; i++) {
        audit.push({
          org_id: ORG_ID,
          actor_id: 'admin-id',
          action: 'user.password_reset_sent_by_admin',
          resource_type: 'User',
          resource_id: ACTIVE.id,
          metadata: {},
          created_at: new Date(),
        });
      }

      const res = await forgot(ACTIVE.email);

      expect(res.status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('requests older than 15 minutes no longer count', async () => {
      for (let i = 0; i < 3; i++) {
        audit.push({
          org_id: ORG_ID,
          actor_id: ACTIVE.id,
          action: 'user.password_reset_requested',
          resource_type: 'User',
          resource_id: ACTIVE.id,
          metadata: {},
          created_at: new Date(Date.now() - 16 * 60 * 1000),
        });
      }

      await forgot(ACTIVE.email);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("one user's limit does not hold back another user's link", async () => {
      const other: FakeUser = { ...ACTIVE, id: 'b0000000-0000-4000-8000-000000000009', email: 'sam@example.test' };
      users.push(other);
      for (let i = 0; i < 4; i++) await forgot(ACTIVE.email);
      vi.clearAllMocks();
      sendEmail.mockResolvedValue(true);

      await forgot(other.email);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('timing does not tell a known email from an unknown one', () => {
    it('neither answer comes back before the fixed delay', async () => {
      for (const email of [ACTIVE.email, 'nobody@example.test']) {
        const started = Date.now();
        await request(app).post('/api/auth/password/forgot').send({ email });
        expect(Date.now() - started).toBeGreaterThanOrEqual(FORGOT_RESPONSE_DELAY_MS - 5);
      }
      await settlePasswordResetWork();
    });

    it('a slow mail provider does not hold the answer back', async () => {
      let release!: () => void;
      sendEmail.mockImplementation(() => new Promise<boolean>((resolve) => (release = () => resolve(true))));

      const started = Date.now();
      const res = await request(app).post('/api/auth/password/forgot').send({ email: ACTIVE.email });

      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(FORGOT_RESPONSE_DELAY_MS + 1500);
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled());
      release();
      await settlePasswordResetWork();
    });
  });

  it('still answers the same when the auth provider cannot mint a link', async () => {
    admin.generateLink.mockResolvedValue({ data: null, error: { status: 500, message: 'boom' } });

    const res = await forgot(ACTIVE.email);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still answers the same when the email cannot be sent', async () => {
    sendEmail.mockResolvedValue(false);

    const res = await forgot(ACTIVE.email);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('still answers the same when the lookup itself fails', async () => {
    (prisma.user.findFirst as Mock).mockRejectedValue(new Error('db down'));

    const res = await forgot(ACTIVE.email);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
