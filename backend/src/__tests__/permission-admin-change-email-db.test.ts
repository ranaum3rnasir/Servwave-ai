/* =============================================================================
   Roles & Permissions, ticket 25 (finding M6, story 64): the Owner hears about every Admin change.

   Whenever anyone becomes an Admin or stops being one (the Admin switch, a move onto or off the Administrator role, a new
   person created as an Admin), the company's Owner gets an email saying who, by whom and when. A change that touches no Admin
   access sends nothing. The email names no vendor.

   The real routes and the real email module against a real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Only the mail provider's client (the edge) and the auth provider are replaced, so what "went out" is read back.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, providerSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    providerSend: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The real email module (the suite-wide setup replaces it), with a mail key so it builds its provider client.
vi.mock('../lib/email', async (importOriginal) => importOriginal());
vi.mock('../config/env', async () => ({
  env: {
    ...(await import('./test-env.js')).testEnv,
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'ServWave <noreply@mail.test.com>',
    MAILBOX_DOMAIN: 'staging.mail.test.com',
  },
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: providerSend };
  },
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

/** The name of a vendor must never appear in what the Owner reads. (Another company's name is checked in the first test, by the other company's own fixture name.) */
const NOT_IN_THE_EMAIL = /resend|supabase|stripe|calltracking|\bctm\b|render\.com|onrender|twilio|vercel/i;

interface Sent { from: string; to: string; subject: string; text: string; html: string }

suite('the Owner is emailed on every Admin change (real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 600_000);
  afterAll(() => fx.cleanup());
  beforeEach(() => {
    providerSend.mockReset().mockResolvedValue({ data: { id: 'msg_1' }, error: null });
  });

  /** The mail that went to this address. Waits for the alert, which is sent after the change commits. */
  async function mailTo(address: string, atLeast = 1): Promise<Sent[]> {
    const read = () => providerSend.mock.calls.map((c) => c[0] as Sent).filter((m) => m.to === address);
    for (let i = 0; i < 60 && read().length < atLeast; i++) await new Promise((r) => setTimeout(r, 50));
    // A short wait for mail that should not come, so "exactly" and "none" are real checks.
    await new Promise((r) => setTimeout(r, 200));
    return read();
  }

  const asOwner = (owner: Person) => fx.signedInAs(owner);

  it('someone is made an Admin with the switch: the Owner is told who, by whom and when, and no vendor is named', async () => {
    const { org, admin: owner } = await fx.newOrg();
    const { tag: otherCompany } = await fx.newOrg();
    const seller = await fx.addUser(org, 'Sam', 'SALES');
    expect((await (await asOwner(owner)).patch(`/api/users/${seller.id}`, { is_admin: true })).status).toBe(200);

    const mail = await mailTo(owner.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Sam Tester is now an Admin');
    expect(mail[0]!.text).toContain(`Test Admin made Sam Tester an Admin of switches-${org.slice(0, 8)}.`);
    for (const part of [mail[0]!.from, mail[0]!.subject, mail[0]!.text, mail[0]!.html]) expect(part).not.toMatch(NOT_IN_THE_EMAIL);
    // It names this company and no other one.
    for (const part of [mail[0]!.subject, mail[0]!.text, mail[0]!.html]) expect(part).not.toContain(otherCompany);
  });

  it('someone stops being an Admin (moved off the Administrator role): the Owner is told', async () => {
    const { org, admin: owner } = await fx.newOrg();
    const other = await fx.addUser(org, 'Alex', 'ADMIN');
    expect((await (await asOwner(owner)).patch(`/api/users/${other.id}`, { role: 'SALES' })).status).toBe(200);

    const mail = await mailTo(owner.email);
    expect(mail.map((m) => m.subject)).toEqual(['Alex Tester is no longer an Admin']);
    expect(mail[0]!.text).toContain('Test Admin took Admin access away from Alex Tester');
    for (const part of [mail[0]!.from, mail[0]!.subject, mail[0]!.text, mail[0]!.html]) expect(part).not.toMatch(NOT_IN_THE_EMAIL);
  });

  it('a new person is created as an Admin: the Owner is told', async () => {
    const { tag, admin: owner } = await fx.newOrg();
    (supabaseAdmin.auth.admin.createUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { user: { id: randomUUID() } }, error: null });
    const res = await (await asOwner(owner)).post('/api/users', {
      email: `new-${tag}@example.test`, password: 'a-long-password', first_name: 'Nova', last_name: 'Admin', role: 'SALES', is_admin: true,
    });
    expect(res.status).toBe(201);

    expect((await mailTo(owner.email)).map((m) => m.subject)).toEqual(['Nova Admin is now an Admin']);
  });

  it('a change that touches no Admin access (a role change, a name edit) sends the Owner nothing', async () => {
    const { org, admin: owner } = await fx.newOrg();
    const tech = await fx.addUser(org, 'Tia', 'TECHNICIAN');
    expect((await (await asOwner(owner)).patch(`/api/users/${tech.id}`, { role: 'DISPATCHER' })).status).toBe(200);
    expect((await (await asOwner(owner)).patch(`/api/users/${tech.id}`, { first_name: 'Tina' })).status).toBe(200);

    expect(await mailTo(owner.email, 0)).toEqual([]);
  });
});
