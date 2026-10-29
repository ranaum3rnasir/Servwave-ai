/**
 * The removal of `{{recipient.first_name}}`, held together across the two places it lives.
 *
 * Ran removed the field outright on 2026-09-15 (the reasoning is on `BASE` in catalog.ts). That
 * decision has a code half and a DATA half, and the data half is the one nothing else can check:
 * `20260915170000_drop_recipient_first_name_from_saved_copy` carries a hand-copied table of the
 * nine built-in bodies, because SQL cannot import TypeScript. A copy drifts. If somebody edits a
 * seeded body in defaultAutomations.ts next month, every NEW organisation gets the new wording
 * and every EXISTING one silently keeps whatever that migration froze - with nothing red, and no
 * reader anywhere to notice. These tests are that reader.
 *
 * They are deliberately not written as "the token is absent", which is the shape a removal
 * invites and the shape that passes on a build where nothing loaded at all. Every assertion here
 * either counts something first or asserts a positive string, so an empty registry, an
 * unreadable migration or a truncated file fails instead of reporting green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { TEMPLATES, MERGE_FIELD_LABELS, SAMPLE_CONTEXT } from '../catalog';

const TOKEN = '{{recipient.first_name}}';

/** The migration directory named by the comments on `BASE` and in defaultAutomations.ts. */
const MIGRATION_DIR = '20260915170000_drop_recipient_first_name_from_saved_copy';
const MIGRATION_PATH = resolve(
  __dirname, '..', '..', '..', '..', 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql',
);

/**
 * The (builtin_key, old_body, new_body) rows out of the migration's own VALUES table.
 *
 * Parsed rather than re-declared here: a second hand-written copy of the nine strings in this
 * file would be one more thing to keep in step, which is the exact failure the file exists to
 * prevent.
 */
function migrationPairs(sql: string): { key: string; oldBody: string; newBody: string }[] {
  const re = /\('(default-[a-z-]+)',\s*\n\s*'((?:[^']|'')*)',\s*\n\s*'((?:[^']|'')*)'\)/g;
  return [...sql.matchAll(re)].map((m) => ({
    key: m[1],
    oldBody: m[2].replace(/''/g, "'"),
    newBody: m[3].replace(/''/g, "'"),
  }));
}

describe('the recipient merge field is gone from the code', () => {
  it('no seeded automation references it, and the registry is not empty', () => {
    expect(DEFAULT_AUTOMATIONS.length).toBeGreaterThan(10);
    for (const def of DEFAULT_AUTOMATIONS) {
      expect(def.body.length, `${def.builtin_key} has no body at all`).toBeGreaterThan(20);
      expect(def.body, `${def.builtin_key} body still references the field`).not.toContain('recipient.');
      expect(def.subject, `${def.builtin_key} subject still references the field`).not.toContain('recipient.');
    }
  });

  it('no gallery template offers it, and the gallery is not empty', () => {
    expect(TEMPLATES.length).toBeGreaterThan(5);
    for (const t of TEMPLATES) {
      const copy = JSON.stringify(t.action_config ?? {}) + JSON.stringify(t.steps ?? []);
      expect(copy.length, `${t.key} carries no copy at all`).toBeGreaterThan(10);
      expect(copy, `${t.key} still references the field`).not.toContain('recipient.');
    }
  });

  it('the field has no label and no preview sample, though both tables are populated', () => {
    expect(Object.keys(MERGE_FIELD_LABELS).length).toBeGreaterThan(20);
    expect(Object.keys(SAMPLE_CONTEXT).length).toBeGreaterThan(20);
    expect(MERGE_FIELD_LABELS['recipient.first_name']).toBeUndefined();
    expect(SAMPLE_CONTEXT['recipient.first_name']).toBeUndefined();
  });
});

describe('the data migration still matches the registry it rewrites rows to', () => {
  it('exists at the path both source comments name', () => {
    expect(existsSync(MIGRATION_PATH), `${MIGRATION_DIR} was renamed or removed`).toBe(true);
    for (const rel of ['catalog.ts', 'defaultAutomations.ts']) {
      const src = readFileSync(resolve(__dirname, '..', rel), 'utf8');
      if (src.includes('20260915')) {
        expect(src, `${rel} names a migration directory that does not exist`).toContain(MIGRATION_DIR);
      }
    }
  });

  it('rewrites every seeded body that used to carry the field, and only those', () => {
    const pairs = migrationPairs(readFileSync(MIGRATION_PATH, 'utf8'));
    // The count is pinned from BOTH sides: a pair silently dropped from the SQL, and a tenth
    // seeded body quietly given the token back, are different bugs and both fail here.
    expect(pairs.length, 'the migration VALUES table did not parse').toBe(9);

    for (const { key, oldBody, newBody } of pairs) {
      const def = DEFAULT_AUTOMATIONS.find((d) => d.builtin_key === key);
      expect(def, `${key} is in the migration but not in the registry`).toBeDefined();

      // The whole point: what the migration writes IS what a fresh org is seeded with.
      expect(newBody, `${key} has drifted from defaultAutomations.ts`).toBe(def!.body);

      // And pass 1 is not a no-op. If old and new ever became equal - a regeneration gone
      // wrong - every UPDATE would match, change nothing, and this file would still pass on
      // the assertion above alone.
      expect(oldBody, `${key}'s old body no longer carries the field`).toContain(TOKEN);
      expect(newBody, `${key}'s replacement still carries the field`).not.toContain(TOKEN);
      expect(oldBody).not.toBe(newBody);
    }
  });

  it('keeps a post-condition that FAILS the deploy rather than reporting a notice', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // A survivor mails raw braces to a real person, so a migration that shrugged at one would
    // be worse than no migration: it would carry a green ledger row saying the job was done.
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toContain('RAISE NOTICE');
    expect(sql).toContain('FROM workflow_steps');
    expect(sql).toContain('FROM workflow_versions');
  });
});
