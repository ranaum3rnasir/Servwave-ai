import { describe, it, expect } from 'vitest';
import { scopeWhereFor, MATCH_NOTHING, type ScopeResource } from '../lib/permissions/scopeWhereFor';
import type { Grant } from '../lib/permissions/defineAbility';

// SQL row-scope must agree with the CASL ability.
//
// `scopeWhereFor` UNIONs ALL `read` grants a person holds for a resource (the grants their switches compile
// into). These pure tests exercise it directly with synthesized read grants: the union semantics, fail-closed,
// and that an own-scoped read never yields {} (org-wide).
//
// OWN_INVOICE_VIA_JOB after {{userId}} substitution (what an own-scoped read carries).
const TECH_ID = '00000000-0000-0000-0000-000000000004';
const INVOICE_OWN = { job: { assignees: { some: { user_id: TECH_ID } } } };
const techUser = { id: TECH_ID, role: 'TECHNICIAN', is_admin: false, department_id: null, location_id: null };

// The role-grant read condition for a team-scoped role (used to prove union, not first-wins).
const TEAM_ID = 'team-1';
const teamUser = { id: 'u-1', role: 'TECHNICIAN', is_admin: false, department_id: TEAM_ID, location_id: null };

function readGrant(resource: ScopeResource, conditions: Record<string, unknown> | null): Grant {
  return { action: 'read', subject: resource, conditions };
}

describe('scopeWhereFor — union of ALL read grants', () => {
  it('a single own-scoped read → that own condition (not MATCH_NOTHING)', () => {
    // A person whose only invoice read is the own-scoped one.
    const grants: Grant[] = [readGrant('Invoice', INVOICE_OWN)];
    expect(scopeWhereFor(techUser, 'Invoice', grants)).toEqual(INVOICE_OWN);
  });

  it('no read grant at all → MATCH_NOTHING (unchanged fail-closed)', () => {
    expect(scopeWhereFor(techUser, 'Invoice', [])).toEqual(MATCH_NOTHING);
  });

  it('ANY unconditional read grant → {} (no restriction), even if another read grant is conditional', () => {
    // An unconditional read beside a conditional one: the unconditional one wins.
    const grants: Grant[] = [readGrant('Invoice', null), readGrant('Invoice', INVOICE_OWN)];
    expect(scopeWhereFor(techUser, 'Invoice', grants)).toEqual({});
  });

  it('multiple distinct conditional read grants → OR of both substituted conditions', () => {
    // A team-scoped read and an own-via-job read. Union, not first-wins.
    // Note the own condition's {{userId}} substitutes to teamUser.id ('u-1'), not TECH_ID.
    const teamCond = { job: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } };
    const ownViaJob = { job: { assignees: { some: { user_id: '{{userId}}' } } } };
    const grants: Grant[] = [readGrant('Invoice', teamCond), readGrant('Invoice', ownViaJob)];
    const out = scopeWhereFor(teamUser, 'Invoice', grants);
    expect(out).toEqual({
      OR: [
        { job: { assignees: { some: { user: { department_id: TEAM_ID } } } } },
        { job: { assignees: { some: { user_id: 'u-1' } } } },
      ],
    });
  });

  it('two conditions where one is fail-closed (team token, null team) → only the satisfiable one (no OR wrapper)', () => {
    // techUser has department_id: null. A team-scoped read fail-closes (MATCH_NOTHING and is dropped);
    // the own-scoped read survives → just that condition.
    const teamCond = { job: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } };
    const grants: Grant[] = [readGrant('Invoice', teamCond), readGrant('Invoice', INVOICE_OWN)];
    expect(scopeWhereFor(techUser, 'Invoice', grants)).toEqual(INVOICE_OWN);
  });

  it('all conditional reads fail-closed (team token, null team) → MATCH_NOTHING', () => {
    const teamCond = { job: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } };
    const grants: Grant[] = [readGrant('Invoice', teamCond)];
    expect(scopeWhereFor(techUser, 'Invoice', grants)).toEqual(MATCH_NOTHING);
  });

  it('duplicate identical conditional reads collapse to a single condition (no redundant OR)', () => {
    const grants: Grant[] = [readGrant('Invoice', INVOICE_OWN), readGrant('Invoice', INVOICE_OWN)];
    expect(scopeWhereFor(techUser, 'Invoice', grants)).toEqual(INVOICE_OWN);
  });

  it('the Admin box → {} regardless of grants', () => {
    const admin = { id: 'a1', role: 'ADMIN', is_admin: true, department_id: null, location_id: null };
    expect(scopeWhereFor(admin, 'Invoice', [readGrant('Invoice', INVOICE_OWN)])).toEqual({});
  });

  it('read grants for OTHER subjects are ignored (subject filter intact)', () => {
    const grants: Grant[] = [readGrant('Job', null), readGrant('Invoice', INVOICE_OWN)];
    // Unconditional read is for Job, not Invoice → Invoice scope is just the own condition.
    expect(scopeWhereFor(techUser, 'Invoice', grants)).toEqual(INVOICE_OWN);
  });

  it('SAFETY: an own-scoped read can NEVER yield {} (org-wide) — it always carries a condition', () => {
    const grants: Grant[] = [readGrant('Invoice', INVOICE_OWN)];
    const out = scopeWhereFor(techUser, 'Invoice', grants);
    expect(out).not.toEqual({});
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });
});
