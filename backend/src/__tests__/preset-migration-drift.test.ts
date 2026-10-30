/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.22 - the drift checker for an APPLIED preset migration.

   The migration has run on staging, so its file can never change. The checker therefore holds the file against
   the frozen snapshot of what it wrote, and reports a catalog change made after it as a follow-up migration to
   write, never as a file to rewrite. No database needed.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SWITCH_CATALOG, type SwitchEntry } from '../lib/permissions/switches/catalog';
import { PRESET_MIGRATION_NAME } from '../lib/permissions/switches/presetMigration';
import { loadPresetMigrationSnapshot } from '../lib/permissions/switches/presetMigrationSnapshot';
import { PRESET_FOLLOW_UPS, formatPresetMigrationDrift, presetMigrationDrift } from '../lib/permissions/switches/presetMigrationDrift';

const BACKEND = join(__dirname, '..', '..');
const FILE = join(BACKEND, 'prisma', 'migrations', PRESET_MIGRATION_NAME, 'migration.sql');
const sql = readFileSync(FILE, 'utf8');
const snapshot = loadPresetMigrationSnapshot();

/** The live catalog with one switch changed, replaced or left out. */
const catalogWith = (key: string, change: (s: SwitchEntry) => SwitchEntry | null): readonly SwitchEntry[] =>
  SWITCH_CATALOG.flatMap((s) => (s.key === key ? (change(s) ? [change(s)!] : []) : [s]));

describe('the drift checker for the applied preset migration', () => {
  it('finds nothing to do on this tree: the file is what the snapshot froze and no carried preset has moved', () => {
    const drift = presetMigrationDrift(sql, snapshot, SWITCH_CATALOG);
    expect(drift.fileEdited).toEqual([]);
    expect(drift.changed).toEqual([]);
    expect(drift.removed).toEqual([]);
    expect(formatPresetMigrationDrift(drift).ok).toBe(true);
  });

  it('does not call a preset drift when a later migration carries the stored rows to the catalog value, and still names one it does not', () => {
    // AL-04 moved seven built-in Technician / Dispatcher presets in 20261028100300_permission_create_requires_edit.
    const move = PRESET_FOLLOW_UPS[0]!;
    const migrationSql = readFileSync(join(BACKEND, 'prisma', 'migrations', move.migration, 'migration.sql'), 'utf8');
    for (const m of move.moves) {
      expect(migrationSql, `${m.role} ${m.key} is in ${move.migration}`).toMatch(
        new RegExp(`\\('${m.role}',\\s*'${m.key}',\\s*'${m.was}'::jsonb,\\s*'${m.now}'::jsonb\\)`),
      );
      const live = SWITCH_CATALOG.find((s) => s.key === m.key)!;
      expect(live.presets[m.role as keyof SwitchEntry['presets']], `${m.role} ${m.key} in the catalog`).toBe(m.now);
    }
    // A catalog value that the follow-up does NOT land on is still drift.
    const catalog = catalogWith('edit_jobs', (s) => ({ ...s, presets: { ...s.presets, TECHNICIAN: false, SALES: !s.presets.SALES } }));
    expect(presetMigrationDrift(sql, snapshot, catalog).changed.map((c) => c.key)).toContain('edit_jobs');
  });

  it('treats a switch added after the migration as fine: a role with no stored row resolves to its preset', () => {
    const drift = presetMigrationDrift(sql, snapshot, SWITCH_CATALOG);
    expect(drift.added).toContain('tasks_scope');
    const report = formatPresetMigrationDrift(drift);
    expect(report.ok).toBe(true);
    expect(report.lines.join('\n')).toMatch(/tasks_scope/);
  });

  it('does not ask for anything when only a grant mapping moved: those are read once, by a migration that has run', () => {
    const catalog = catalogWith('reopen_leads', (s) => ({ ...s, grants: [] }));
    const drift = presetMigrationDrift(sql, snapshot, catalog);
    expect(formatPresetMigrationDrift(drift).ok).toBe(true);
  });

  it('names a switch whose preset changed after the migration, per role, and asks for a follow-up migration', () => {
    const catalog = catalogWith('reopen_leads', (s) => ({ ...s, presets: { ...s.presets, SALES: false } }));
    const drift = presetMigrationDrift(sql, snapshot, catalog);
    expect(drift.changed).toEqual([{ key: 'reopen_leads', roles: [{ role: 'SALES', was: true, now: false }] }]);
    const report = formatPresetMigrationDrift(drift);
    expect(report.ok).toBe(false);
    const text = report.lines.join('\n');
    expect(text).toMatch(/follow-up migration/i);
    expect(text).toMatch(/reopen_leads/);
    expect(text).toMatch(/SALES/);
    expect(text).not.toMatch(/npm run|regenerate|rewrite the/i);
  });

  it('names a choice switch whose preset moved to another option', () => {
    const catalog = catalogWith('jobs_scope', (s) => ({ ...s, presets: { ...s.presets, TECHNICIAN: 'all' } }));
    const drift = presetMigrationDrift(sql, snapshot, catalog);
    expect(drift.changed.map((c) => c.key)).toEqual(['jobs_scope']);
    expect(drift.changed[0]!.roles[0]).toMatchObject({ role: 'TECHNICIAN', now: 'all' });
  });

  it('names a switch that was removed or renamed, and the key the rename now goes by', () => {
    const catalog = catalogWith('reopen_leads', (s) => ({ ...s, key: 'reopen_closed_leads' }));
    const drift = presetMigrationDrift(sql, snapshot, catalog);
    expect(drift.removed).toEqual(['reopen_leads']);
    expect(drift.added).toContain('reopen_closed_leads');
    const report = formatPresetMigrationDrift(drift);
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toMatch(/follow-up migration[\s\S]*reopen_leads/i);
  });

  it('names a switch whose kind changed', () => {
    const catalog = catalogWith('reopen_leads', (s) => ({ ...s, kind: 'choice' as const }));
    expect(presetMigrationDrift(sql, snapshot, catalog).kindChanged).toEqual([{ key: 'reopen_leads', was: 'toggle', now: 'choice' }]);
  });

  it('says the file was edited when it no longer says what the snapshot froze, and still never offers to rewrite it', () => {
    const edited = sql.replace("('SALES', 'reopen_leads', 'true'::jsonb)", "('SALES', 'reopen_leads', 'false'::jsonb)");
    expect(edited).not.toBe(sql);
    const drift = presetMigrationDrift(edited, snapshot, SWITCH_CATALOG);
    expect(drift.fileEdited.length).toBeGreaterThan(0);
    const report = formatPresetMigrationDrift(drift);
    expect(report.ok).toBe(false);
    const text = report.lines.join('\n');
    expect(text).toMatch(/applied/i);
    expect(text).toMatch(/restore|git checkout/i);
    expect(text).not.toMatch(/npm run|regenerate/i);
  });

  it('is what the script runs: exit 0 on this tree, and it leaves the migration file untouched', () => {
    const run = () =>
      execFileSync('npx', ['tsx', 'src/scripts/check-preset-migration.ts', '--check'], { cwd: BACKEND, encoding: 'utf8', stdio: 'pipe' });
    const out = run();
    expect(out).toMatch(/preset migration/i);
    expect(readFileSync(FILE, 'utf8')).toBe(sql);
  }, 60_000);
});
