/**
 * #2041 — unit tests for `lib/permissions/customerScope.ts`'s pure helpers: `matchesFragment`
 * (the in-memory verdict) and `proofSelectFor` (the generic proof-select builder), per arm of
 * OWN_CUSTOMER, plus R12's absent-key/unknown-operator split.
 */
import { describe, it, expect } from 'vitest';
import { matchesFragment, proofSelectFor } from '../lib/permissions/customerScope';

const USER_ID = 'u-0000-0000-0000-000000000001';

const OWN_LEAD_ARM = { leads: { some: { lead_assignees: { some: { user_id: USER_ID } } } } };
const OWN_JOB_ARM = { jobs: { some: { visits: { some: { assignees: { some: { user_id: USER_ID } } } } } } };
const CREATED_BY_ARM = { created_by_id: USER_ID };
const OWN_CUSTOMER = { OR: [OWN_LEAD_ARM, OWN_JOB_ARM, CREATED_BY_ARM] };

describe('matchesFragment', () => {
  it('matches on the lead-assignee arm — a lead-assigned, NOT created-by row (R1 silent-empty-list case)', () => {
    const row = {
      leads: [{ lead_assignees: [{ user_id: USER_ID }] }],
      jobs: [],
      created_by_id: null,
    };
    expect(matchesFragment(OWN_CUSTOMER, row)).toBe(true);
  });

  it('matches on the job-visit-assignee arm', () => {
    const row = {
      leads: [],
      jobs: [{ visits: [{ assignees: [{ user_id: USER_ID }] }] }],
      created_by_id: null,
    };
    expect(matchesFragment(OWN_CUSTOMER, row)).toBe(true);
  });

  it('matches on the created_by_id arm', () => {
    const row = { leads: [], jobs: [], created_by_id: USER_ID };
    expect(matchesFragment(OWN_CUSTOMER, row)).toBe(true);
  });

  it('does not match when none of the three arms are satisfied', () => {
    const row = {
      leads: [{ lead_assignees: [{ user_id: 'someone-else' }] }],
      jobs: [{ visits: [{ assignees: [{ user_id: 'someone-else' }] }] }],
      created_by_id: 'someone-else',
    };
    expect(matchesFragment(OWN_CUSTOMER, row)).toBe(false);
  });

  it('R12 — an ABSENT relation key is a non-match, never a throw (getById on an un-proofed row)', () => {
    // No `leads`/`jobs`/`created_by_id` keys at all — the shape a plain `customerSelect` (no
    // proof merged in) would produce.
    const row = { id: 'c-1', first_name: 'Bare' };
    expect(() => matchesFragment(OWN_CUSTOMER, row)).not.toThrow();
    expect(matchesFragment(OWN_CUSTOMER, row)).toBe(false);
  });

  it('R12 — a `some` fragment against a non-array actual is a non-match, never a throw', () => {
    const row = { leads: null, jobs: undefined, created_by_id: null };
    expect(matchesFragment(OWN_CUSTOMER, row)).toBe(false);
  });

  it('throws on an unrecognised operator — never a silent true', () => {
    // `notIn` (camelCase) fails the plain-condition-object check (/^[a-z_]+$/), unlike a real
    // nested relation field name, so this is the genuine "unrecognised shape" case.
    const weird = { leads: { notIn: ['x'] } };
    expect(() => matchesFragment(weird, { leads: [] })).toThrow(/unhandled operator/);
  });

  it('MATCH_NOTHING (id: { in: [] }) never matches any row', () => {
    expect(matchesFragment({ id: { in: [] } }, { id: 'any-id' })).toBe(false);
  });

  it('an empty fragment ({}) matches every row — the ADMIN/unconditional shape', () => {
    expect(matchesFragment({}, {})).toBe(true);
    expect(matchesFragment({}, { anything: 'here' })).toBe(true);
  });

  it('AND/OR/NOT compose correctly', () => {
    expect(matchesFragment({ AND: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 2 })).toBe(true);
    expect(matchesFragment({ AND: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 3 })).toBe(false);
    expect(matchesFragment({ OR: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 2 })).toBe(true);
    expect(matchesFragment({ NOT: { a: 1 } }, { a: 2 })).toBe(true);
    expect(matchesFragment({ NOT: { a: 1 } }, { a: 1 })).toBe(false);
  });

  it('a to-one relation recurses; a missing to-one is a non-match', () => {
    const frag = { customer: { name: 'X' } };
    expect(matchesFragment(frag, { customer: { name: 'X' } })).toBe(true);
    expect(matchesFragment(frag, { customer: { name: 'Y' } })).toBe(false);
    expect(matchesFragment(frag, {})).toBe(false);
  });
});

describe('proofSelectFor', () => {
  it('a scalar condition key selects itself', () => {
    expect(proofSelectFor(CREATED_BY_ARM, USER_ID)).toEqual({ created_by_id: true });
  });

  it('{ rel: { some: inner } } becomes { rel: { where: inner, select: proofSelectFor(inner), take: 1 } }', () => {
    const select = proofSelectFor(OWN_LEAD_ARM, USER_ID);
    expect(select).toEqual({
      leads: {
        where: { lead_assignees: { some: { user_id: USER_ID } } },
        select: { lead_assignees: { where: { user_id: USER_ID }, select: { user_id: true }, take: 1 } },
        take: 1,
      },
    });
  });

  it('OR/AND arms merge into ONE flat select object (different top-level keys, no collision)', () => {
    const select = proofSelectFor(OWN_CUSTOMER, USER_ID);
    expect(Object.keys(select).sort()).toEqual(['created_by_id', 'jobs', 'leads']);
  });

  it('never hardcodes a specific shape — walks whatever fragment it is given (a hand-edited condition still resolves)', () => {
    const custom = { OR: [{ vendor_owner_id: USER_ID }, { region: { in: ['west'] } }] };
    expect(() => proofSelectFor(custom, USER_ID)).not.toThrow();
    const select = proofSelectFor(custom, USER_ID);
    expect(select.vendor_owner_id).toBe(true);
    // `{ in: [...] }` on a bare scalar key selects the scalar itself (matchesFragment's own
    // `'in' in obj` branch judges it), never nests a `select` under a scalar column.
    expect(select.region).toBe(true);
  });

  it('MATCH_NOTHING (id: { in: [] }) selects the bare scalar, never a nested select under id', () => {
    expect(proofSelectFor({ id: { in: [] } }, USER_ID)).toEqual({ id: true });
  });

  it('throws on an unrecognised operator object, never a silent pass-through', () => {
    expect(() => proofSelectFor({ leads: { notIn: ['x'] } }, USER_ID)).toThrow(/unhandled operator/);
  });

  it('round-trips against matchesFragment — a row selected per proofSelectFor is judged correctly', () => {
    // Simulates what a `findUnique({ select: proofSelectFor(OWN_CUSTOMER, USER_ID) })` would
    // return for a customer reached ONLY via the lead-assignee arm.
    const row = {
      created_by_id: null,
      leads: [{ lead_assignees: [{ user_id: USER_ID }] }],
      jobs: [],
    };
    expect(matchesFragment(OWN_CUSTOMER, row)).toBe(true);
  });
});
