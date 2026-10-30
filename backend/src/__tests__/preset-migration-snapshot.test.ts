import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadPresetMigrationSnapshot } from '../lib/permissions/switches/presetMigrationSnapshot';
import { parsePresetMigrationSql } from './preset-migration-sql';
import { PRESET_MIGRATION_NAME } from '../lib/permissions/switches/presetMigration';

const SQL = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', PRESET_MIGRATION_NAME, 'migration.sql'), 'utf8');

describe('the frozen snapshot of the preset migration', () => {
  it('agrees with what migration.sql writes, so it cannot drift from the file', () => {
    expect(loadPresetMigrationSnapshot()).toEqual(parsePresetMigrationSql(SQL, PRESET_MIGRATION_NAME));
  });

  it('holds every switch once, with a preset value for each of the four built-in roles', () => {
    const snap = loadPresetMigrationSnapshot();
    const keys = snap.switches.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(210);
    for (const role of ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']) {
      expect(Object.keys(snap.presets[role] ?? {}).sort(), role).toEqual([...keys].sort());
    }
  });
});

describe('the snapshot loader in a compiled build', () => {
  afterEach(() => {
    vi.doUnmock('fs');
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('needs no file on disk: tsc copies no JSON into dist, so the loader must not read the fixtures folder', async () => {
    const gone = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    for (const id of ['fs', 'node:fs']) {
      vi.doMock(id, async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), readFileSync: gone, existsSync: () => false }));
    }
    vi.resetModules();
    const { loadPresetMigrationSnapshot: load } = await import('../lib/permissions/switches/presetMigrationSnapshot.js');
    const snap = load();
    expect(snap.migration).toBe(PRESET_MIGRATION_NAME);
    expect(snap.switches.length).toBe(210);
  });
});
