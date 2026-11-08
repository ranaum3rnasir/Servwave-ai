import { describe, it, expect } from 'vitest';
import {
  relationScopeFilter,
  anchorInheritedWhere,
  anchorInheritedParentWhere,
} from '../anchorVisibility';
import { MATCH_NOTHING } from '../scopeWhereFor';
// Fixture rows are run through the real emitted `where` (see whereMatcher's
// header for why shape assertions alone would prove nothing here).
import { matchesWhere, type Row } from '../../../__tests__/whereMatcher';

// ─── Grant-shaped scope fragments (verbatim from defaultGrants.ts) ────────────

const ME = 'u-me';
const OTHER = 'u-other';
const OWN_JOB = { assignees: { some: { user_id: ME } } };
const OWN_LEAD = { lead_assignees: { some: { user_id: ME } } };
const OPEN = {}; // ADMIN / any unconditional read

// ─── Fixture comm rows (one per anchor shape) ────────────────────────────────

const jobA = { id: 'job-a', assignees: [{ user_id: ME }] };
const jobB = { id: 'job-b', assignees: [{ user_id: OTHER }] };
const myLead = { id: 'lead-mine', lead_assignees: [{ user_id: ME }] };
const otherLead = { id: 'lead-theirs', lead_assignees: [{ user_id: OTHER }] };

const onJobA: Row = { id: 'r1', job_id: jobA.id, job: jobA, lead_id: null, lead: null, customer_id: null };
const onJobB: Row = { id: 'r2', job_id: jobB.id, job: jobB, lead_id: null, lead: null, customer_id: null };
const onMyLead: Row = { id: 'r3', job_id: null, job: null, lead_id: myLead.id, lead: myLead, customer_id: null };
const onOtherLead: Row = { id: 'r4', job_id: null, job: null, lead_id: otherLead.id, lead: otherLead, customer_id: null };
const customerOnly: Row = { id: 'r5', job_id: null, job: null, lead_id: null, lead: null, customer_id: 'cust-1' };
const vendorOnly: Row = { id: 'r6', job_id: null, job: null, lead_id: null, lead: null, vendor_id: 'vend-1' };
const unanchored: Row = { id: 'r7', job_id: null, job: null, lead_id: null, lead: null };
// The precedence row: persistTransactionalEmail stamps customer_id, lead_id AND
// job_id on the SAME row, so nearly every job-anchored email is also
// customer-anchored (and often lead-anchored). The job must govern.
const onJobBAndCustomer: Row = {
  id: 'r8',
  job_id: jobB.id,
  job: jobB,
  lead_id: otherLead.id,
  lead: otherLead,
  customer_id: 'cust-1',
};

const ALL_ROWS = [onJobA, onJobB, onMyLead, onOtherLead, customerOnly, vendorOnly, unanchored, onJobBAndCustomer];

function visibleIds(where: Record<string, unknown>): string[] {
  return ALL_ROWS.filter((r) => matchesWhere(r, where)).map((r) => r.id as string);
}

// ─── relationScopeFilter ─────────────────────────────────────────────────────

describe('relationScopeFilter', () => {
  it('collapses an EMPTY scope to no filter at all', () => {
    // A `{}` relation filter on a NULLABLE to-one is NOT the no-op that a
    // top-level `{}` is - it asserts a related row exists, which silently drops
    // every unanchored row. Collapsing is the only safe reading.
    expect(relationScopeFilter('job', {})).toEqual({});
  });

  it('nests a conditional scope under the relation key', () => {
    expect(relationScopeFilter('job', OWN_JOB)).toEqual({ job: OWN_JOB });
  });

  it('nests MATCH_NOTHING unchanged (a no-read-grant user matches no anchored row)', () => {
    expect(relationScopeFilter('job', { ...MATCH_NOTHING })).toEqual({ job: { id: { in: [] } } });
  });
});

// ─── anchorInheritedWhere ────────────────────────────────────────────────────

