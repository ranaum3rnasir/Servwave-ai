/* The switches migration 20261012120000 wrote, frozen. The catalog keeps growing after that migration ran, so
   "every switch the migration wrote" cannot be read from the live catalog. The data sits in a TypeScript module next
   to this one (presetMigrationSnapshotData.ts), so a compiled build carries it: tsc copies no JSON into dist, and a
   loader that read a file from the tests' folder threw ENOENT there. A test re-parses the migration.sql and fails if
   the two disagree. */
import { PRESET_MIGRATION_SNAPSHOT_DATA } from './presetMigrationSnapshotData';

export interface PresetMigrationSnapshot {
  migration: string;
  switches: Array<{ key: string; kind: 'toggle' | 'choice' | 'list' }>;
  /** role key -> switch key -> the value the migration writes for it. */
  presets: Record<string, Record<string, unknown>>;
}

export function loadPresetMigrationSnapshot(): PresetMigrationSnapshot {
  return structuredClone(PRESET_MIGRATION_SNAPSHOT_DATA);
}

function block(sql: string, step: string): string {
  const start = sql.indexOf(`-- @step ${step}\n`);
  if (start < 0) throw new Error(`step ${step} not found`);
  const end = sql.indexOf('-- @end', start);
  return sql.slice(start, end);
}

/** Reads the switch list and the four preset value sets straight out of a preset migration's SQL. */
export function parsePresetMigrationSql(sql: string, migration: string): PresetMigrationSnapshot {
  const lit = (s: string) => JSON.parse(s.replace(/''/g, "'")) as unknown;
  const switches: PresetMigrationSnapshot['switches'] = [];
  for (const m of block(sql, 's01_22_sw').matchAll(/^\s*\('([a-z0-9_]+)', '(toggle|choice|list)', '.*'::jsonb\),?$/gm)) {
    switches.push({ key: m[1]!, kind: m[2] as PresetMigrationSnapshot['switches'][number]['kind'] });
  }
  const presets: PresetMigrationSnapshot['presets'] = {};
  for (const m of block(sql, 's01_22_pre').matchAll(/^\s*\('([A-Z]+)', '([a-z0-9_]+)', '(.*)'::jsonb\),?$/gm)) {
    (presets[m[1]!] ??= {})[m[2]!] = lit(m[3]!);
  }
  return { migration, switches, presets };
}
