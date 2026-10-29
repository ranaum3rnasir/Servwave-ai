/**
 * An admin sends a password reset from Users & Teams (password reset spec §7, decision §9.4;
 * slice 07; conductor brief §3.2, §3.5, §3.8).
 *
 * Seams: the HTTP endpoint the row action calls (status + body), and what leaves the system: the
 * auth provider and the email sender are mocked at their boundaries (setup.ts). The users table and
 * the audit log are small in-memory fakes that honour the `where` they are given, so a lookup that
 * forgot the org scope would find the other org's user, and the per-email cap is a real count over
 * the rows the sends wrote. Every token is generated per run.
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
import { clearTokenCache } from '../middleware/authenticate';
import { settlePasswordResetWork } from '../lib/password-reset';
import { TEST_USERS, ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader, type TestUserKey } from './helpers';

const auth = supabaseAdmin.auth as unknown as {
  admin: { generateLink: Mock; updateUserById: Mock };
};
const sendEmail = sendPasswordResetEmail as unknown as Mock;

const VENDOR_WORDS = /supabase|gotrue|resend|render|vercel|identit|provider/i;

const person = (id: string, first: string, org: string, extra: Partial<FakeUser> = {}): FakeUser => ({
  id,
  email: `${first.toLowerCase()}@example.test`,
  first_name: first,
  last_name: 'Person',
  organization_id: org,
  is_active: true,
  has_login: true,
  ...extra,
});

interface FakeUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  organization_id: string;
  is_active: boolean;
  has_login: boolean;
}

const ANA = person('00000000-0000-4000-8000-0000000000a1', 'Ana', ALPHA_ORG_ID);
const NOLA = person('00000000-0000-4000-8000-0000000000a2', 'Nola', ALPHA_ORG_ID, { has_login: false });
const DEE = person('00000000-0000-4000-8000-0000000000a3', 'Dee', ALPHA_ORG_ID, { is_active: false, has_login: false });
// Deactivated but still flagged with a login (an older row): the active check alone must refuse it.
const DORA = person('00000000-0000-4000-8000-0000000000a4', 'Dora', ALPHA_ORG_ID, { is_active: false, has_login: true });
const BEA = person('00000000-0000-4000-8000-0000000000b1', 'Bea', ORG_B_ID);
const USERS = [ANA, NOLA, DEE, DORA, BEA];

interface AuditRow {
  org_id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}
let audit: AuditRow[];
let hashedToken: string;

type Where = {
  id?: string;
  organization_id?: string;
  email?: { equals: string };
  is_active?: boolean;
  has_login?: boolean;
};
const matches = (u: FakeUser, w: Where) =>
  (w.id === undefined || u.id === w.id) &&
  (w.organization_id === undefined || u.organization_id === w.organization_id) &&
  (w.email === undefined || u.email.toLowerCase() === w.email.equals.toLowerCase()) &&
  (w.is_active === undefined || u.is_active === w.is_active) &&
  (w.has_login === undefined || u.has_login === w.has_login);

function signInAs(key: TestUserKey) {
  mockAuthAs(key);
  // The target lookup must be org-scoped. This fake applies every condition it is given, so a
  // lookup by id alone would find a user in another org.
  (prisma.user.findFirst as Mock).mockImplementation(async ({ where }: { where: Where }) => USERS.find((u) => matches(u, where)) ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  audit = [];
  hashedToken = randomBytes(28).toString('hex');
  signInAs('admin');

  (prisma.$transaction as Mock).mockImplementation(async (fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: typeof prisma) => unknown)(prisma) : Promise.all(fn as unknown[]),
  );
  (prisma.$executeRaw as unknown as Mock).mockResolvedValue(1);
  (prisma.auditLog.create as Mock).mockImplementation(async ({ data }: { data: Omit<AuditRow, 'created_at'> }) => {
    audit.push({ ...data, metadata: data.metadata ?? {}, created_at: new Date() });
    return data;
  });
  (prisma.auditLog.count as Mock).mockImplementation(
    async ({ where }: { where: { resource_id: string; action: { in: string[] }; created_at?: { gte: Date } } }) =>
      audit.filter(
        (r) =>
          r.resource_id === where.resource_id &&
          where.action.in.includes(r.action) &&
          (!where.created_at || r.created_at >= where.created_at.gte),
      ).length,
  );
  auth.admin.generateLink.mockImplementation(async ({ email }: { email: string }) => ({
    data: { properties: { hashed_token: hashedToken }, user: { id: USERS.find((u) => u.email === email)?.id } },
    error: null,
  }));
  sendEmail.mockResolvedValue(true);
});

const sendReset = (id: string, as: TestUserKey = 'admin', body: Record<string, unknown> = {}) =>
  request(app).post(`/api/users/${id}/password-reset`).set(authHeader(as)).send(body);

const logged = () =>
  JSON.stringify([(logger.info as Mock).mock.calls, (logger.warn as Mock).mock.calls, (logger.error as Mock).mock.calls]);

const NOT_SENT = "We couldn't send the email. Try again or contact ServWave support.";

describe('POST /api/users/:id/password-reset — success', () => {
  it("emails the user the same reset link as Forgot password, and tells the admin where it went", async () => {
    const res = await sendReset(ANA.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, email: ANA.email });
    expect(auth.admin.generateLink).toHaveBeenCalledTimes(1);
    expect(auth.admin.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: ANA.email });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({
      to: ANA.email,
      firstName: ANA.first_name,
      resetUrl: `http://localhost:5173/reset-password?token=${hashedToken}`,
      organizationId: ALPHA_ORG_ID,
    });
  });

  it('audits that an admin sent it, with the actor, and no token or link', async () => {
    await sendReset(ANA.id);

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'user.password_reset_sent_by_admin',
      resource_type: 'User',
      resource_id: ANA.id,
      org_id: ALPHA_ORG_ID,
      actor_id: TEST_USERS.admin.id,
      actor_email: TEST_USERS.admin.email,
    });
    expect(JSON.stringify(audit)).not.toContain(hashedToken);
  });

  it('never hands the admin the token, the link or a password, and never logs the token', async () => {
    const res = await sendReset(ANA.id);

    expect(JSON.stringify(res.body)).not.toContain(hashedToken);
    expect(JSON.stringify(res.body)).not.toMatch(/token|password|reset-password|http/i);
    expect(logged()).not.toContain(hashedToken);
  });

  it('never sets a password, and ignores anything in the request body', async () => {
    const res = await sendReset(ANA.id, 'admin', { email: 'someone-else@example.test', password: randomBytes(12).toString('base64url') });

    expect(res.status).toBe(200);
    expect(auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ANA.email }));
    expect(JSON.stringify(sendEmail.mock.calls)).not.toContain('someone-else');
  });
});

describe('POST /api/users/:id/password-reset — who it can go to', () => {
  it.each([
    ['a user without a login', NOLA, "This person doesn't have a login. Send them an invite instead.", 'no_login'],
    ['a deactivated user', DEE, 'This person is deactivated. Reactivate them first.', 'user_inactive'],
    ['a deactivated user still flagged with a login', DORA, 'This person is deactivated. Reactivate them first.', 'user_inactive'],
  ])('answers 400 for %s, and sends and records nothing', async (_label, target, error, code) => {
    const res = await sendReset(target.id);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error, code });
    expect(auth.admin.generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).toHaveLength(0);
  });

  it("answers 404 for a user in another organization, and sends and records nothing", async () => {
    const res = await sendReset(BEA.id);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    expect(auth.admin.generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).toHaveLength(0);
  });

  it('answers 404 for an id that does not exist', async () => {
    const res = await sendReset('00000000-0000-4000-8000-00000000dead');

    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('answers the same 404 for an id that is not a uuid, without asking the database (review item 2)', async () => {
    // Like Postgres: a uuid column refuses a malformed id (Prisma P2023), which would be a 500.
    (prisma.user.findFirst as Mock).mockRejectedValue(Object.assign(new Error('Inconsistent column data'), { code: 'P2023' }));

    const res = await sendReset('not-a-uuid');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).toHaveLength(0);
  });
});

describe('POST /api/users/:id/password-reset — permission', () => {
  it.each<TestUserKey>(['sales', 'dispatcher', 'technician'])('answers 403 to a %s (no update User), and sends nothing', async (role) => {
    signInAs(role);

    const res = await sendReset(ANA.id, role);

    expect(res.status).toBe(403);
    expect(auth.admin.generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    // (A refused request may itself be audited; no send is.)
    expect(audit.filter((r) => r.action.startsWith('user.password_reset'))).toHaveLength(0);
  });

  it.each([
    ['an id that does not exist', '00000000-0000-4000-8000-00000000dead'],
    ['an id that is not a uuid', 'not-a-uuid'],
  ])('answers 403, not 404, to a role without update User for %s (review item 3)', async (_label, id) => {
    signInAs('sales');

    const res = await sendReset(id, 'sales');

    expect(res.status).toBe(403);
    expect(prisma.user.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id }) }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('needs a signed-in user', async () => {
    const res = await request(app).post(`/api/users/${ANA.id}/password-reset`).send({});

    expect(res.status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/users/:id/password-reset — the per-email limit', () => {
  const LIMIT_COPY =
    'This person has been sent 3 reset links in the last 15 minutes. Ask them to use the newest email, or try again in a few minutes.';

  it('stops a fourth link within 15 minutes, says so plainly, and sends nothing', async () => {
    for (let i = 0; i < 3; i++) expect((await sendReset(ANA.id)).status).toBe(200);
    sendEmail.mockClear();
    auth.admin.generateLink.mockClear();

    const res = await sendReset(ANA.id);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: LIMIT_COPY, code: 'reset_link_limit' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auth.admin.generateLink).not.toHaveBeenCalled();
    expect(audit).toHaveLength(3);
  });

  it("counts the user's own Forgot password requests against the same limit", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/password/forgot').send({ email: ANA.email });
      await settlePasswordResetWork();
    }
    expect(sendEmail).toHaveBeenCalledTimes(3);
    sendEmail.mockClear();

    const res = await sendReset(ANA.id);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('reset_link_limit');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an admin's sends use up the user's own Forgot password requests too", async () => {
    await sendReset(ANA.id);
    await sendReset(ANA.id);
    await request(app).post('/api/auth/password/forgot').send({ email: ANA.email });
    await settlePasswordResetWork();
    expect(sendEmail).toHaveBeenCalledTimes(3);
    sendEmail.mockClear();

    await request(app).post('/api/auth/password/forgot').send({ email: ANA.email });
    await settlePasswordResetWork();

    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit.map((r) => r.action)).toEqual([
      'user.password_reset_sent_by_admin',
      'user.password_reset_sent_by_admin',
      'user.password_reset_requested',
    ]);
  });

  it("is per person: one user at the limit does not block a send to another", async () => {
    const ella = person('00000000-0000-4000-8000-0000000000a5', 'Ella', ALPHA_ORG_ID);
    USERS.push(ella);
    try {
      for (let i = 0; i < 3; i++) await sendReset(ANA.id);
      expect((await sendReset(ella.id)).status).toBe(200);
    } finally {
      USERS.pop();
    }
  });
});

describe('POST /api/users/:id/password-reset — the email cannot go out', () => {
  it.each([
    ['the link cannot be minted', () => auth.admin.generateLink.mockResolvedValue({ data: null, error: { status: 500, message: 'Database error' } })],
    ['the email cannot be sent', () => sendEmail.mockResolvedValue(false)],
  ])('says so in ServWave words when %s', async (_label, arrange) => {
    arrange();

    const res = await sendReset(ANA.id);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: NOT_SENT, code: 'reset_link_not_sent' });
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_WORDS);
  });

  it('answers with the same ServWave copy if anything throws', async () => {
    (prisma.$transaction as Mock).mockRejectedValue(new Error('connection to supabase pooler lost'));

    const res = await sendReset(ANA.id);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: NOT_SENT, code: 'reset_link_not_sent' });
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_WORDS);
  });
});
