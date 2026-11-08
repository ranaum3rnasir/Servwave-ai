/**
 * task-people-rule.test.ts - issue 02's rule, and the two places it is written.
 *
 * The rule that decides what a task's `assignee_ids` / `watcher_ids` look like once a user stops
 * being an active member of the org exists TWICE: as `applyTaskPeopleRule` here, and as SQL in
 * the backfill migration. They are supposed to decide the same thing. This file pins the rule
 * case by case, and then re-reads the migration to check the predicates it turns on are still
 * the ones the TypeScript uses.
 *
 * The SQL half cannot be executed here - the whole backend suite runs against a mocked Prisma
 * with no database - so the second describe block is a textual guard, not a proof. It is set up
 * to fail loudly on the edit that would actually cause the drift: someone changing the ordering,
 * the org scope, or the stranded exclusion on one side only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyTaskPeopleRule } from '../deactivation';

const ALIVE        = 'a0000000-0000-0000-0000-00000000a001';
const ALIVE_2      = 'a0000000-0000-0000-0000-00000000a002';
const CREATOR      = 'a0000000-0000-0000-0000-00000000a003';
const ADMIN        = 'a0000000-0000-0000-0000-00000000a004';
const GONE         = 'd0000000-0000-0000-0000-00000000d001';
const GONE_2       = 'd0000000-0000-0000-0000-00000000d002';
const DEAD_CREATOR = 'd0000000-0000-0000-0000-00000000d003';
/** Active - but in another tenant, which the rule must treat exactly like "nobody". */
const FOREIGN      = 'f0000000-0000-0000-0000-00000000f001';

const ACTIVE_HERE = new Set([ALIVE, ALIVE_2, CREATOR, ADMIN]);
const isActiveHere = (id: string) => ACTIVE_HERE.has(id);

const rule = (over: Partial<Parameters<typeof applyTaskPeopleRule>[0]>) =>
  applyTaskPeopleRule({
    assignee_ids: [],
    watcher_ids: [],
    created_by: CREATOR,
    isActiveHere,
    admin: ADMIN,
    ...over,
  });

describe('applyTaskPeopleRule', () => {
  it('drops the departing id and keeps the co-assignee', () => {
    const out = rule({ assignee_ids: [GONE, ALIVE] });
    expect(out.assignee_ids).toEqual([ALIVE]);
    expect(out.handoverTo).toBeNull();
    expect(out.stranded).toBe(false);
  });

  it('hands a task with no surviving assignee to its still-active creator', () => {
    const out = rule({ assignee_ids: [GONE] });
    expect(out).toMatchObject({ assignee_ids: [CREATOR], handoverTo: CREATOR, reason: 'creator', stranded: false });
  });

  it('escalates to the admin when the creator is inactive too', () => {
    const out = rule({ assignee_ids: [GONE], created_by: DEAD_CREATOR });
    expect(out).toMatchObject({ assignee_ids: [ADMIN], handoverTo: ADMIN, reason: 'admin' });
  });

  it('strands the task rather than emptying it when the org offers nobody', () => {
    const out = rule({ assignee_ids: [GONE], created_by: DEAD_CREATOR, admin: null });
    // The ORIGINAL array, unchanged. An empty list is invisible to every view; a wrong one is
    // merely wrong in one.
    expect(out.assignee_ids).toEqual([GONE]);
    expect(out.stranded).toBe(true);
    expect(out.handoverTo).toBeNull();
  });

  // THE regression this file exists for. A sweep that only ever deletes the ONE id it was
  // triggered for reads `[GONE_2, GONE]` as "one assignee left, nothing to repair" and leaves the
  // task assigned solely to a dangling id - the exact defect issue 02 is about. The SQL backfill
  // has never had that hole, because its predicate is "every id that is not active", so a
  // one-id-at-a-time sweep is a silent divergence from the migration.
  it('falls back when EVERY surviving assignee is itself dangling', () => {
    const out = rule({ assignee_ids: [GONE_2, GONE] });
    expect(out).toMatchObject({ assignee_ids: [CREATOR], handoverTo: CREATOR, reason: 'creator' });
  });

  it('treats an id that is active in ANOTHER org as dangling', () => {
    const out = rule({ assignee_ids: [FOREIGN, ALIVE], watcher_ids: [FOREIGN] });
    expect(out.assignee_ids).toEqual([ALIVE]);
    expect(out.watcher_ids).toEqual([]);
  });

  it('filters watchers with no assignee side effects', () => {
    const out = rule({ assignee_ids: [ALIVE, ALIVE_2], watcher_ids: [GONE, ALIVE] });
    expect(out.assignee_ids).toEqual([ALIVE, ALIVE_2]);
    expect(out.watcher_ids).toEqual([ALIVE]);
    expect(out.handoverTo).toBeNull();
  });

  it('leaves an already-empty assignee list alone instead of inventing an owner', () => {
    // Not this rule's defect to fix, and the migration's predicate ("still names a non-active
    // user") does not select such a row either. Divergence here would be a real one.
    const out = rule({ assignee_ids: [], watcher_ids: [GONE] });
    expect(out.assignee_ids).toEqual([]);
    expect(out.stranded).toBe(false);
    expect(out.watcher_ids).toEqual([]);
  });

  it('keeps the creator when they are simply one of the assignees', () => {
    const out = rule({ assignee_ids: [GONE, CREATOR] });
    expect(out.assignee_ids).toEqual([CREATOR]);
    expect(out.handoverTo).toBeNull(); // kept, not handed over - no notification is owed
  });

  it('de-duplicates', () => {
    expect(rule({ assignee_ids: [ALIVE, ALIVE, GONE] }).assignee_ids).toEqual([ALIVE]);
  });
});

describe('the backfill migration still encodes the same rule', () => {
  const sql = readFileSync(
    join(__dirname, '../../../../prisma/migrations/20260825120000_task_people_arrays_drop_inactive/migration.sql'),
    'utf8',
  );

  it.each([
    ['both arrays are filtered on ACTIVE membership', /u\.is_active/],
    ['membership is scoped to the TASK\'s own org, not merely "active somewhere"', /u\.organization_id = t\.organization_id/],
    ['the creator probe carries the same org scope', /u\.organization_id = c\.organization_id/],
    ['escalation is to an ADMIN', /u\.role = 'ADMIN'/],
    ['escalation ordering is longest-serving, tie-broken by id', /ORDER BY u\.created_at ASC, u\.id ASC/],
    ['the creator wins over the admin', /THEN c\.created_by\s+ELSE \(/],
    ['stranded rows are excluded from the UPDATE, not emptied', /b\.reason <> 'stranded'/],
    ['a surviving assignee short-circuits the fallback', /cardinality\(c\.keep\) > 0/],
  ])('%s', (_why, pattern) => {
    expect(sql).toMatch(pattern);
  });

  it('never writes an empty array into assignee_ids', () => {
    // `ARRAY[b.fallback]` is the only value the UPDATE can put there besides a non-empty `keep`,
    // and the `reason <> 'stranded'` filter is what guarantees `fallback` is not null.
    expect(sql).toMatch(/SET assignee_ids = CASE WHEN cardinality\(b\.keep\) > 0 THEN b\.keep ELSE ARRAY\[b\.fallback\] END/);
  });
});
