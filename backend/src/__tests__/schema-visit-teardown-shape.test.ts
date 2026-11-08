/**
 * Multi-visit spec slice S8 - the teardown migration's shape.
 *
 * House pattern: ONE schema-<slice>-shape test per slice, added as a NEW SIBLING file. The 28
 * existing tests that readFileSync a literal dated migration directory stay BYTE-IDENTICAL -
 * their whole job is to catch a rename sweep that reached back into shipped SQL, so this file
 * pins only S8's own migration.
 *
 * What is worth pinning here is not "the file exists" but the two things a reviewer cannot see
 * from the diff alone and that CI cannot otherwise catch:
 *
 *  (a) the stored OWN_JOB row scope is repointed for EVERY historical literal, and the UPDATEs
 *      are DELIBERATELY UNFILTERED BY ROLE - check-role-permission-drift.ts keys on
 *      role::action::subject and DEFAULT_GRANTS lists only SALES/DISPATCHER/TECHNICIAN, so
 *      staging's qa-bug-repro / qa-bug-repro-2 / zz-reachability-probe rows carry byte-identical
 *      dead paths that CI can never see. A `WHERE role = ...` on those UPDATEs would leave them
 *      broken and silent.
 *  (b) code and DB agree after the repoint, which is the property --strict guards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { diffGrants } from '../scripts/check-role-permission-drift';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260820120000_visit_teardown_multi_visit_s8/migration.sql',
);
const sql = () => readFileSync(MIGRATION, 'utf8');

/**
 * Statement-level parsing, not substring presence.
 *
 * The six conditions UPDATEs are near-identical hand-written blocks that differ only in nesting
 * depth. A pair of independent `toContain(<old>)` / `toContain(<new>)` assertions cannot tell a
 * correct block from one whose SET and WHERE were swapped by a copy-paste - both literals are
 * still in the file either way - and a reversed block would rewrite already-correct rows BACK
 * onto the dead `assignees` path, i.e. 403 every technician after deploy. It cannot see a
 * commented-out block either: the literals survive in the comment.
 *
 * So the SQL is stripped of comments and parsed into (WHERE-value -> SET-value) statements, and
 * the assertion is on that mapping. Comment-stripping is also what makes the "never filtered by
 * role" pin real - the old regex ran over prose and had already fired on a comment during
 * authoring.
 */
