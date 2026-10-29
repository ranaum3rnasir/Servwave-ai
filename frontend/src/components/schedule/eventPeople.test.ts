import { describe, it, expect } from 'vitest';
import { crewPeopleOf, crewPeopleById, crewNamesOf, ownerOf, fullName } from './eventPeople';

const jobRaw = {
  assignees: [
    { user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } },
    { user: { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz' } },
  ],
  estimate: { lead: { commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } } },
};
const leadRaw = {
  walkthrough_performers: [{ user: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } }],
  commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' },
};

describe('crewPeopleOf', () => {
  it('job → assignees[].user (the crew, in order)', () => {
    expect(crewPeopleOf('job', jobRaw).map((p) => p.id)).toEqual(['u-alice', 'u-bob']);
  });
  it('walkthrough → walkthrough_performers[].user', () => {
    expect(crewPeopleOf('walkthrough', leadRaw).map((p) => p.id)).toEqual(['u-eve']);
  });
  it('empty / missing → []', () => {
    expect(crewPeopleOf('job', {})).toEqual([]);
    expect(crewPeopleOf('walkthrough', { walkthrough_performers: [] })).toEqual([]);
  });
  it('drops a wrapper row whose user is null', () => {
    expect(crewPeopleOf('job', { assignees: [{ user: null }, { user: { id: 'u-x' } }] }).map((p) => p.id)).toEqual(['u-x']);
  });
});

describe('ownerOf (commission owner — off-board)', () => {
  it('walkthrough → lead.commission_owner', () => {
    expect(ownerOf('walkthrough', leadRaw)?.id).toBe('u-eve');
  });
  it('job → estimate.lead.commission_owner (detail only)', () => {
    expect(ownerOf('job', jobRaw)?.id).toBe('u-eve');
  });
  it('null when absent (e.g. standalone job / list payload without estimate)', () => {
    expect(ownerOf('job', {})).toBeNull();
    expect(ownerOf('walkthrough', {})).toBeNull();
  });
});

describe('fullName', () => {
  it('joins and trims; null for empty', () => {
    expect(fullName({ first_name: 'A', last_name: 'B' })).toBe('A B');
    expect(fullName({ first_name: 'A' })).toBe('A');
    expect(fullName(null)).toBeNull();
    expect(fullName(undefined)).toBeNull();
    expect(fullName({})).toBeNull();
  });
});

/**
 * The "No crew" regression. `GET /api/users/assignable` is gated on the `assign User` grant,
 * so a rep who owns the lead but may not change its crew gets a roster that does NOT contain
 * the people already on the record. Resolving crew ids through the roster alone printed
 * "No crew" over a crew that plainly exists (the caller ORs the empty string with that label).
 *
 * The names of people ALREADY ON a record are never gated - they come from the record.
 */
describe('crewNamesOf (payload first, roster second)', () => {
  const SELF_ONLY_ROSTER = [{ id: 'u-self', first_name: 'Sam', last_name: 'Self' }];

  it('a viewer whose roster holds NONE of the crew still sees their names', () => {
    expect(crewNamesOf('job', jobRaw, ['u-alice', 'u-bob'], SELF_ONLY_ROSTER))
      .toBe('Alice Ng, Bob Ortiz');
  });

  it('an empty roster is not an empty crew (the "No crew" label must not fire)', () => {
    expect(crewNamesOf('walkthrough', leadRaw, ['u-eve'], [])).toBe('Eve Park');
  });

  it('falls back to the roster for an id the payload does not carry', () => {
    expect(crewNamesOf('job', {}, ['u-self'], SELF_ONLY_ROSTER)).toBe('Sam Self');
  });

  it('an id neither source knows is dropped, not rendered blank', () => {
    expect(crewNamesOf('job', jobRaw, ['u-alice', 'u-ghost'], [])).toBe('Alice Ng');
  });

  it('an empty crew really is empty', () => {
    expect(crewNamesOf('job', jobRaw, [], SELF_ONLY_ROSTER)).toBe('');
  });
});

describe('crewPeopleById', () => {
  it('keys the payload crew by user id, carrying the whole PersonRef (phone included)', () => {
    const raw = { assignees: [{ user: { id: 'u-a', first_name: 'A', last_name: 'B', phone: '555-1' } }] };
    expect(crewPeopleById('job', raw).get('u-a')?.phone).toBe('555-1');
  });
  it('drops a row whose user carries no id rather than keying on undefined', () => {
    const raw = { assignees: [{ user: { first_name: 'No', last_name: 'Id' } }] };
    expect(crewPeopleById('job', raw).size).toBe(0);
  });
});
