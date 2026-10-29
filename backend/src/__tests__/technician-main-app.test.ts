import { describe, it, expect } from 'vitest';
import { subject } from '@casl/ability';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const TECH_ID = 'tech-1';

function techAbility() {
  return defineAbilityFor(
    { id: TECH_ID, role: 'TECHNICIAN' },
    DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// S8 (D6): OWN_JOB reaches crew through the job's trips.
const ownJob = subject('Job', { visits: [{ assignees: [{ user_id: TECH_ID }] }] }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const otherJob = subject('Job', { visits: [{ assignees: [{ user_id: 'someone-else' }] }] }) as any;

describe('TECHNICIAN in the main app — new Job verbs', () => {
  it('can update, start and arrive at the type level (route-guard check)', () => {
    const ability = techAbility();
    for (const verb of ['update', 'start', 'arrive'] as const) {
      expect(ability.can(verb, 'Job')).toBe(true);
    }
  });

  it('grants update/start/arrive conditionally, never unconditionally', () => {
    const ability = techAbility();
    for (const verb of ['update', 'start', 'arrive'] as const) {
      const rules = ability.rulesFor(verb, 'Job');
      expect(rules.length).toBeGreaterThan(0);
      // Every TECHNICIAN Job grant must carry an own-scope condition. An unconditional
      // rule here would hand every technician org-wide authority.
      expect(rules.every((r) => r.inverted || !!r.conditions)).toBe(true);
    }
  });

  // SRVW-140 - canSeePricing keys on the dedicated `read Pricing` grant, not on `read Invoice`.
  // The two came apart again in the technician-ownership spec, Part C (PR 3): a technician now
  // holds `read Pricing` (prices, totals, job cost, margin - they have to price the lines on a job
  // they created) and still holds NO Invoice access at all. Opening the money did not open the
  // invoice RECORD, which is the distinction the split exists for.
  it('has read Pricing but still no read Invoice - they are different controls', () => {
    expect(techAbility().can('read', 'Pricing' as never)).toBe(true);
    expect(techAbility().can('read', 'Invoice')).toBe(false);
  });

  it('can create a Job (PR 3 role default) but still cannot create a Lead', () => {
    const ability = techAbility();
    expect(ability.can('create', 'Job')).toBe(true);
    expect(ability.can('create', 'Lead')).toBe(false);
  });

  it('can read the price book (pre-existing, shipped by Inventory P3 #855)', () => {
    expect(techAbility().can('read', 'PriceBook')).toBe(true);
  });

  it('can read the org user roster (unconditional, ruled 2026-07-21)', () => {
    expect(techAbility().can('read', 'User')).toBe(true);
  });

  it('the read User grant is unconditional — deliberately, since User is not a ScopeResource', () => {
    const rules = techAbility().rulesFor('read', 'User');
    expect(rules.length).toBe(1);
    expect(rules[0]!.conditions).toBeUndefined();
  });
});

describe('TECHNICIAN row scope — the assignment conjunct', () => {
  // These two assertions document the Prisma-vs-Mongo matcher hazard that Task 8 works
  // around on the client. On the SERVER the matcher is @casl/prisma, which evaluates
  // `some` correctly, so instance checks DO work here.
  // `complete` left this list with multi-visit S4 (D15): it is no longer a technician default at
  // all, so there is no own-scoped grant left to assert the conjunct on. The three that remain are
  // still per-user toggles carrying OWN_JOB.
  it('permits the verbs on an assigned job', () => {
    const ability = techAbility();
    for (const verb of ['update', 'start', 'arrive'] as const) {
      expect(ability.can(verb, ownJob)).toBe(true);
    }
  });

  it('refuses the verbs on another technician’s job', () => {
    const ability = techAbility();
    for (const verb of ['update', 'start', 'arrive'] as const) {
      expect(ability.can(verb, otherJob)).toBe(false);
    }
  });
});
