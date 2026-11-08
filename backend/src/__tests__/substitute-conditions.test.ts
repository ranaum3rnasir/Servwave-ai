import { describe, it, expect } from 'vitest';
import { substituteConditions } from '../lib/permissions/substituteConditions';

const ctx = { userId: 'u1', teamId: 't1', locationId: 'l1' };

describe('substituteConditions', () => {
  it('substitutes userId into the M2M crew shape', () => {
    expect(substituteConditions({ lead_assignees: { some: { user_id: '{{userId}}' } } }, ctx)).toEqual({
      lead_assignees: { some: { user_id: 'u1' } },
    });
  });
  it('substitutes teamId and locationId in the nested crew→user relation', () => {
    expect(substituteConditions({ assignees: { some: { user: { department_id: '{{teamId}}' } } } }, ctx)).toEqual({
      assignees: { some: { user: { department_id: 't1' } } },
    });
    expect(substituteConditions({ assignees: { some: { user: { location_id: '{{locationId}}' } } } }, ctx)).toEqual({
      assignees: { some: { user: { location_id: 'l1' } } },
    });
  });
  it('substitutes null when team/location absent', () => {
    expect(
      substituteConditions(
        { assignees: { some: { user: { department_id: '{{teamId}}' } } } },
        { userId: 'u1', teamId: null, locationId: null },
      ),
    ).toEqual({ assignees: { some: { user: { department_id: null } } } });
  });
  it('returns undefined for null conditions', () => {
    expect(substituteConditions(null, ctx)).toBeUndefined();
  });
  it('throws on unknown token', () => {
    expect(() => substituteConditions({ x: '{{nope}}' }, ctx)).toThrow(/Unknown token/);
  });
});
