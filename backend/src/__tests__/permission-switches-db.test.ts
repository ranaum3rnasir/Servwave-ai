/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.1 - the tracer: one switch (Apply discounts) through the
   switch catalog, the per-person store, the compile path into the ability layer and a server check.

   Everything goes through the public interface: the catalog read, the user update that gives a
   person a role, and the estimate and invoice routes. Real migrated database (TEST_DATABASE_URL);
   the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
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
import { SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { resolveSwitches, setRoleSwitchValues, readChangeLog, UnknownSwitchError } from '../lib/permissions/switches/store';

const APPLY_DISCOUNTS = 'apply_discounts';

const suite = realClient ? describe : describe.skip;

suite('permission switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  describe('the catalog read', () => {
    it('answers any signed-in person with Apply discounts: key, module, label, help text, kind, Requires and its four preset values', async () => {
      const { org } = await fx.newOrg();
      const technician = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const res = await (await fx.signedInAs(technician)).get('/api/permission-switches/catalog');

      expect(res.status).toBe(200);
      const entry = res.body.switches.find((s: { key: string }) => s.key === 'apply_discounts');
      expect(entry).toMatchObject({
        key: 'apply_discounts',
        module: 'Estimates',
        label: 'Apply discounts',
        kind: 'toggle',
        requires: [],
        presets: { ADMIN: true, SALES: true, DISPATCHER: false, TECHNICIAN: false },
      });
      expect(typeof entry.helpText).toBe('string');
      expect(entry.helpText.length).toBeGreaterThan(0);
      // What the screens read is what the server enforces from: the same catalog entry.
      const source = SWITCH_CATALOG.find((s) => s.key === 'apply_discounts')!;
      expect(entry.presets).toEqual(source.presets);
      expect(entry.helpText).toBe(source.helpText);
    });

    it('is refused to someone who is not signed in', async () => {
      const app = (await import('../app.js')).default as never;
      const request = (await import('supertest')).default;
      expect((await request(app).get('/api/permission-switches/catalog')).status).toBe(401);
    });

    it('names no vendor in any label or help text', () => {
      const text = SWITCH_CATALOG.map((s) => `${s.label} ${s.helpText}`).join(' ');
      // "resend" the verb (resend an invoice) is ordinary copy; the capitalised vendor name is not.
      expect(text).not.toMatch(/stripe|twilio|supabase|\brender\b|ctm|calltracking/i);
      expect(text).not.toMatch(/\bResend\b/);
    });
  });

  /** The permission view of a person the way the auth layer loads them. */
  async function permissionUser(person: Person) {
    const row = await db.user.findUniqueOrThrow({
      where: { id: person.id },
      select: { id: true, role: true, is_admin: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } } },
    });
    return row;
  }

  /** Dispatcher-based custom role that may also edit estimates; its Apply discounts value is the preset's (off). */
  async function officeRole(org: string, key = 'office') {
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { edit_estimates: true }, actorId: null, reason: 'manual' });
    return role;
  }

  describe('Apply discounts on the server', () => {
    it('refuses a discount change on an estimate and on an invoice for a custom role based on Dispatcher, and lets a plain line edit through', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const role = await officeRole(org);
      const person = await fx.addUser(org, 'office', 'DISPATCHER', { customRoleId: role.id });
      const estimate = await fx.addEstimate(org, customer, admin.id);
      const invoice = await fx.addInvoice(org, customer);
      const api = await fx.signedInAs(person);

      // Opening both is fine; only the discount is refused.
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect((await api.get(`/api/invoices/${invoice.id}`)).status).toBe(200);

      const estimateDiscount = await api.patch(`/api/estimates/${estimate.id}`, { discount_type: 'PERCENTAGE', discount_value: 10 });
      expect(estimateDiscount.status).toBe(403);
      const invoiceDiscount = await api.patch(`/api/invoices/${invoice.id}/billing`, { discount_amount: 5 });
      expect(invoiceDiscount.status).toBe(403);
      expect((await db.estimate.findUniqueOrThrow({ where: { id: estimate.id } })).discount_type).toBeNull();
      expect(Number((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).discount_amount)).toBe(0);

      // A plain line edit, with no discount change, passes - including one that echoes the line's
      // own (empty) discount back the way the edit form does.
      expect((await api.patch(`/api/estimates/${estimate.id}/line-items/${estimate.lineId}`, { quantity: 2 })).status).toBe(200);
      expect(
        (await api.patch(`/api/invoices/${invoice.id}/line-items/${invoice.lineId}`, { description: 'Renamed', discount_type: null, discount_value: null })).status,
      ).toBe(200);
      expect((await api.patch(`/api/invoices/${invoice.id}/billing`, { tip: 5, discount_amount: 0 })).status).toBe(200);
    });

    it('lets a custom role based on Sales set a discount, and an Admin-box user too with no stored set', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'closer', 'SALES');
      const seller = await fx.addUser(org, 'closer', 'SALES', { customRoleId: role.id });
      // Sales holds "Through own leads": the estimate is the seller's through the lead they are an assignee of.
      const lead = await fx.addLead(org, customer, { assignees: [seller.id] });
      const estimate = await fx.addEstimate(org, customer, seller.id, { leadId: lead.id });
      const invoice = await fx.addInvoice(org, customer);

      const sellerApi = await fx.signedInAs(seller);
      expect((await sellerApi.patch(`/api/estimates/${estimate.id}`, { discount_type: 'PERCENTAGE', discount_value: 10 })).status).toBe(200);

      const adminApi = await fx.signedInAs(admin);
      expect((await adminApi.patch(`/api/invoices/${invoice.id}/billing`, { discount_amount: 5 })).status).toBe(200);
      expect(await db.permissionUserSwitch.count({ where: { user_id: admin.id } })).toBe(0);
    });

    it('has a server-check row for every check the catalog lists, and each one lets the switch in and refuses it out', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const role = await officeRole(org, 'table-office');
      const person = await fx.addUser(org, 'table', 'DISPATCHER', { customRoleId: role.id });
      const api = await fx.signedInAs(person);

      // One request per check, each against a record of its own so a let-in write cannot colour the next.
      const probes: Record<string, () => Promise<{ status: number }>> = {
        'estimate-create-discount': async () =>
          api.post('/api/estimates', {
            customer_id: customer,
            line_items: [{ description: 'Service', quantity: 1, unit_price: 100 }],
            discount_type: 'PERCENTAGE',
            discount_value: 10,
          }),
        'estimate-update-discount': async () => {
          const e = await fx.addEstimate(org, customer, admin.id);
          return api.patch(`/api/estimates/${e.id}`, { discount_type: 'FIXED_AMOUNT', discount_value: 5 });
        },
        'estimate-line-add-discount': async () => {
          const e = await fx.addEstimate(org, customer, admin.id);
          return api.post(`/api/estimates/${e.id}/line-items`, {
            description: 'Extra', quantity: 1, unit_price: 50, discount_type: 'PERCENTAGE', discount_value: 10,
          });
        },
        'estimate-line-update-discount': async () => {
          const e = await fx.addEstimate(org, customer, admin.id);
          return api.patch(`/api/estimates/${e.id}/line-items/${e.lineId}`, { discount_type: 'PERCENTAGE', discount_value: 10 });
        },
        'invoice-line-add-discount': async () => {
          const i = await fx.addInvoice(org, customer);
          return api.post(`/api/invoices/${i.id}/line-items`, {
            description: 'Extra', quantity: 1, unit_price: 50, discount_type: 'FIXED_AMOUNT', discount_value: 5,
          });
        },
        'invoice-line-update-discount': async () => {
          const i = await fx.addInvoice(org, customer);
          return api.patch(`/api/invoices/${i.id}/line-items/${i.lineId}`, { discount_type: 'PERCENTAGE', discount_value: 10 });
        },
        'invoice-billing-discount': async () => {
          const i = await fx.addInvoice(org, customer);
          return api.patch(`/api/invoices/${i.id}/billing`, { discount_amount: 5 });
        },
        'job-discount-write': async () => {
          const job = await fx.addJob(org, customer);
          return api.patch(`/api/jobs/${job.id}`, { discount_type: 'PERCENTAGE', discount_value: 10 });
        },
      };

      const listed = findSwitch(APPLY_DISCOUNTS)!.serverChecks;
      expect(Object.keys(probes).sort()).toEqual([...listed].sort());

      // Off (the Dispatcher preset): every check refuses.
      for (const check of listed) {
        const res = await probes[check]!();
        expect(res.status, `${check} with the switch off`).toBe(403);
      }

      // On: the role's stored value turns the switch on for the person, and every check lets it in.
      await setRoleSwitchValues({
        organizationId: org, roleKey: role.key, values: { [APPLY_DISCOUNTS]: true }, actorId: admin.id, reason: 'manual',
      });
      for (const check of listed) {
        const res = await probes[check]!();
        expect(res.status, `${check} with the switch on`).toBeLessThan(300);
      }
    });
  });

  describe('resolving a person\'s switches', () => {
    it('takes a missing value from the based-on role, then from the preset of a custom role\'s base, and a role made from blank resolves off', async () => {
      const { org, admin } = await fx.newOrg();
      const salesBased = await fx.addCustomRole(org, 'sales-based', 'SALES');
      const dispatcherBased = await fx.addCustomRole(org, 'dispatcher-based', 'DISPATCHER');
      const blank = await fx.addCustomRole(org, 'from-blank', 'SALES', { madeFromBlank: true });

      const valueFor = async (person: Person) => (await resolveSwitches(await permissionUser(person)))[APPLY_DISCOUNTS];

      // A custom role lacking the key takes its base built-in preset.
      expect(await valueFor(await fx.addUser(org, 'a', 'SALES', { customRoleId: salesBased.id }))).toBe(true);
      expect(await valueFor(await fx.addUser(org, 'b', 'DISPATCHER', { customRoleId: dispatcherBased.id }))).toBe(false);
      // A role made from blank resolves off, whatever its base built-in role would have said.
      expect(await valueFor(await fx.addUser(org, 'c', 'SALES', { customRoleId: blank.id }))).toBe(false);

      // A person whose set lacks the key resolves it from the role they are based on.
      await setRoleSwitchValues({ organizationId: org, roleKey: 'dispatcher-based', values: { [APPLY_DISCOUNTS]: true }, actorId: admin.id, reason: 'manual' });
      const basedOnIt = await fx.addUser(org, 'd', 'SALES', { basedOnRoleKey: 'dispatcher-based', customRoleId: salesBased.id });
      expect(await valueFor(basedOnIt)).toBe(true);
      // The role's own stored value wins over its preset.
      await setRoleSwitchValues({ organizationId: org, roleKey: 'sales-based', values: { [APPLY_DISCOUNTS]: false }, actorId: admin.id, reason: 'manual' });
      expect(await valueFor(await fx.addUser(org, 'e', 'SALES', { customRoleId: salesBased.id }))).toBe(false);
      // The built-in Admin box needs no stored set and holds every switch.
      expect(await valueFor(admin)).toBe(true);
    });
  });

  describe('writing a role\'s switch values', () => {
    it('logs a changed value with where it came from, logs nothing for a value that stays as it was, and refuses a switch the catalog does not hold', async () => {
      const { org, admin } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'logged-office', 'DISPATCHER');
      const preset = findSwitch(APPLY_DISCOUNTS)!.presets.DISPATCHER;

      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [APPLY_DISCOUNTS]: !preset }, actorId: admin.id, reason: 'manual' });
      // Stored again at the value it already holds: still one entry in all.
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [APPLY_DISCOUNTS]: !preset }, actorId: admin.id, reason: 'manual' });

      const log = await readChangeLog({ organizationId: org, targetType: 'ROLE', targetId: role.key });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        organization_id: org, target_type: 'ROLE', target_id: role.key, switch_key: APPLY_DISCOUNTS,
        from_value: preset, to_value: !preset, actor_id: admin.id, reason: 'manual',
      });

      await expect(
        setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { not_a_switch: true }, actorId: admin.id, reason: 'manual' }),
      ).rejects.toBeInstanceOf(UnknownSwitchError);
    });
  });

  describe('giving a person a role through the user update', () => {
    it('links the person to the role without copying it, logs one entry per changed switch, and lets a later edit of the role reach them', async () => {
      const { org, admin } = await fx.newOrg();
      const dispatcher = await fx.addUser(org, 'dee', 'DISPATCHER');
      const api = await fx.signedInAs(admin);

      expect((await api.patch(`/api/users/${dispatcher.id}`, { role: 'SALES' })).status).toBe(200);

      // Only the link is stored: the person holds no override of their own, and resolves to the new role.
      expect(await db.permissionUserSwitch.count({ where: { user_id: dispatcher.id } })).toBe(0);
      expect((await db.user.findUniqueOrThrow({ where: { id: dispatcher.id } })).based_on_role_key).toBe('SALES');
      expect((await resolveSwitches(await permissionUser(dispatcher)))[APPLY_DISCOUNTS]).toBe(findSwitch(APPLY_DISCOUNTS)!.presets.SALES);

      // One change-log entry per switch whose value changed for them, derived from the catalog.
      const changed = SWITCH_CATALOG.filter((c) => c.presets.DISPATCHER !== c.presets.SALES);
      const log = await readChangeLog({ organizationId: org, targetType: 'USER', targetId: dispatcher.id });
      expect(log.map((l) => l.switch_key).sort()).toEqual(changed.map((c) => c.key).sort());
      for (const entry of log) {
        const source = findSwitch(entry.switch_key!)!;
        expect(entry).toMatchObject({
          organization_id: org, target_type: 'USER', target_id: dispatcher.id,
          from_value: source.presets.DISPATCHER, to_value: source.presets.SALES,
          actor_id: admin.id, reason: 'role assigned',
        });
        expect(entry.created_at).toBeInstanceOf(Date);
      }

      // Editing the role afterwards reaches the person: they hold no value of their own for the switch.
      await setRoleSwitchValues({ organizationId: org, roleKey: 'SALES', values: { [APPLY_DISCOUNTS]: false }, actorId: admin.id, reason: 'manual' });
      expect((await resolveSwitches(await permissionUser(dispatcher)))[APPLY_DISCOUNTS]).toBe(false);
      // A Sales person who was never given a set follows the role as it stands.
      const untouched = await fx.addUser(org, 'sam', 'SALES');
      expect((await resolveSwitches(await permissionUser(untouched)))[APPLY_DISCOUNTS]).toBe(false);
    });

    it('follows the new role when the person\'s role changes again, and writes no log entry for a switch that did not change', async () => {
      const { org, admin } = await fx.newOrg();
      const person = await fx.addUser(org, 'pat', 'DISPATCHER');
      const api = await fx.signedInAs(admin);
      await api.patch(`/api/users/${person.id}`, { role: 'SALES' });

      expect((await api.patch(`/api/users/${person.id}`, { role: 'TECHNICIAN' })).status).toBe(200);

      expect((await resolveSwitches(await permissionUser(person)))[APPLY_DISCOUNTS]).toBe(findSwitch(APPLY_DISCOUNTS)!.presets.TECHNICIAN);
      expect((await db.user.findUniqueOrThrow({ where: { id: person.id } })).based_on_role_key).toBe('TECHNICIAN');
      const refill = (await readChangeLog({ organizationId: org, targetType: 'USER', targetId: person.id })).filter(
        (l) => l.from_value === findSwitch(l.switch_key!)!.presets.SALES && l.to_value === findSwitch(l.switch_key!)!.presets.TECHNICIAN,
      );
      // Rows written in one statement share a timestamp, so their read order is not the catalog's: compare as sets.
      expect(refill.map((l) => l.switch_key).sort()).toEqual(
        SWITCH_CATALOG.filter((c) => c.presets.SALES !== c.presets.TECHNICIAN).map((c) => c.key).sort(),
      );

      // Dispatcher to Technician logs exactly the switches whose preset differs between the two, and
      // none of the ones that stay the same.
      const mover = await fx.addUser(org, 'quin', 'DISPATCHER');
      await api.patch(`/api/users/${mover.id}`, { role: 'TECHNICIAN' });
      const moved = await readChangeLog({ organizationId: org, targetType: 'USER', targetId: mover.id });
      expect(moved.map((l) => l.switch_key).sort()).toEqual(
        SWITCH_CATALOG.filter((c) => c.presets.DISPATCHER !== c.presets.TECHNICIAN).map((c) => c.key).sort(),
      );
      // A person who changes to the role they are already on changes nothing and logs nothing.
      const same = await fx.addUser(org, 'sol', 'TECHNICIAN');
      await api.patch(`/api/users/${same.id}`, { role: 'TECHNICIAN' });
      expect(await readChangeLog({ organizationId: org, targetType: 'USER', targetId: same.id })).toEqual([]);
    });

    it('follows a custom role\'s stored values, and an update that leaves the role as it is keeps the person\'s own override', async () => {
      const { org, admin } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'crew-lead', 'DISPATCHER');
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [APPLY_DISCOUNTS]: true }, actorId: admin.id, reason: 'manual' });
      const person = await fx.addUser(org, 'cora', 'DISPATCHER');
      const api = await fx.signedInAs(admin);

      expect((await api.patch(`/api/users/${person.id}`, { role: 'DISPATCHER', custom_role_id: role.id })).status).toBe(200);
      expect((await resolveSwitches(await permissionUser(person)))[APPLY_DISCOUNTS]).toBe(true);
      expect((await db.user.findUniqueOrThrow({ where: { id: person.id } })).based_on_role_key).toBe(role.key);

      // Someone tailors the person, then an edit to their name sends the same role back.
      await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: person.id, switch_key: APPLY_DISCOUNTS, value: false } });
      expect((await api.patch(`/api/users/${person.id}`, { role: 'DISPATCHER', custom_role_id: role.id, first_name: 'Cora-Lee' })).status).toBe(200);
      expect(
        (await db.permissionUserSwitch.findFirstOrThrow({ where: { user_id: person.id, switch_key: APPLY_DISCOUNTS } })).value,
      ).toBe(false);
    });
  });

  describe('what the client is told', () => {
    it('sends the rules a person\'s switches compile into, so the screens draw what the server enforces', async () => {
      const { org, admin } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'drawn-office', 'DISPATCHER');
      const person = await fx.addUser(org, 'drew', 'DISPATCHER', { customRoleId: role.id });
      const grants = findSwitch(APPLY_DISCOUNTS)!.grants;
      const rulesFor = async () =>
        (await (await fx.signedInAs(person)).get('/api/auth/me')).body.abilityRules as { action: string; subject: string }[];
      const holds = (rules: { action: string; subject: string }[]) =>
        grants.every((g) => rules.some((r) => r.action === g.action && r.subject === g.subject));

      expect(holds(await rulesFor())).toBe(false);
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [APPLY_DISCOUNTS]: true }, actorId: admin.id, reason: 'manual' });
      expect(holds(await rulesFor())).toBe(true);
    });
  });

  describe('the permission cache', () => {
    it('is cleared on a change to a role, to the role a person falls back to, or to the person, so the next request sees it', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const role = await officeRole(org, 'cache-office');
      const person = await fx.addUser(org, 'carl', 'DISPATCHER', { customRoleId: role.id });
      const estimate = await fx.addEstimate(org, customer, admin.id);
      const discount = { discount_type: 'PERCENTAGE', discount_value: 10 };
      const asPerson = await fx.signedInAs(person);

      // Refused - and the person's switches are now cached.
      expect((await asPerson.patch(`/api/estimates/${estimate.id}`, discount)).status).toBe(403);
      // A change to their role is visible on the very next request.
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [APPLY_DISCOUNTS]: true }, actorId: admin.id, reason: 'manual' });
      expect((await asPerson.patch(`/api/estimates/${estimate.id}`, { ...discount, discount_value: 15 })).status).toBe(200);

      // A change to the role someone FALLS BACK to (they are based on it, though they sit on another).
      const other = await officeRole(org, 'other-office');
      const follower = await fx.addUser(org, 'fay', 'DISPATCHER', { customRoleId: other.id, basedOnRoleKey: 'fallback-office' });
      await fx.addCustomRole(org, 'fallback-office', 'DISPATCHER');
      // The role they fall back to is what holds their switches, so it is the one that lets them edit estimates.
      await setRoleSwitchValues({ organizationId: org, roleKey: 'fallback-office', values: { edit_estimates: true }, actorId: null, reason: 'manual' });
      const asFollower = await fx.signedInAs(follower);
      expect((await asFollower.patch(`/api/estimates/${estimate.id}`, { ...discount, discount_value: 20 })).status).toBe(403);
      await setRoleSwitchValues({ organizationId: org, roleKey: 'fallback-office', values: { [APPLY_DISCOUNTS]: true }, actorId: admin.id, reason: 'manual' });
      expect((await asFollower.patch(`/api/estimates/${estimate.id}`, { ...discount, discount_value: 20 })).status).toBe(200);

      // A change to the person: moved to Sales through the user update, they may discount at once.
      const mover = await fx.addUser(org, 'mo', 'DISPATCHER', { customRoleId: other.id, basedOnRoleKey: 'other-office' });
      const ownEstimate = await fx.addEstimate(org, customer, mover.id);
      const asMover = await fx.signedInAs(mover);
      expect((await asMover.patch(`/api/estimates/${ownEstimate.id}`, discount)).status).toBe(403);
      expect((await (await fx.signedInAs(admin)).patch(`/api/users/${mover.id}`, { role: 'SALES', custom_role_id: null })).status).toBe(200);
      expect((await asMover.patch(`/api/estimates/${ownEstimate.id}`, discount)).status).toBe(200);
    });
  });
});
