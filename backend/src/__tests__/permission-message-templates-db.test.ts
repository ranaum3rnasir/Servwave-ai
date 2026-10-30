/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.20 - who may change message templates and text automations.

   Message templates are created, changed and deleted with Edit communication records and read with View
   communication; text automations follow Create, Edit and Delete automations; assigning, archiving and snoozing an
   email conversation stays on Edit communication records.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in role
   name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { presetSwitchSet, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('message templates, text automations and email triage follow switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['text_automations', 'text_templates']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, SwitchValue>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `tpl-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { view_communication: true, access_communication: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const templateBody = () => ({ name: `Reminder ${randomUUID().slice(0, 6)}`, info: '', body: 'See you soon', audience: 'customer' });
  const idOf = (res: { body: { template?: { id: string }; automation?: { id: string }; id?: string } }) =>
    (res.body.template?.id ?? res.body.automation?.id ?? res.body.id) as string;

  describe('message templates', () => {
    it('refuses creating, changing and deleting a template without Edit communication records, whatever else is on, and for any base role', async () => {
      const { org, admin } = await newOrg();
      const adminApi = await fx.signedInAs(admin);
      const made = await adminApi.post('/api/communication/templates', templateBody());
      expect(made.status, 'an admin creates one to change').toBe(201);
      const existing = idOf(made);

      for (const base of ['ADMIN', 'TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(
          org,
          { edit_communication_records: false, contact_customers: true, delete_communication_records: true, attach_conversations: true },
          base,
        );
        const api = await without.api();
        expect((await api.post('/api/communication/templates', templateBody())).status, `${base} create`).toBe(403);
        expect((await api.patch(`/api/communication/templates/${existing}`, { body: 'Changed' })).status, `${base} change`).toBe(403);
        expect((await api.delete(`/api/communication/templates/${existing}`)).status, `${base} delete`).toBe(403);
      }
      expect(await db.textTemplate.count({ where: { id: existing } }), 'the template is untouched').toBe(1);
    });

    it('lets a person with Edit communication records alone create, change and delete a template', async () => {
      const { org } = await newOrg();
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const holder = await personWith(
          org,
          { edit_communication_records: true, contact_customers: false, office_phone_in_browser: false, delete_communication_records: false },
          base,
        );
        const api = await holder.api();
        const created = await api.post('/api/communication/templates', templateBody());
        expect(created.status, `${base} create`).toBe(201);
        const id = idOf(created);
        expect((await api.patch(`/api/communication/templates/${id}`, { body: 'Changed' })).status, `${base} change`).toBe(200);
        expect((await api.delete(`/api/communication/templates/${id}`)).status, `${base} delete`).toBe(200);
      }
    });

    it('keeps reading templates on View communication: no Edit communication records needed', async () => {
      const { org } = await newOrg();
      const reader = await personWith(org, { edit_communication_records: false, contact_customers: false, office_phone_in_browser: false });
      const res = await (await reader.api()).get('/api/communication/templates');
      expect(res.status).toBe(200);
    });
  });

  describe('email conversations', () => {
    it('refuses assign, archive and snooze without Edit communication records and lets them through with it', async () => {
      const { org } = await newOrg();
      const missing = randomUUID();
      const calls = (api: Api) => [
        ['assign', () => api.patch(`/api/communication/emails/threads/${missing}/assign`, {})],
        ['archive', () => api.patch(`/api/communication/emails/threads/${missing}/archive`, {})],
        ['snooze', () => api.patch(`/api/communication/emails/threads/${missing}/snooze`, {})],
      ] as const;

      const without = await personWith(org, { edit_communication_records: false, contact_customers: true, attach_conversations: true });
      const noApi = await without.api();
      for (const [name, run] of calls(noApi)) expect((await run()).status, `${name} without`).toBe(403);

      const holder = await personWith(org, { edit_communication_records: true });
      const api = await holder.api();
      for (const [name, run] of calls(api)) {
        const res = await run();
        expect(res.status, `${name} with`).not.toBe(403);
        expect(res.status, `${name} with`).not.toBe(401);
      }
    });
  });

  describe('text automations', () => {
    const body = (templateId: string) => ({ name: 'Day-before text', trigger: 'visit_scheduled', templateId, timing: '1 day before', audience: 'customer' });

    it("does not let a person on the Dispatcher preset's values create, edit or delete a text automation", async () => {
      const { org, admin } = await newOrg();
      const adminApi = await fx.signedInAs(admin);
      const templateId = idOf(await adminApi.post('/api/communication/templates', templateBody()));
      const made = await adminApi.post('/api/communication/automations', body(templateId));
      expect(made.status, 'an admin creates one to change').toBe(201);
      const existing = idOf(made);

      // Exactly the Dispatcher preset's values, on a custom role.
      const dispatcher = await personWith(org, presetSwitchSet('DISPATCHER'), 'DISPATCHER');
      const api = await dispatcher.api();
      expect((await api.post('/api/communication/automations', body(templateId))).status, 'create').toBe(403);
      expect((await api.patch(`/api/communication/automations/${existing}`, { name: 'Renamed' })).status, 'edit').toBe(403);
      expect((await api.delete(`/api/communication/automations/${existing}`)).status, 'delete').toBe(403);
      expect(await db.textAutomation.count({ where: { id: existing } }), 'the automation is untouched').toBe(1);
    });
  });
});
