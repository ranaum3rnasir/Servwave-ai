/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.22 - the preset migration file, against the switch catalog.

   The migration is GENERATED from the catalog, so the presets in it are never a hand copy. These tests
   read the committed file and the catalog and fail when they disagree, which is also what the drift checker
   does against a database. No database needed.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BUILT_IN_ROLES, SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { PRESET_MIGRATION_NAME, planQuery, planStepsFromSql } from '../lib/permissions/switches/presetMigration';

const FILE = join(__dirname, '..', '..', 'prisma', 'migrations', PRESET_MIGRATION_NAME, 'migration.sql');
const sql = readFileSync(FILE, 'utf8');

/** The preset rows the migration carries: role, switch, and the JSON value it stores. */
function carriedPresets(): Array<{ role: string; switchKey: string; value: unknown }> {
  const step = planStepsFromSql(sql).find((s) => s.name === 's01_22_pre');
  expect(step, 'the migration has a preset step').toBeDefined();
  const rows = [...step!.select.matchAll(/\('([A-Z]+)', '([a-z0-9_]+)', '(.*)'::jsonb\)/g)];
  return rows.map((m) => ({ role: m[1]!, switchKey: m[2]!, value: JSON.parse(m[3]!.replace(/''/g, "'")) }));
}

describe('the preset migration file', () => {
  it('carries, for every built-in role, exactly the catalog preset of every switch it names', () => {
    const carried = carriedPresets();
    expect(carried.length).toBeGreaterThan(0);
    for (const { role, switchKey, value } of carried) {
      const entry = findSwitch(switchKey);
      expect(entry, `${switchKey} is in the catalog`).toBeDefined();
      expect(BUILT_IN_ROLES as readonly string[]).toContain(role);
      expect(value, `${role} ${switchKey}`).toEqual(entry!.presets[role as (typeof BUILT_IN_ROLES)[number]]);
    }
  });

  it('carries the same switches for all four roles, and every kind of switch (on/off, choice, list)', () => {
    const carried = carriedPresets();
    const perRole = BUILT_IN_ROLES.map((r) => carried.filter((c) => c.role === r).map((c) => c.switchKey).sort());
    for (const keys of perRole) expect(keys).toEqual(perRole[0]);
    expect(perRole[0]!.length).toBeGreaterThan(0);
    const carriedKeys = new Set(perRole[0]);
    const kinds = new Set(SWITCH_CATALOG.filter((s) => carriedKeys.has(s.key)).map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['choice', 'list', 'toggle']);
    // Every list switch is written as its marker or a fixed subset, never expanded into today's methods.
    for (const c of carried) {
      if (findSwitch(c.switchKey)?.kind === 'list') expect(typeof c.value === 'string' || Array.isArray(c.value)).toBe(true);
    }
  });

  it('keeps Reopen leads on for Sales (Ran, 8 Oct), both in the catalog and in what the migration writes', () => {
    expect(findSwitch('reopen_leads')!.presets.SALES).toBe(true);
    const row = carriedPresets().find((c) => c.role === 'SALES' && c.switchKey === 'reopen_leads');
    expect(row?.value).toBe(true);
  });

  it('writes Edit job line items on for Technician', () => {
    const row = carriedPresets().find((c) => c.role === 'TECHNICIAN' && c.switchKey === 'edit_job_line_items');
    expect(row?.value).toBe(true);
  });

  it('writes no switch the catalog does not hold, so no dashboard, timeclock settings or Cancel leads value can land', () => {
    const named = new Set(carriedPresets().map((c) => c.switchKey));
    for (const retired of ['access_dashboard', 'manage_timeclock_settings', 'cancel_leads']) {
      expect(findSwitch(retired)).toBeUndefined();
      expect(named.has(retired)).toBe(false);
    }
  });

  it('keeps the preview and the migration one text: the dry run runs the migration\'s own steps as one read-only query', () => {
    const query = planQuery(sql, 'SELECT * FROM s01_22_report');
    // It only reads: no statement in it writes or creates anything.
    expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b\s/i);
    const steps = planStepsFromSql(sql);
    expect(steps.map((s) => s.name)).toEqual(expect.arrayContaining(['s01_22_role_plan', 's01_22_user_plan', 's01_22_log_plan', 's01_22_report']));
    for (const s of steps) expect(query).toContain(`${s.name} AS (`);
  });

  it('names no vendor in anything it stores or prints (comments aside)', () => {
    const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\b(ctm|supabase|render|stripe|twilio|resend|quickbooks)\b/i);
  });
});