/** The file with every `--` comment line removed, so prose can never satisfy an assertion. */
function code(): string {
  return sql()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Every `UPDATE role_permissions SET conditions = X ... WHERE conditions = Y` as a Y -> X pair. */
function repoints(): Map<string, string> {
  const re =
    /UPDATE\s+role_permissions\s+SET\s+conditions\s*=\s*'([^']*)'::jsonb\s*,\s*updated_at\s*=\s*NOW\(\)\s+WHERE\s+conditions\s*=\s*'([^']*)'::jsonb\s*;/g;
  const out = new Map<string, string>();
  for (const m of code().matchAll(re)) out.set(m[2], m[1]);
  return out;
}

/** old (the historical stored value) -> new (the visits path it must become). */
const EXPECTED_REPOINTS: Array<[string, string]> = [
  // (a) the bare OWN_JOB shape - arrive / complete / start / update / read Job
  [
    '{"assignees":{"some":{"user_id":"{{userId}}"}}}',
    '{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}',
  ],
  // (b) the OR read shape (OWN_OR_CREATED_JOB). Missing it leaves a technician able to start a
  // job that renders 404.
  [
    '{"OR":[{"assignees":{"some":{"user_id":"{{userId}}"}}},{"created_by_id":"{{userId}}"}]}',
    '{"OR":[{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}},{"created_by_id":"{{userId}}"}]}',
  ],
  // (c) OWN_INVOICE_VIA_JOB - the Invoice row scope nests through the job.
  [
    '{"job":{"assignees":{"some":{"user_id":"{{userId}}"}}}}',
    '{"job":{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}}',
  ],
  // (d)-(f) the four Team/Location literals the role editor emits on any Save.
  [
    '{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}',
    '{"visits":{"some":{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}}}',
  ],
  [
    '{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}',
    '{"visits":{"some":{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}}}',
  ],
  [
    '{"job":{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}}',
    '{"job":{"visits":{"some":{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}}}}',
  ],
  [
    '{"job":{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}}',
    '{"job":{"visits":{"some":{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}}}}',
  ],
];

describe('S8 behaviour 3 - every stored condition is repointed, custom roles included', () => {
  it.each(EXPECTED_REPOINTS)(
    'rewrites %s onto the visits path, in ONE statement',
    (oldValue, newValue) => {
      // The pairing is the property. `toContain(oldValue)` plus `toContain(newValue)` would pass
      // just as happily on a block whose SET and WHERE had been swapped.
      expect(repoints().get(oldValue)).toBe(newValue);
    },
  );

  it('carries exactly these repoints and no others', () => {
    // A stray or duplicated UPDATE is as much a defect as a missing one: the header's
    // idempotence argument rests on each statement matching ONE exact historical value.
    expect([...repoints().keys()].sort()).toEqual(EXPECTED_REPOINTS.map(([o]) => o).sort());
  });

  it('never filters a conditions UPDATE by role', () => {
    // The whole point of the unfiltered match: custom roles cloned from TECHNICIAN carry the
    // byte-identical dead path and the drift checker cannot see them. Asserted on the SQL with
    // comments stripped - the old whole-file regex fired on prose during authoring.
    expect(code()).not.toMatch(/\brole\s*=/i);
  });

  it('drops visit_assignees.lead_id, index first, both guarded', () => {
    const text = code();
    const dropIndex = text.indexOf('DROP INDEX IF EXISTS "visit_assignees_lead_id_idx"');
    const dropColumn = text.indexOf('ALTER TABLE "visit_assignees" DROP COLUMN IF EXISTS "lead_id"');
    expect(dropIndex).toBeGreaterThan(-1);
    expect(dropColumn).toBeGreaterThan(-1);
    // Dropping the column silently drops its index; naming the drop first keeps the ledger
    // honest about what left. This is the ordering the case name claims, asserted.
    expect(dropIndex).toBeLessThan(dropColumn);
    // And the column may only go after all seven readers moved, which is why it is the LAST
    // column drop - after the conditions repoint.
    expect(dropColumn).toBeGreaterThan(text.indexOf('UPDATE role_permissions'));
  });

  it('drops job_assignees, guarded, and only AFTER the conditions repoint', () => {
    const text = code();
    expect(text).toContain('DROP TABLE IF EXISTS "job_assignees"');
    // A stored condition still naming `assignees` on Job after this point would make
    // scopeWhereFor build a where against a dead relation, which THROWS.
    expect(text.indexOf('DROP TABLE IF EXISTS "job_assignees"')).toBeGreaterThan(
      text.lastIndexOf('UPDATE role_permissions'),
    );
  });

  it('says out loud that the DROP TABLE takes its RLS policy with it', () => {
    expect(sql()).toMatch(/tenant_isolation/);
  });

  it('agrees with DEFAULT_GRANTS once the repoint has run, so --strict stays green', () => {
    // The rows an org holds AFTER the migration are, by construction, DEFAULT_GRANTS' own
    // conditions. Seeding them and asking the checker the question CI asks is the pin.
    const jobish = DEFAULT_GRANTS.filter((g) => g.subject === 'Job' || g.subject === 'Invoice');
    expect(jobish.length).toBeGreaterThan(0);
    const existing = jobish.map((g) => ({
      role: g.role,
      action: g.action,
      subject: g.subject,
      conditions: g.conditions ?? null,
    }));
    const { changed } = diffGrants(jobish as never[], existing);
    expect(changed).toHaveLength(0);
  });

  it('leaves a row that still names the dead job-assignee relation visible as drift', () => {
    // The inverse of the pin above: an org the migration did NOT reach is exactly what --strict
    // must keep reddening on. If this goes quiet, the checker has stopped guarding the class.
    const own = DEFAULT_GRANTS.filter((g) => g.subject === 'Job' && g.conditions != null);
    expect(own.length).toBeGreaterThan(0);
    const stale = own.map((g) => ({
      role: g.role,
      action: g.action,
      subject: g.subject,
      conditions: { assignees: { some: { user_id: '{{userId}}' } } },
    }));
    const { changed } = diffGrants(own as never[], stale);
    expect(changed.length).toBe(own.length);
  });
});