describe('anchorInheritedWhere', () => {
  it('returns {} when BOTH anchors are org-wide (ADMIN / DISPATCHER)', () => {
    expect(anchorInheritedWhere(OPEN, OPEN)).toEqual({});
    expect(visibleIds(anchorInheritedWhere(OPEN, OPEN))).toEqual(ALL_ROWS.map((r) => r.id));
  });

  it('shows a TECHNICIAN their own job comms and NOT another job comms', () => {
    // Technician: OWN_JOB read Job, and a lead read they do not satisfy.
    const where = anchorInheritedWhere(OWN_JOB, { ...MATCH_NOTHING });
    expect(visibleIds(where)).toContain('r1');
    expect(visibleIds(where)).not.toContain('r2');
  });

  it('shows a SALES rep their own lead comms and NOT another rep lead comms', () => {
    const where = anchorInheritedWhere({ ...MATCH_NOTHING }, OWN_LEAD);
    expect(visibleIds(where)).toContain('r3');
    expect(visibleIds(where)).not.toContain('r4');
  });

  it('leaves customer-only, vendor-only and unanchored rows visible ORG-WIDE', () => {
    const where = anchorInheritedWhere(OWN_JOB, OWN_LEAD);
    expect(visibleIds(where)).toEqual(expect.arrayContaining(['r5', 'r6', 'r7']));
  });

  it('keeps unanchored rows visible even when the user has NO read grant at all', () => {
    // Hazard: MATCH_NOTHING is a TOP-LEVEL `id` key. Nested under a relation it
    // means "has a related job whose id is in []", which must not be allowed to
    // leak out and null the unanchored branch too.
    const where = anchorInheritedWhere({ ...MATCH_NOTHING }, { ...MATCH_NOTHING });
    expect(visibleIds(where)).toEqual(['r5', 'r6', 'r7']);
  });

  it('governs a row carrying BOTH job_id and customer_id by the JOB (anchor precedence)', () => {
    // r8 has job_id (job B - not mine), lead_id (not mine) and customer_id.
    // Precedence job > lead > customer means the JOB decides: invisible.
    const where = anchorInheritedWhere(OWN_JOB, OWN_LEAD);
    expect(visibleIds(where)).not.toContain('r8');
    // ...and it is not the customer_id branch quietly rescuing it either:
    expect(matchesWhere({ ...onJobBAndCustomer, job: jobA, job_id: jobA.id }, where)).toBe(true);
  });

  it('governs a lead-anchored-and-customer-anchored row by the LEAD', () => {
    const where = anchorInheritedWhere(OWN_JOB, OWN_LEAD);
    expect(matchesWhere({ ...onOtherLead, customer_id: 'cust-1' }, where)).toBe(false);
    expect(matchesWhere({ ...onMyLead, customer_id: 'cust-1' }, where)).toBe(true);
  });

  it('never emits an empty OR (which would match nothing)', () => {
    const where = anchorInheritedWhere({ ...MATCH_NOTHING }, { ...MATCH_NOTHING });
    expect((where.OR as unknown[]).length).toBeGreaterThan(0);
  });

  it('does not restrict job-anchored rows when only the LEAD scope is conditional', () => {
    const where = anchorInheritedWhere(OPEN, OWN_LEAD);
    expect(visibleIds(where)).toEqual(expect.arrayContaining(['r1', 'r2', 'r8']));
    expect(visibleIds(where)).not.toContain('r4');
  });
});

// ─── anchorInheritedParentWhere ──────────────────────────────────────────────

describe('anchorInheritedParentWhere', () => {
  it('returns {} for an org-wide requester (no parent restriction)', () => {
    expect(anchorInheritedParentWhere('messages', OPEN, OPEN)).toEqual({});
  });

  it('keeps a parent whose child rows include at least one visible message', () => {
    const where = anchorInheritedParentWhere('messages', OWN_JOB, { ...MATCH_NOTHING });
    const threadWithMine = { id: 't1', messages: [onJobB, onJobA] };
    const threadWithoutMine = { id: 't2', messages: [onJobB] };
    expect(matchesWhere(threadWithMine, where)).toBe(true);
    expect(matchesWhere(threadWithoutMine, where)).toBe(false);
  });

  it('keeps a parent whose only message is unanchored', () => {
    const where = anchorInheritedParentWhere('messages', { ...MATCH_NOTHING }, { ...MATCH_NOTHING });
    expect(matchesWhere({ id: 't3', messages: [unanchored] }, where)).toBe(true);
  });
});
