/* =============================================================================
   R&P security build, pre-PR review fixes (code review of rp/alignment @ 3f48023ef).

   Each block proves one confirmed finding through the real routes on a real migrated database, as people on custom roles
   holding exactly the switches under test (or the company's Admins and Owner):
     CR-4  a person id written any other way (capitals, no hyphens, braces) is still that person: the Owner and self checks
           cannot be stepped around;
     CR-5  reassigning a leaver's open records counts every slot it could not move, the lead walkthrough crew included;
     CR-7  a role edit that makes a person's own value equal to the role drops it, so the person follows the role again;
     CR-11 a hidden task names the Tasks scope in the access log, not the Jobs and Leads ones;
     (d)   a past estimate version shows no row figure to a person without See prices.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { resolveSwitches, setRoleSwitchValues } from '../lib/permissions/switches/store';
import { clearSwitchCacheForOrg } from '../lib/permissions/switches/cache';

const suite = realClient ? describe : describe.skip;

/** Every switch off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The other ways Postgres (and the client) read the same uuid. */
const spellings = (id: string) => ({
  capitals: id.toUpperCase(),
  'no hyphens': id.replace(/-/g, ''),
  braces: `{${id}}`,
});

suite('pre-PR review fixes (real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `prepr-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `pr${sequence}`, base, { customRoleId: role.id, basedOnRoleKey: key });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  // ─── CR-4 ────────────────────────────────────────────────────────────────────────────
  describe('CR-4: an id in another spelling is still the same person', () => {
    /** A company whose Owner has a second Admin beside them, so "the last Admin" never stands in the way. */
    async function company() {
      const made = await fx.newOrg();
      const second = await fx.addUser(made.org, `adm${++sequence}`, 'ADMIN');
      return { ...made, second };
    }
    const stillActive = async (p: Person) => (await db.user.findUniqueOrThrow({ where: { id: p.id }, select: { is_active: true } })).is_active;
    // Refused, whichever refusal answers first: the Owner rule (409), Owner-only (403), "not your own account" (400), or a route
    // that turns away an id not written the stored way (404). What matters is that nothing changes.
    const REFUSED = [400, 403, 404, 409];
    const expectRefused = (res: { status: number; body: unknown }, what: string) =>
      expect(REFUSED, `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);

    for (const how of Object.keys(spellings('')) as Array<keyof ReturnType<typeof spellings>>) {
      it(`the Owner cannot deactivate themselves by writing their own id with ${how}`, async () => {
        const c = await company();
        const raw = spellings(c.admin.id)[how];
        const res = await (await fx.signedInAs(c.admin)).delete(`/api/users/${encodeURIComponent(raw)}`, {});
        expectRefused(res, raw);
        expect(await stillActive(c.admin)).toBe(true);
      });
    }

    it('another Admin cannot deactivate the Owner whichever way the id is written', async () => {
      const c = await company();
      for (const raw of Object.values(spellings(c.admin.id))) {
        expectRefused(await (await fx.signedInAs(c.second)).delete(`/api/users/${encodeURIComponent(raw)}`, {}), raw);
      }
      expect(await stillActive(c.admin)).toBe(true);
    });

    it('an Admin cannot deactivate, erase or delete their own account by writing their own id in capitals', async () => {
      const c = await company();
      const third = await fx.addUser(c.org, `adm${++sequence}`, 'ADMIN');
      const own = c.second.id.toUpperCase();
      const api = await fx.signedInAs(c.second);
      expectRefused(await api.delete(`/api/users/${own}`, {}), 'deactivate');
      expect(await stillActive(c.second)).toBe(true);
      expectRefused(await (await fx.signedInAs(c.second)).post(`/api/users/${own}/erase-personal-data`), 'erase');
      expectRefused(await (await fx.signedInAs(c.second)).delete(`/api/users/${own}/permanent`), 'delete');
      expect((await db.user.findUniqueOrThrow({ where: { id: c.second.id } })).erased_at).toBeNull();
      expect(await db.user.count({ where: { id: c.second.id } })).toBe(1);
      expect(third.id).toBeTruthy();
    });

    it('the Owner is neither erased nor deleted whichever way the id is written', async () => {
      const c = await company();
      for (const raw of Object.values(spellings(c.admin.id))) {
        expectRefused(await (await fx.signedInAs(c.second)).post(`/api/users/${encodeURIComponent(raw)}/erase-personal-data`), `erase ${raw}`);
        expectRefused(await (await fx.signedInAs(c.second)).delete(`/api/users/${encodeURIComponent(raw)}/permanent`), `delete ${raw}`);
      }
      const owner = await db.user.findUniqueOrThrow({ where: { id: c.admin.id } });
      expect(owner.erased_at).toBeNull();
      expect(owner.is_active).toBe(true);
    });

    it('a non-Owner Admin cannot change another Admin\'s mailbox address by writing the id without hyphens', async () => {
      const c = await company();
      await fx.addUserMailbox(c.org, c.admin);
      const before = await db.mailboxAddress.findMany({ where: { organization_id: c.org }, select: { id: true, local_part: true } });
      const res = await (await fx.signedInAs(c.second)).put(`/api/users/${c.admin.id.replace(/-/g, '')}/mailbox-address`, { name_part: 'taken-over' });
      expectRefused(res, 'mailbox address');
      expect(await db.mailboxAddress.findMany({ where: { organization_id: c.org }, select: { id: true, local_part: true } })).toEqual(before);
    });

    it('reassign refuses the same person written two ways as both the leaver and the heir', async () => {
      const c = await company();
      const leaver = await fx.addUser(c.org, `lv${++sequence}`, 'DISPATCHER');
      const res = await (await fx.signedInAs(c.admin)).post(`/api/users/${leaver.id.toUpperCase()}/reassign`, { to_user_id: leaver.id, modules: ['tasks'] });
      expectRefused(res, 'reassign');
      expect(await db.auditLog.count({ where: { action: 'user.open_records_reassigned', resource_id: leaver.id } })).toBe(0);
    });
  });

  // ─── CR-5 ────────────────────────────────────────────────────────────────────────────
  describe('CR-5: reassign counts every slot it could not move', () => {
    it('a lead whose open walkthrough crew holds the leaver, given to someone who cannot be on a crew, is counted as skipped', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const leaver = await fx.addUser(org, `lv${++sequence}`, 'DISPATCHER');
      // The heir may own leads and be a dispatcher, but not be on a crew.
      const heir = await personWith(org, { can_own_leads: true, can_be_dispatcher: true, can_be_on_crew: false });
      const lead = await fx.addLead(org, customer, { walkthroughCrew: [leaver.id] });

      const res = await (await fx.signedInAs(admin)).post(`/api/users/${leaver.id}/reassign`, { to_user_id: heir.id, modules: ['leads'] });

      expect(res.status).toBe(200);
      expect(res.body.skipped.leads).toBe(1);
      expect(res.body.moved.leads).toBe(0);
      // The leaver is still on that walkthrough: nothing moved, and the answer says so.
      expect(await db.visitAssignee.count({ where: { visit_id: lead.walkthroughId!, user_id: leaver.id } })).toBe(1);
    });

    it('the same lead given to someone who can be on a crew is moved, and nothing is counted as skipped', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const leaver = await fx.addUser(org, `lv${++sequence}`, 'DISPATCHER');
      const heir = await personWith(org, { can_own_leads: true, can_be_dispatcher: true, can_be_on_crew: true });
      const lead = await fx.addLead(org, customer, { walkthroughCrew: [leaver.id] });

      const res = await (await fx.signedInAs(admin)).post(`/api/users/${leaver.id}/reassign`, { to_user_id: heir.id, modules: ['leads'] });

      expect(res.status).toBe(200);
      expect(res.body.moved.leads).toBe(1);
      expect(res.body.skipped.leads).toBe(0);
      expect(await db.visitAssignee.count({ where: { visit_id: lead.walkthroughId!, user_id: heir.id } })).toBe(1);
    });
  });

  // ─── CR-7 ────────────────────────────────────────────────────────────────────────────
  describe('CR-7: a role edit drops a person\'s own value once it equals the role', () => {
    it('the role turns a switch on (equal to the person\'s own value), then off again: the person follows the role', async () => {
      const { org, admin } = await fx.newOrg();
      const p = await personWith(org, { can_be_on_crew: false });
      // The person's own value: on, while the role is off.
      await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: p.id, switch_key: 'can_be_on_crew', value: true } });
      clearSwitchCacheForOrg(org);

      const on = await (await fx.signedInAs(admin)).put(`/api/roles/${p.roleKey}/permissions`, { values: { can_be_on_crew: true } });
      expect(on.status).toBe(200);
      // Equal to the role now: the person's own row is gone, and the history says the role edit removed it.
      expect(await db.permissionUserSwitch.count({ where: { user_id: p.id, switch_key: 'can_be_on_crew' } })).toBe(0);
      const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, target_type: 'USER', target_id: p.id, switch_key: 'can_be_on_crew' } });
      expect(log.map((l) => l.reason)).toEqual(['role edit']);

      const off = await (await fx.signedInAs(admin)).put(`/api/roles/${p.roleKey}/permissions`, { values: { can_be_on_crew: false } });
      expect(off.status).toBe(200);
      clearSwitchCacheForOrg(org);
      const user = await db.user.findUniqueOrThrow({ where: { id: p.id } });
      expect((await resolveSwitches(user)).can_be_on_crew).toBe(false);
    });

    it('counts the person as reached by the save that dropped their equal value', async () => {
      const { org, admin } = await fx.newOrg();
      const p = await personWith(org, { can_be_on_crew: false });
      await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: p.id, switch_key: 'can_be_on_crew', value: true } });
      clearSwitchCacheForOrg(org);

      const on = await (await fx.signedInAs(admin)).put(`/api/roles/${p.roleKey}/permissions`, { values: { can_be_on_crew: true } });

      expect(on.status).toBe(200);
      expect(on.body.reaches).toBe(1);
      expect(on.body.keep_own).toBe(0);
    });

    it('a person whose own choice still differs from the role\'s new one keeps it, and is counted as keeping their own', async () => {
      const { org, admin } = await fx.newOrg();
      const p = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
      await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: p.id, switch_key: 'jobs_scope', value: 'all' } });
      clearSwitchCacheForOrg(org);

      const res = await (await fx.signedInAs(admin)).put(`/api/roles/${p.roleKey}/permissions`, { values: { jobs_scope: 'team' } });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ reaches: 0, keep_own: 1 });
      expect((await db.permissionUserSwitch.findFirstOrThrow({ where: { user_id: p.id, switch_key: 'jobs_scope' } })).value).toBe('all');
    });

    it('a person whose own value still differs from the role keeps it (only an equal value is dropped)', async () => {
      const { org, admin } = await fx.newOrg();
      const p = await personWith(org, { can_be_on_crew: false, can_be_dispatcher: false });
      await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: p.id, switch_key: 'can_be_dispatcher', value: true } });
      clearSwitchCacheForOrg(org);

      const on = await (await fx.signedInAs(admin)).put(`/api/roles/${p.roleKey}/permissions`, { values: { can_be_on_crew: true } });

      expect(on.status).toBe(200);
      expect(await db.permissionUserSwitch.count({ where: { user_id: p.id, switch_key: 'can_be_dispatcher' } })).toBe(1);
    });
  });

  // ─── CR-11 ───────────────────────────────────────────────────────────────────────────
  describe('CR-11: a hidden record names its own scope switch in the access log', () => {
    it('a task out of reach writes access.hidden naming the Tasks scope', async () => {
      const { org, admin } = await fx.newOrg();
      const me = await personWith(org, { view_tasks: true, tasks_scope: 'attached' });
      const task = await db.task.create({
        data: { id: randomUUID(), organization_id: org, task_number: `T-${randomUUID().slice(0, 6)}`, title: 'Not mine', created_by: admin.id, assignee_ids: [admin.id], watcher_ids: [] },
      });

      const res = await (await me.api()).get(`/api/tasks/${task.id}`);
      expect(res.status).toBe(404);

      let rows: Awaited<ReturnType<typeof db.auditLog.findMany>> = [];
      for (let i = 0; i < 40 && rows.length === 0; i++) {
        rows = await db.auditLog.findMany({ where: { actor_id: me.id, action: 'access.hidden' } });
        if (!rows.length) await new Promise((r) => setTimeout(r, 50));
      }
      expect(rows).toHaveLength(1);
      expect((rows[0]!.metadata as { switches: string[] }).switches).toEqual(['tasks_scope']);
      await db.task.delete({ where: { id: task.id } });
    });
  });

  // ─── (d) a past estimate version ────────────────────────────────────────────────────
  describe('(d) a past estimate version, for a person without See prices', () => {
    it('carries no row figure; with See prices it carries them all', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const blind = await personWith(org, { view_estimates: true, view_leads: true, leads_scope: 'all', view_jobs: true, jobs_scope: 'all' });
      const seer = await personWith(org, { view_estimates: true, view_leads: true, leads_scope: 'all', view_jobs: true, jobs_scope: 'all', see_prices: true });
      const est = await fx.addEstimate(org, customer, admin.id);
      const row = {
        kind: 'line_item', key: 'l1', title: 'Install', detail: null, itemType: 'SERVICE', quantity: 2, unitPrice: 617,
        grossAmount: 1234, netAmount: 1234, optional: false, countsTowardTotals: true, discounted: false, photos: [],
        discountType: null, discountValue: null, discountAmount: null,
      };
      await db.estimateVersionSnapshot.create({
        data: {
          estimate_id: est.id, version: 1, total_amount: 1234, line_items: [], trigger: 'SEND', sent_at: new Date(),
          document: { view: { number: 'E-1', taxRate: 0, scopeNotes: null, rows: [row], hasLineItems: true, hasScopes: false, totals: [{ kind: 'total', label: 'Total', amount: 1234, negative: false }] }, customer: null },
        },
      });

      const blindRes = await (await blind.api()).get(`/api/estimates/${est.id}/versions/1`);
      expect(blindRes.status).toBe(200);
      expect(JSON.stringify(blindRes.body)).not.toContain('1234');
      expect(JSON.stringify(blindRes.body)).not.toContain('617');
      expect(blindRes.body.version.document.view.rows[0].title).toBe('Install');

      const seerRes = await (await seer.api()).get(`/api/estimates/${est.id}/versions/1`);
      expect(seerRes.status).toBe(200);
      expect(seerRes.body.version.document.view.rows[0]).toMatchObject({ netAmount: 1234, grossAmount: 1234, unitPrice: 617 });
    });
  });
});
