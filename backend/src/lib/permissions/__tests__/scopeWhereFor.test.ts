import { describe, it, expect } from 'vitest';
import { scopeWhereFor, MATCH_NOTHING } from '../scopeWhereFor';
import { DEFAULT_GRANTS } from '../defaultGrants';
import type { Grant } from '../defineAbility';

const ownLeadGrant: Grant = {
  action: 'read',
  subject: 'Lead',
  conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } },
};
const teamJobGrant: Grant = {
  action: 'read',
  subject: 'Job',
  conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } },
};

describe('scopeWhereFor', () => {
  it('ADMIN → no restriction ({})', () => {
    expect(scopeWhereFor({ id: 'u1', role: 'ADMIN' }, 'Lead', [])).toEqual({});
  });
  it('Owned (Lead) → assignee-match on the M2M join', () => {
    expect(scopeWhereFor({ id: 'u1', role: 'SALES' }, 'Lead', [ownLeadGrant])).toEqual({
      lead_assignees: { some: { user_id: 'u1' } },
    });
  });
  it('unconditional read grant → All ({})', () => {
    expect(
      scopeWhereFor({ id: 'u1', role: 'DISPATCHER' }, 'Lead', [
        { action: 'read', subject: 'Lead', conditions: null },
      ]),
    ).toEqual({});
  });
  it('no read grant for the resource → matches nothing', () => {
    expect(scopeWhereFor({ id: 'u1', role: 'SALES' }, 'Job', [])).toEqual(MATCH_NOTHING);
  });
  it('Team scope with a department → resolves {{teamId}} from department_id', () => {
    expect(
      scopeWhereFor({ id: 'u1', role: 'SALES', department_id: 'dep-7' }, 'Job', [teamJobGrant]),
    ).toEqual({
      assignees: { some: { user: { department_id: 'dep-7' } } },
    });
  });
  it('FAIL-CLOSED: Team scope with NO department → matches nothing (never matches dept-less rows)', () => {
    expect(
      scopeWhereFor({ id: 'u1', role: 'SALES', department_id: null }, 'Job', [teamJobGrant]),
    ).toEqual(MATCH_NOTHING);
  });

  // ─── F-004 convergence: the default SALES `read Estimate` grant is OWN_LEAD-scoped ───
  // The estimate controller used to scope SALES estimate reads with a hardcoded
  // `role === 'SALES'` literal because the default grant was UNCONDITIONAL. Convergence moves
  // that scoping into the grant itself, so the grant-driven scope engine (this function) is the
  // single source of truth — proving the literals are now redundant.
  // SERV10X-61 §8 - the default SALES `read Estimate` grant now owns an estimate via the parent
  // lead OR (for a lead-less/customer-anchored estimate) by having created it, mirroring
  // canAccessEstimate's getById gate so LIST and detail agree. The scope is the substituted OR of
  // both arms (NOT weakened - the own-via-lead arm is unchanged; the second arm is `lead_id: null`
  // + created_by-self, which cannot broaden a lead-anchored row).
  it('F-004 / §8: default SALES `read Estimate` grant → own-via-lead OR own lead-less-created scope', () => {
    const salesGrants = DEFAULT_GRANTS.filter((g) => g.role === 'SALES');
    expect(scopeWhereFor({ id: 'u1', role: 'SALES' }, 'Estimate', salesGrants)).toEqual({
      OR: [
        { lead: { lead_assignees: { some: { user_id: 'u1' } } } },
        { AND: [{ lead_id: null }, { created_by: 'u1' }] },
      ],
    });
  });
});
