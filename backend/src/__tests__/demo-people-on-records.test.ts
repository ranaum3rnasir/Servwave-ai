import { describe, it, expect } from 'vitest';
import { demoLeadDispatcherId, demoPeopleForSlot } from '../lib/demo-people-on-records';
import { BUILT_IN_ROLES, SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

/**
 * Roles & Permissions, PRD 3, slice S03.20 - which demo-org people the seeder may put in a lead's or job's
 * people slots, and which demo leads carry a Dispatcher. Pure, so it is testable without a database; the
 * seed script itself is run end to end by seed-demo-org-people-db.test.ts.
 */
const onePerRole = BUILT_IN_ROLES.map((role) => ({ id: `u-${role}`, role }));
const presetFor = (key: string, role: string) => SWITCH_CATALOG.find((e) => e.key === key)!.presets[role as (typeof BUILT_IN_ROLES)[number]];

describe('demoPeopleForSlot', () => {
  it.each([
    ['owner', 'can_own_leads'],
    ['dispatcher', 'can_be_dispatcher'],
  ] as const)('keeps exactly the people whose built-in role holds the %s switch', (slot, switchKey) => {
    const expected = onePerRole.filter((p) => presetFor(switchKey, p.role) === true).map((p) => p.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(onePerRole.length);
    expect(demoPeopleForSlot(onePerRole, slot).map((p) => p.id)).toEqual(expected);
  });

  it('keeps the order it was given', () => {
    const people = [
      { id: 'b', role: 'ADMIN' },
      { id: 'a', role: 'ADMIN' },
    ];
    expect(demoPeopleForSlot(people, 'owner').map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('demoLeadDispatcherId', () => {
  const pool = ['d1', 'd2'];
  const STATUSES = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST'];
  const run = (status: string, n = 12) => Array.from({ length: n }, (_, i) => demoLeadDispatcherId(status, i, pool));

  it('is always someone from the pool or nobody', () => {
    for (const status of STATUSES) for (const id of run(status)) expect([null, ...pool]).toContain(id);
  });

  it('puts a Dispatcher on every lead with a booked or finished walkthrough, and on an estimated one', () => {
    for (const status of ['WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED']) {
      expect(run(status).every((id) => id !== null)).toBe(true);
    }
  });

  it('spreads the Dispatchers across the pool', () => {
    expect(new Set(run('WALKTHROUGH_SCHEDULED'))).toEqual(new Set(pool));
  });

  it('leaves some won leads with no Dispatcher and some with one', () => {
    const won = run('WON');
    expect(won).toContain(null);
    expect(won.some((id) => id !== null)).toBe(true);
  });

  it('leaves new, contacted and lost leads with none: nobody has been asked to book anything', () => {
    for (const status of ['NEW', 'CONTACTED', 'LOST']) expect(run(status).every((id) => id === null)).toBe(true);
  });

  it('is nobody when the company has no one who may be a Dispatcher', () => {
    expect(demoLeadDispatcherId('WALKTHROUGH_SCHEDULED', 0, [])).toBeNull();
  });
});
