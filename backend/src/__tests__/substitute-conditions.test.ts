import { describe, it, expect } from 'vitest';
import { substituteConditions } from '../lib/permissions/substituteConditions';

const ctx = { userId: 'u1', teamId: 't1' };

describe('substituteConditions', () => {
  it('substitutes userId into the M2M crew shape', () => {
    expect(substituteConditions({ lead_assignees: { some: { user_id: '{{userId}}' } } }, ctx)).toEqual({
      lead_assignees: { some: { user_id: 'u1' } },
    });
  });
  it('substitutes teamId in the nested crew→user relation', () => {
    expect(substituteConditions({ assignees: { some: { user: { department_id: '{{teamId}}' } } } }, ctx)).toEqual({
      assignees: { some: { user: { department_id: 't1' } } },
    });
  });
  it('no longer knows a location token: there is no location scope', () => {
    expect(() => substituteConditions({ assignees: { some: { user: { location_id: '{{locationId}}' } } } }, ctx)).toThrow(/Unknown token/);
  });
  it('substitutes null when team absent', () => {
    expect(
      substituteConditions(
        { assignees: { some: { user: { department_id: '{{teamId}}' } } } },
        { userId: 'u1', teamId: null },
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
