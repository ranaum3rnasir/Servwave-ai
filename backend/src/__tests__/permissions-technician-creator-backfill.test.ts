/**
 * PR 3 of the technician-ownership spec: the backfill that gives EXISTING organizations the same
 * creator-control grants `defaultGrants.ts` seeds into new ones.
 *
 * Two organizations get their permissions from two different places and they must not drift:
 *   new org      -> DEFAULT_GRANTS, at org-create time
 *   existing org -> 20260805150000_technician_creator_control_grants/migration.sql
 *
 * So the assertions below are not "the SQL mentions the right words". Every condition literal is
 * DERIVED from DEFAULT_GRANTS and then looked for verbatim in the SQL: change the grant table
 * without changing the migration (or vice versa) and this file goes red, which is the only way the
 * two stay in step without a database in the loop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260805150000_technician_creator_control_grants/migration.sql',
);
const sql = () => readFileSync(MIGRATION, 'utf8');

/** The migration with every `--` comment line dropped - just the SQL that actually runs. */
const bareSql = () =>
  sql()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

/** The executable statements, one per trailing semicolon. */
const statements = () =>
  bareSql()
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Multi-visit S8 (D6) dropped `job_assignees` and moved every stored OWN_JOB condition onto the
 * visits path. This migration SHIPPED on 2026-08-05 and is a historical record: it must keep
 * writing the value that was correct then, and S8's own migration repoints those rows forward.
 * The 28 byte-identical migration pins exist precisely to stop a rename sweep editing shipped SQL.
 *
 * So the derivation still starts at DEFAULT_GRANTS - drift between the grant table and this
 * migration is what the file is for - and then un-does S8's repoint. Loosening a pin like this
 * can hide a broken chain, so the companion case below asserts the S8 migration really does carry
 * the matching (old -> new) UPDATE. Together the two say: this migration writes the 2026-08-05
 * shape, S8 carries it to today's shape, and today's shape is DEFAULT_GRANTS'.
 */
const S8_REPOINTS: Array<[pre: string, post: string]> = [
  [
    '{"assignees":{"some":{"user_id":"{{userId}}"}}}',
    '{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}',
  ],
];

function preS8(literal: string): string {
  let out = literal;
  for (const [pre, post] of S8_REPOINTS) out = out.split(post).join(pre);
  return out;
}

/** The exact jsonb literal the migration has to write for a given TECHNICIAN grant. */
function conditionLiteralFor(action: string, subject: string): string {
  const grant = DEFAULT_GRANTS.find(
    (g) => g.role === 'TECHNICIAN' && g.action === action && g.subject === subject,
  );
  expect(grant, `DEFAULT_GRANTS has no TECHNICIAN ${action} ${subject}`).toBeDefined();
  return preS8(JSON.stringify(grant!.conditions));
}

const S8_MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260820120000_visit_teardown_multi_visit_s8/migration.sql',
);

// The own-job condition every gate keys on: it is the STOCK, untouched shape, which is how the
// migration recognises an org whose admin has not re-scoped the Technician role.
const STOCK_OWN_JOB = '{"assignees":{"some":{"user_id":"{{userId}}"}}}';

describe('technician creator-control backfill - it writes what DEFAULT_GRANTS says', () => {
  it.each([
    ['manage_lines', 'Job'],
    ['assign', 'Job'],
    ['unassign', 'Job'],
    ['delete', 'Job'],
    ['read', 'Job'],
  ])('writes the exact %s %s condition from the grant table', (action, subject) => {
    expect(sql()).toContain(`${conditionLiteralFor(action, subject)}'::jsonb`);
  });

  it('hands the shape it writes to S8, which repoints it onto the visits path', () => {
    // The other half of preS8(): without this, un-doing the repoint in the derivation above would
    // let the two migrations silently disagree about what the stored value is.
    const s8 = readFileSync(S8_MIGRATION, 'utf8');
    for (const [pre, post] of S8_REPOINTS) {
      expect(s8).toContain(`SET conditions = '${post}'::jsonb`);
      expect(s8).toContain(`WHERE conditions = '${pre}'::jsonb`);
    }
    // And this migration's own read-Job widen is the OR wrapper around that same pre-shape, which
    // S8 repoints as its literal (b).
    expect(sql()).toContain(`'${conditionLiteralFor('read', 'Job')}'::jsonb`);
    expect(s8).toContain(`WHERE conditions = '${conditionLiteralFor('read', 'Job')}'::jsonb`);
  });

  it.each([
    ['read', 'Pricing'],
    ['create', 'Job'],
    ['create', 'Estimate'],
  ])('inserts %s %s as an UNCONDITIONED row, matching the grant table', (action, subject) => {
    const grant = DEFAULT_GRANTS.find(
      (g) => g.role === 'TECHNICIAN' && g.action === action && g.subject === subject,
    );
    expect(grant, `DEFAULT_GRANTS has no TECHNICIAN ${action} ${subject}`).toBeDefined();
    expect(grant?.conditions).toBeUndefined();
    // The VALUES tuple in the org-wide INSERT, whitespace-insensitive.
    expect(sql().replace(/\s+/g, ' ')).toContain(`('${action}', '${subject}')`);
  });
});

