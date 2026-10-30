/* =============================================================================
   Roles & Permissions alignment, AL-05 (M4 part 2): the applied preset migration still writes See financial data, which a
   later migration renamed to See costs. The drift check follows the rename instead of calling the old key gone, and still
   names a real change to the renamed switch. No database needed.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SWITCH_CATALOG, type SwitchEntry } from '../lib/permissions/switches/catalog';
import { PRESET_MIGRATION_NAME } from '../lib/permissions/switches/presetMigration';
import { loadPresetMigrationSnapshot } from '../lib/permissions/switches/presetMigrationSnapshot';
import { presetMigrationDrift } from '../lib/permissions/switches/presetMigrationDrift';
import { PRESET_FOLLOW_UP_RENAMES, renamedSwitchKey } from '../lib/permissions/switches/presetMigrationRenames';

const BACKEND = join(__dirname, '..', '..');
const sql = readFileSync(join(BACKEND, 'prisma', 'migrations', PRESET_MIGRATION_NAME, 'migration.sql'), 'utf8');
const snapshot = loadPresetMigrationSnapshot();

describe('the drift check and the See financial data -> See costs rename', () => {
  it('lists only renames that the named follow-up migration really makes, and the catalog holds the new key', () => {
    for (const f of PRESET_FOLLOW_UP_RENAMES) {
      const followUp = readFileSync(join(BACKEND, 'prisma', 'migrations', f.migration, 'migration.sql'), 'utf8');
      for (const r of f.renames) {
        expect(followUp, `${r.from} -> ${r.to}`).toContain(`'${r.from}'`);
        expect(followUp, `${r.from} -> ${r.to}`).toContain(`'${r.to}'`);
        expect(SWITCH_CATALOG.some((s) => s.key === r.to), r.to).toBe(true);
        expect(SWITCH_CATALOG.some((s) => s.key === r.from), `${r.from} is gone from the catalog`).toBe(false);
      }
    }
    expect(renamedSwitchKey('see_financial_data')).toBe('see_costs');
  });

  it('does not call the renamed switch removed, since the follow-up carries its stored rows', () => {
    const drift = presetMigrationDrift(sql, snapshot, SWITCH_CATALOG);
    expect(drift.removed).not.toContain('see_financial_data');
    expect(drift.changed.map((c) => c.key)).not.toContain('see_financial_data');
  });

  it('still names a preset that moved on the renamed switch', () => {
    const catalog: readonly SwitchEntry[] = SWITCH_CATALOG.map((s) =>
      s.key === 'see_costs' ? { ...s, presets: { ...s.presets, DISPATCHER: true } } : s,
    );
    const drift = presetMigrationDrift(sql, snapshot, catalog);
    expect(drift.changed).toEqual(expect.arrayContaining([{ key: 'see_financial_data', roles: [{ role: 'DISPATCHER', was: false, now: true }] }]));
  });

  it('still calls a switch removed outright, renamed or not, when no follow-up renames it', () => {
    const catalog = SWITCH_CATALOG.filter((s) => s.key !== 'see_costs' && s.key !== 'reopen_leads');
    const drift = presetMigrationDrift(sql, snapshot, catalog);
    expect(drift.removed).toEqual(expect.arrayContaining(['see_financial_data', 'reopen_leads']));
  });
});
