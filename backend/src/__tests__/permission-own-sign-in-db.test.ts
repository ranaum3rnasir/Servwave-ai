/* =============================================================================
   Roles & Permissions security, ticket 36b (M17), finding F1: a person's own sign-in is not company setup.

   The Login & Security page holds the company's two-step policy (an Admin's, saved with the company form) and each person's OWN
   sign-in: their email code and their password. Setting up the company became the Admin flag's alone, but a Technician,
   Dispatcher or Sales person must still change their own password. Called as people on custom roles (never a built-in role
   name) holding nothing and holding every switch at its widest, against a real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Only the auth provider's client is replaced (as in change-my-password.test.ts).
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The provider's own-session password update is the one outside call; it succeeds.
vi.mock('../lib/auth-own-session', () => ({ updatePasswordAsOwnSession: vi.fn().mockResolvedValue({ error: null }) }));

import { switchFixture } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';
import { ALL_ACCEPTED_METHODS, SWITCH_CATALOG, storableChoices, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

function everySwitchOn(): Record<string, SwitchValue> {
  return Object.fromEntries(
    SWITCH_CATALOG.map((s) => [s.key, s.kind === 'toggle' ? true : s.kind === 'choice' ? storableChoices(s).at(-1)! : ALL_ACCEPTED_METHODS]),
  );
}

suite('a person who is not an Admin keeps their own password and email code (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  const auth = supabaseAdmin.auth as unknown as { signInWithPassword: Mock; admin: { signOut: Mock } };
  beforeEach(() => {
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    auth.admin.signOut.mockResolvedValue({ error: null });
  });

  let sequence = 0;
  async function nonAdmin(values: Record<string, SwitchValue>) {
    const made = await fx.newOrg();
    const key = `own-role-${++sequence}`;
    const role = await fx.addCustomRole(made.org, key, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(made.org, key, values);
    const person = await fx.addUser(made.org, 'tech', 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
    await db.user.update({ where: { id: person.id }, data: { has_login: true } });
    return { ...made, person };
  }

  it.each([['holding nothing', {}], ['holding every switch at its widest', everySwitchOn()]] as const)(
    'lets a non-Admin %s read their sign-in methods, change their password, and read their email-code status', async (_label, values) => {
      const c = await nonAdmin(values);
      const api = async () => fx.signedInAs(c.person);

      expect((await (await api()).get('/api/users/me/password-status')).status).toBe(200);
      expect((await (await api()).get('/api/auth/mfa/status')).status).toBe(200);
      const changed = await (await api()).post('/api/users/me/password', { current_password: 'the-old-one-1', password: 'the-new-one-22' });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body.message).toBe('Password updated');
    },
  );

  it('still refuses the same non-Admin the company\'s two-step policy, which is saved with the company form', async () => {
    const c = await nonAdmin(everySwitchOn());
    const before = await db.organization.findUniqueOrThrow({ where: { id: c.org }, select: { mfa_sms_enabled: true } });
    const res = await (await fx.signedInAs(c.person)).patch('/api/organization', { mfa_sms_enabled: !before.mfa_sms_enabled });
    expect(res.status).toBe(403);
    expect((await db.organization.findUniqueOrThrow({ where: { id: c.org }, select: { mfa_sms_enabled: true } })).mfa_sms_enabled).toBe(before.mfa_sms_enabled);
    // ... and an Admin saves it.
    const saved = await (await fx.signedInAs(c.admin)).patch('/api/organization', { mfa_sms_enabled: !before.mfa_sms_enabled });
    expect(saved.status).toBe(200);
  });
});
