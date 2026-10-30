/* =============================================================================
   Roles & Permissions security, M8 / D3 (ticket 36): payment instructions, main-mailbox readers and phone numbers are
   Admin-only; the rest of Company settings keeps working for a holder of the Company settings switch.

   Called as people on custom roles (never a built-in role name) holding exactly the switch values under test, against a real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The table is every route the guard test
   (permission-company-admin-only-guard.test.ts) declares Admin-only, so a route added there joins it.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

import { switchFixture } from './permission-switches-fixture';
import { ALL_ACCEPTED_METHODS, SWITCH_CATALOG, storableChoices, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch at its widest: each toggle on, each choice at its last (widest) storable value, each list at "all". */
function everySwitchOn(): Record<string, SwitchValue> {
  return Object.fromEntries(
    SWITCH_CATALOG.map((s) => [s.key, s.kind === 'toggle' ? true : s.kind === 'choice' ? storableChoices(s).at(-1)! : ALL_ACCEPTED_METHODS]),
  );
}

suite('payment instructions, main-mailbox readers and phone numbers are Admin-only (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  /** A company with a non-Admin on a custom role holding these switch values, a colleague, and one phone number. */
  async function company(values: Record<string, SwitchValue>) {
    const made = await fx.newOrg();
    const key = `co-role-${++sequence}`;
    const role = await fx.addCustomRole(made.org, key, 'DISPATCHER', { madeFromBlank: true });
    await db.permissionRoleSwitch.deleteMany({ where: { organization_id: made.org, role_key: key } });
    await fx.setRoleSwitches(made.org, key, values);
    const holder = await fx.addUser(made.org, 'holder', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key });
    const colleague = await fx.addUser(made.org, 'colleague', 'DISPATCHER');
    const number = await db.phoneNumber.create({
      data: { organization_id: made.org, e164: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, source: 'byo', status: 'active' },
    });
    return { ...made, holder, colleague, number };
  }
  type Co = Awaited<ReturnType<typeof company>>;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** Every Admin-only write and read, each with a body that would pass validation. */
  function adminOnlyRoutes(c: Co) {
    return [
      { method: 'patch', path: '/api/organization', body: { bank_transfer_instructions: 'Wire to account 000-TEST' } },
      { method: 'put', path: `/api/organization/email-sender/readers/${c.colleague.id}` },
      { method: 'delete', path: `/api/organization/email-sender/readers/${c.colleague.id}` },
      { method: 'get', path: '/api/organization/email-sender/readers/candidates' },
      { method: 'post', path: '/api/organization/phone/connect', body: { createNew: true, name: 'Test account' } },
      { method: 'post', path: '/api/organization/phone/check-texting-approval' },
      { method: 'post', path: '/api/organization/phone/disconnect' },
      { method: 'post', path: '/api/organization/connect-ctm', body: { createNew: true, name: 'Test account' } },
      { method: 'post', path: '/api/organization/connect-ctm/check-a2p' },
      { method: 'post', path: '/api/organization/disconnect-ctm' },
      { method: 'post', path: '/api/communication/numbers/search', body: { areacode: '617' } },
      { method: 'post', path: '/api/communication/numbers/buy', body: { phone_number: '+16175550100', forward_to_e164: '+16175550101' } },
      { method: 'post', path: '/api/communication/numbers/register-byo', body: { e164: '+16175550102' } },
      { method: 'post', path: '/api/communication/numbers/refresh' },
      { method: 'delete', path: `/api/communication/numbers/${c.number.id}` },
      { method: 'get', path: '/api/communication/number-assignments' },
      { method: 'put', path: `/api/communication/numbers/${c.number.id}/assignments`, body: { user_ids: [c.colleague.id] } },
      { method: 'put', path: `/api/communication/numbers/${c.number.id}/org-default`, body: { is_org_default: true } },
      { method: 'put', path: `/api/communication/users/${c.colleague.id}/default-number`, body: { phone_number_id: c.number.id } },
    ] as const;
  }
  const call = (api: Api, r: { method: string; path: string; body?: object }) =>
    r.method === 'get' ? api.get(r.path)
      : r.method === 'post' ? api.post(r.path, r.body)
        : r.method === 'put' ? api.put(r.path, r.body)
          : r.method === 'patch' ? api.patch(r.path, r.body)
            : api.delete(r.path, r.body);

  // A role holding nothing in particular: since 36b (M17) there is no switch that could open any of these.
  const COMPANY_SETTINGS_ONLY = {};

  it('refuses every one of them (403) to a non-Admin holding nothing, and to one holding every switch at its widest', async () => {
    for (const values of [COMPANY_SETTINGS_ONLY, everySwitchOn()]) {
      const c = await company(values);
      const before = {
        org: await db.organization.findUniqueOrThrow({ where: { id: c.org } }),
        numbers: await db.phoneNumber.findMany({ where: { organization_id: c.org }, orderBy: { id: 'asc' } }),
        links: await db.userPhoneNumber.count({ where: { phone_number: { organization_id: c.org } } }),
        readers: await db.mailboxReader.count({ where: { organization_id: c.org } }),
      };
      const letIn: string[] = [];
      for (const r of adminOnlyRoutes(c)) {
        const res = await call(await fx.signedInAs(c.holder), r);
        if (res.status !== 403) letIn.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
      }
      expect(letIn).toEqual([]);
      // Nothing moved.
      expect((await db.organization.findUniqueOrThrow({ where: { id: c.org } })).bank_transfer_instructions).toBe(before.org.bank_transfer_instructions);
      expect(await db.phoneNumber.findMany({ where: { organization_id: c.org }, orderBy: { id: 'asc' } })).toEqual(before.numbers);
      expect(await db.userPhoneNumber.count({ where: { phone_number: { organization_id: c.org } } })).toBe(before.links);
      expect(await db.mailboxReader.count({ where: { organization_id: c.org } })).toBe(before.readers);
    }
  });

  it('lets an Admin through the same routes (nothing answers 403)', async () => {
    const c = await company(COMPANY_SETTINGS_ONLY);
    const refused: string[] = [];
    for (const r of adminOnlyRoutes(c)) {
      const res = await call(await fx.signedInAs(c.admin), r);
      if (res.status === 403) refused.push(`${r.method.toUpperCase()} ${r.path}`);
    }
    expect(refused).toEqual([]);
  });

  describe('payment instructions inside the company form', () => {
    it('are saved for an Admin, and the Admin can clear them', async () => {
      const c = await company(COMPANY_SETTINGS_ONLY);
      const saved = await (await fx.signedInAs(c.admin)).patch('/api/organization', { bank_transfer_instructions: 'Wire to 000-TEST' });
      expect(saved.status).toBe(200);
      expect((await db.organization.findUniqueOrThrow({ where: { id: c.org } })).bank_transfer_instructions).toBe('Wire to 000-TEST');
      const cleared = await (await fx.signedInAs(c.admin)).patch('/api/organization', { bank_transfer_instructions: '' });
      expect(cleared.status).toBe(200);
      expect((await db.organization.findUniqueOrThrow({ where: { id: c.org } })).bank_transfer_instructions).toBeNull();
    });

    it('cannot be changed or cleared by a non-Admin, and a form that carries them changes nothing else either', async () => {
      const c = await company(everySwitchOn());
      await db.organization.update({ where: { id: c.org }, data: { bank_transfer_instructions: 'Wire to 000-TEST' } });
      const before = await db.organization.findUniqueOrThrow({ where: { id: c.org } });
      for (const body of [
        { bank_transfer_instructions: 'Wire to my account' },
        { bank_transfer_instructions: '' },
        { bank_transfer_instructions: null },
        { name: 'Renamed by the holder', bank_transfer_instructions: 'Wire to my account' },
      ]) {
        const res = await (await fx.signedInAs(c.holder)).patch('/api/organization', body);
        expect(res.status, JSON.stringify(body)).toBe(403);
        expect(res.body.error).toBe('Only an Admin can change company settings.');
      }
      const after = await db.organization.findUniqueOrThrow({ where: { id: c.org } });
      expect(after.bank_transfer_instructions).toBe('Wire to 000-TEST');
      expect(after.name).toBe(before.name);
    });

    it('cannot be changed through another spelling of the address either', async () => {
      const c = await company(everySwitchOn());
      const api = await fx.signedInAs(c.holder);
      for (const path of ['/api/organization/', '/api/Organization', '/api/ORGANIZATION/']) {
        const res = await api.patch(path, { bank_transfer_instructions: 'Wire to my account' });
        expect(res.status, path).toBe(403);
      }
      expect((await db.organization.findUniqueOrThrow({ where: { id: c.org } })).bank_transfer_instructions).toBeNull();
    });

    it('cannot be written through the generic setting address either', async () => {
      const c = await company(everySwitchOn());
      await db.organization.update({ where: { id: c.org }, data: { bank_transfer_instructions: 'Wire to 000-TEST' } });
      const res = await (await fx.signedInAs(c.holder)).patch('/api/settings/bank_transfer_instructions', { value: 'Wire to my account' });
      expect(res.status).not.toBe(200);
      expect((await db.organization.findUniqueOrThrow({ where: { id: c.org } })).bank_transfer_instructions).toBe('Wire to 000-TEST');
    });
  });

  describe('the rest of the company form is an Admin\'s too (36b, M17)', () => {
    it('refuses a non-Admin the company form without payment instructions, a lead source and a job type', async () => {
      const c = await company(everySwitchOn());
      const api = async () => fx.signedInAs(c.holder);
      const before = await db.organization.findUniqueOrThrow({ where: { id: c.org } });
      expect((await (await api()).patch('/api/organization', { name: 'Renamed by the holder', phone: '555-0100' })).status).toBe(403);
      expect((await (await api()).post('/api/lead-sources', { name: `src-${randomUUID().slice(0, 6)}` })).status).toBe(403);
      expect((await (await api()).post('/api/job-types', { name: `type-${randomUUID().slice(0, 6)}` })).status).toBe(403);
      expect((await (await api()).get('/api/organization/email-sender/readers')).status).toBe(403);
      expect((await db.organization.findUniqueOrThrow({ where: { id: c.org } })).name).toBe(before.name);
    });
  });
});