describe('technician creator-control backfill - it leaves a narrowed org alone', () => {
  // Every statement gates on the org's TECHNICIAN `read Job` still carrying the stock own-job
  // condition. An admin who set the Jobs data scope to Team/Location/All, or removed `read Job`
  // outright, has expressed an intent, and a backfill that overrode it would hand a role access
  // nobody asked for. There are four statements; all four must carry the gate.
  it('gates every statement on the stock own-job read condition', () => {
    const stmts = statements();
    expect(stmts).toHaveLength(4);
    // 3 INSERTs (one of them an upsert) + the single read-widening UPDATE.
    for (const s of stmts) {
      expect(s, `statement without the stock-shape gate:\n${s}`).toContain(STOCK_OWN_JOB);
    }
  });

  it('never targets role_permissions by a hardcoded role list alone', () => {
    // Each write is derived FROM an existing row of the org's own Technician grants.
    expect(sql()).toMatch(/FROM role_permissions rp/);
    expect(sql()).toContain("rp.role = 'TECHNICIAN'");
  });
});

describe('technician creator-control backfill - it is safe to run twice', () => {
  it('guards every INSERT on the role/action/subject unique', () => {
    const inserts = sql().split('INSERT INTO role_permissions').length - 1;
    expect(inserts).toBe(3);
    expect(sql().split('ON CONFLICT (organization_id, role, action, subject)').length - 1).toBe(3);
  });

  // `manage_lines Job` is an UPSERT rather than a plain UPDATE: 20260805130000 derived its rows from
  // each org's `update Job` rows, so an org whose TECHNICIAN had no `update Job` never received a
  // `manage_lines Job` row - and an UPDATE would silently leave that org's creators unable to manage
  // lines on their own jobs. The conflict arm still refuses to touch a row an admin has re-scoped.
  it('upserts manage_lines rather than only updating an assumed-existing row', () => {
    const stmt = sql()
      .split('INSERT INTO role_permissions')
      .find((s) => s.includes("'manage_lines'"));
    expect(stmt, 'no manage_lines INSERT found').toBeDefined();
    expect(stmt).toContain('DO UPDATE');
    // The honesty guard on the conflict arm: only a row still holding the stock shape is rewritten.
    expect(stmt).toContain(`WHERE role_permissions.conditions = '${STOCK_OWN_JOB}'::jsonb`);
  });

  it('makes the remaining UPDATE a no-op on a replay by matching on the PRE-state', () => {
    // It only matches rows still holding the old condition, so a second run finds none. Matching on
    // the post-state (or not matching at all) would make a replay rewrite rows an admin had edited.
    const updates = sql().split('UPDATE role_permissions').slice(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`conditions = '${STOCK_OWN_JOB}'::jsonb`);
  });

  it('supplies the app-side defaults raw SQL has to fill in itself (id, updated_at)', () => {
    expect(sql()).toContain('gen_random_uuid()');
    expect(sql()).toMatch(/NOW\(\)/);
  });
});

describe('technician creator-control backfill - statement order', () => {
  // The `read Job` widen REWRITES the condition every other statement gates on, so it has to be
  // last. Moving it up silently turns the whole migration into a no-op.
  it('widens read Job after every statement that gates on the old read Job condition', () => {
    const text = sql();
    const widen = text.indexOf(`SET conditions = '${conditionLiteralFor('read', 'Job')}'::jsonb`);
    expect(widen).toBeGreaterThan(-1);
    const lastInsert = text.lastIndexOf('INSERT INTO role_permissions');
    // -1 would satisfy `< widen` trivially, so assert the anchors EXIST before comparing them.
    expect(lastInsert).toBeGreaterThan(-1);
    expect(lastInsert).toBeLessThan(widen);
    const manageLines = text.indexOf("'manage_lines'");
    expect(manageLines).toBeGreaterThan(-1);
    expect(manageLines).toBeLessThan(widen);
  });
});

describe('technician creator-control backfill - portability', () => {
  it('uses nothing Supabase-only (CI runs it on vanilla postgres:16)', () => {
    // Comments stripped: the header's own portability note names the very things being banned.
    expect(bareSql()).not.toMatch(/\bauth\./);
    expect(bareSql()).not.toMatch(/\b(authenticated|anon|service_role)\b/);
    expect(bareSql()).not.toMatch(/CREATE POLICY/i);
  });
});
