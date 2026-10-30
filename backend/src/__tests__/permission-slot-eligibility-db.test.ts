/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.1 - slot eligibility (M5) and the roster asked per slot.

   M5 answers three questions about the people slots on a lead or job: may this user hold the slot, which
   users may hold it, and why not. A user may hold a slot when they are active and their resolved switch for
   it is on (Can own leads / be Sold By, Can be a dispatcher, Can be on a crew); the Admin box holds every
   slot. The roster endpoint's "eligible for" filter is M5's answer.

   Every case uses people on custom roles whose base role and switch disagree (a Technician base with Can be a
   dispatcher on, a Dispatcher base with it off), so no role-name or base-role check can pass. Preset
   expectations are read from the catalog. Real migrated database (TEST_DATABASE_URL); the suite skips when it
   is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { setRoleSwitchValues, clearSwitchCacheForOrg } from '../lib/permissions/switches/store';
import { BUILT_IN_ROLES, findSwitch } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

type Slot = 'owner' | 'dispatcher' | 'crew';
const SLOT_SWITCH: Record<Slot, string> = { owner: 'can_own_leads', dispatcher: 'can_be_dispatcher', crew: 'can_be_on_crew' };
const SLOTS = Object.keys(SLOT_SWITCH) as Slot[];

suite('slot eligibility (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  const m5 = () => import('../lib/permissions/slotEligibility.js');
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these slot switch values. */
  async function personWith(org: string, values: Record<string, boolean>, base: Role, opts: { active?: boolean } = {}) {
    const key = `slot-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `slot${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return person;
  }

  const candidate = async (person: Person) => {
    const row = await db.user.findUniqueOrThrow({
      where: { id: person.id },
      select: { id: true, organization_id: true, role: true, is_admin: true, is_active: true, custom_role_id: true, custom_role: { select: { key: true } } },
    });
    return row;
  };

  describe('may this user hold this slot', () => {
    it.each(SLOTS)('follows the %s switch whatever the base role is', async (slot) => {
      const { org } = await fx.newOrg();
      const m = await m5();
      // Each base role, once with the switch on and once with it off: the base never decides.
      for (const base of BUILT_IN_ROLES.filter((r) => r !== 'ADMIN')) {
        const on = await personWith(org, { [SLOT_SWITCH[slot]]: true }, base);
        const off = await personWith(org, { [SLOT_SWITCH[slot]]: false }, base);
        expect(await m.mayHoldSlot(await candidate(on), slot), `${base} on`).toBe(true);
        expect(await m.mayHoldSlot(await candidate(off), slot), `${base} off`).toBe(false);
      }
    });

    it('names the cases the slice calls out: a Technician base with Can be a dispatcher on is eligible, a Dispatcher base with it off is not', async () => {
      const { org } = await fx.newOrg();
      const m = await m5();
      const tech = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const dispatcher = await personWith(org, { can_be_dispatcher: false }, 'DISPATCHER');
      expect(await m.mayHoldSlot(await candidate(tech), 'dispatcher')).toBe(true);
      expect(await m.mayHoldSlot(await candidate(dispatcher), 'dispatcher')).toBe(false);
      // A Dispatcher base with Can be on a crew on (the Dispatcher preset has it off) is eligible for a crew.
      const crewDispatcher = await personWith(org, { can_be_on_crew: true }, 'DISPATCHER');
      expect(await m.mayHoldSlot(await candidate(crewDispatcher), 'crew')).toBe(true);
    });

    it('reads the built-in presets from the catalog for people on a built-in role', async () => {
      const { org } = await fx.newOrg();
      const m = await m5();
      for (const role of BUILT_IN_ROLES) {
        const person = await fx.addUser(org, `builtin${++sequence}`, role);
        for (const slot of SLOTS) {
          const expected = findSwitch(SLOT_SWITCH[slot])!.presets[role];
          expect(await m.mayHoldSlot(await candidate(person), slot), `${role} ${slot}`).toBe(expected);
        }
      }
    });

    it('holds every slot for the Admin box, even where the stored role rows say otherwise', async () => {
      const { org, admin } = await fx.newOrg();
      const m = await m5();
      for (const slot of SLOTS) {
        expect(await m.mayHoldSlot(await candidate(admin), slot), slot).toBe(true);
      }
    });

    it('takes a switch the person lacks from the role they are based on, and their own value when they hold one', async () => {
      const { org } = await fx.newOrg();
      const m = await m5();
      const person = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      // No stored set of their own: the role's value stands.
      expect(await m.mayHoldSlot(await candidate(person), 'dispatcher')).toBe(true);
      // Editing the role reaches a person who has no value of their own.
      const role = await db.customRole.findFirstOrThrow({ where: { id: (await candidate(person)).custom_role_id! } });
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { can_be_dispatcher: false }, actorId: null, reason: 'manual' });
      expect(await m.mayHoldSlot(await candidate(person), 'dispatcher')).toBe(false);
      // A value of their own wins over the role.
      await db.permissionUserSwitch.create({
        data: { organization_id: org, user_id: person.id, switch_key: 'can_be_dispatcher', value: true },
      });
      clearSwitchCacheForOrg(org);
      expect(await m.mayHoldSlot(await candidate(person), 'dispatcher')).toBe(true);
    });

    it('holds no slot for an inactive user, and says so', async () => {
      const { org } = await fx.newOrg();
      const m = await m5();
      const inactive = await personWith(org, { can_own_leads: true, can_be_dispatcher: true, can_be_on_crew: true }, 'TECHNICIAN', { active: false });
      for (const slot of SLOTS) {
        const c = await candidate(inactive);
        expect(await m.mayHoldSlot(c, slot), slot).toBe(false);
        expect(await m.whyNotSlot(c, slot), slot).toBe('This person is inactive.');
      }
    });
  });

  describe('why not', () => {
    it('is empty for an eligible user and a plain sentence per slot for one whose switch is off', async () => {
      const { org } = await fx.newOrg();
      const m = await m5();
      const off = await personWith(org, { can_own_leads: false, can_be_dispatcher: false, can_be_on_crew: false }, 'ADMIN');
      const on = await personWith(org, { can_own_leads: true, can_be_dispatcher: true, can_be_on_crew: true }, 'SALES');
      const reasons = new Set<string>();
      for (const slot of SLOTS) {
        expect(await m.whyNotSlot(await candidate(on), slot), slot).toBeNull();
        const why = await m.whyNotSlot(await candidate(off), slot);
        expect(why, slot).toMatch(/^This person can't .+\.$/);
        reasons.add(why!);
      }
      expect(reasons.size).toBe(SLOTS.length);
    });
  });

  describe('which users may hold this slot', () => {
    it.each(SLOTS)('lists exactly the active users whose %s switch is on, and no inactive one', async (slot) => {
      const { org, admin } = await fx.newOrg();
      const m = await m5();
      const key = SLOT_SWITCH[slot];
      const techOn = await personWith(org, { [key]: true }, 'TECHNICIAN');
      const techOff = await personWith(org, { [key]: false }, 'TECHNICIAN');
      const dispatcherOn = await personWith(org, { [key]: true }, 'DISPATCHER');
      const dispatcherOff = await personWith(org, { [key]: false }, 'DISPATCHER');
      const inactiveOn = await personWith(org, { [key]: true }, 'SALES', { active: false });
      const ids = await m.eligibleUserIds(org, slot);
      expect([...ids].sort()).toEqual([admin.id, techOn.id, dispatcherOn.id].sort());
      for (const excluded of [techOff, dispatcherOff, inactiveOn]) expect(ids).not.toContain(excluded.id);
    });

    it('answers the same as asking about each user one at a time', async () => {
      const { org, admin } = await fx.newOrg();
      const m = await m5();
      const people: Person[] = [admin];
      for (const base of BUILT_IN_ROLES) people.push(await fx.addUser(org, `each${++sequence}`, base));
      for (const base of ['TECHNICIAN', 'DISPATCHER', 'SALES'] as const) {
        people.push(await personWith(org, { can_own_leads: true, can_be_dispatcher: false, can_be_on_crew: true }, base));
        people.push(await personWith(org, { can_own_leads: false, can_be_dispatcher: true, can_be_on_crew: false }, base));
      }
      // One person with a value of their own against the role, one made from blank (every switch off).
      const overridden = await personWith(org, { can_be_on_crew: false }, 'TECHNICIAN');
      await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: overridden.id, switch_key: 'can_be_on_crew', value: true } });
      people.push(overridden);
      const blankRole = await fx.addCustomRole(org, `blank-${++sequence}`, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      people.push(await fx.addUser(org, `blank${sequence}`, 'TECHNICIAN', { customRoleId: blankRole.id }));
      // An administrator's custom role is not the box: its switches decide.
      people.push(await personWith(org, { can_be_on_crew: false }, 'ADMIN'));
      clearSwitchCacheForOrg(org);

      for (const slot of SLOTS) {
        const listed = new Set(await m.eligibleUserIds(org, slot));
        for (const p of people) {
          expect(listed.has(p.id), `${slot} ${p.email}`).toBe(await m.mayHoldSlot(await candidate(p), slot));
        }
      }
    });

    it('never lists a user of another company', async () => {
      const a = await fx.newOrg();
      const b = await fx.newOrg();
      const m = await m5();
      const ids = await m.eligibleUserIds(a.org, 'crew');
      expect(ids).toContain(a.admin.id);
      expect(ids).not.toContain(b.admin.id);
    });
  });

  describe('the roster, asked per slot', () => {
    const ask = async (person: Person, slot: string, purpose = 'directory') => {
      const api = await fx.signedInAs(person);
      const res = await api.get(`/api/users/assignable?purpose=${purpose}&eligible_for=${slot}`);
      expect(res.status).toBe(200);
      return (res.body as { id: string }[]).map((u) => u.id);
    };

    it.each(SLOTS)('returns only the active users whose %s switch allows it, reading no role name', async (slot) => {
      const { org, admin } = await fx.newOrg();
      const m = await m5();
      const key = SLOT_SWITCH[slot];
      const onTech = await personWith(org, { [key]: true }, 'TECHNICIAN');
      const offDispatcher = await personWith(org, { [key]: false }, 'DISPATCHER');
      const onDispatcher = await personWith(org, { [key]: true }, 'DISPATCHER');
      const offTech = await personWith(org, { [key]: false }, 'TECHNICIAN');
      const inactive = await personWith(org, { [key]: true }, 'SALES', { active: false });

      const roster = await ask(admin, slot);
      expect([...roster].sort()).toEqual([...(await m.eligibleUserIds(org, slot))].sort());
      expect(roster).toEqual(expect.arrayContaining([admin.id, onTech.id, onDispatcher.id]));
      for (const excluded of [offDispatcher, offTech, inactive]) expect(roster).not.toContain(excluded.id);
    });

    it('is answered by the slot for the crew purposes too', async () => {
      const { org, admin } = await fx.newOrg();
      const on = await personWith(org, { can_be_on_crew: true }, 'DISPATCHER');
      const off = await personWith(org, { can_be_on_crew: false }, 'TECHNICIAN');
      for (const purpose of ['jobCrew', 'walkthroughPerformer']) {
        const roster = await ask(admin, 'crew', purpose);
        expect(roster, purpose).toContain(on.id);
        expect(roster, purpose).not.toContain(off.id);
      }
    });

    it('does not list a deactivated user who holds nothing, and a user is listed again when their switch is turned back on', async () => {
      const { org, admin } = await fx.newOrg();
      const person = await personWith(org, { can_be_dispatcher: false }, 'DISPATCHER');
      expect(await ask(admin, 'dispatcher')).not.toContain(person.id);
      const role = await db.customRole.findFirstOrThrow({ where: { id: (await candidate(person)).custom_role_id! } });
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { can_be_dispatcher: true }, actorId: null, reason: 'manual' });
      expect(await ask(admin, 'dispatcher')).toContain(person.id);
      await db.user.update({ where: { id: person.id }, data: { is_active: false } });
      expect(await ask(admin, 'dispatcher')).not.toContain(person.id);
    });

    it('leaves the task roster as it is: every active user, whatever their slot switches say', async () => {
      const { org, admin } = await fx.newOrg();
      const noSlots = await personWith(org, { can_own_leads: false, can_be_dispatcher: false, can_be_on_crew: false }, 'DISPATCHER');
      const inactive = await personWith(org, { can_be_on_crew: true }, 'SALES', { active: false });
      const roster = await ask(admin, 'task', 'task');
      expect(roster).toContain(noSlots.id);
      expect(roster).toContain(admin.id);
      expect(roster).not.toContain(inactive.id);
    });

    it('keeps a self-only requester to themselves under a slot, and to nobody when they are not eligible', async () => {
      const { org } = await fx.newOrg();
      await fx.addUser(org, `other${++sequence}`, 'TECHNICIAN');
      // A custom role with no Read users reaches only its own name on the directory roster.
      const eligible = await personWith(org, { can_be_on_crew: true, view_users: false }, 'SALES');
      const ineligible = await personWith(org, { can_be_on_crew: false, view_users: false }, 'SALES');
      expect(await ask(eligible, 'crew')).toEqual([eligible.id]);
      expect(await ask(ineligible, 'crew')).toEqual([]);
    });

    it('refuses a slot it does not know rather than falling back to everyone', async () => {
      const { admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const res = await api.get('/api/users/assignable?purpose=directory&eligible_for=boss');
      expect(res.status).toBe(400);
    });
  });
});
