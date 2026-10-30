/* =============================================================================
   Roles & Permissions security, ticket 36b (M17): Company settings is the Admin flag's alone, and the switch is retired.

   Pure: no database. Reads the catalog, the route files and the source:
     - the `company_settings` switch is gone from the catalog and no switch emits the grants it held (`update` on the company and on
       app settings), so no stored role or person value can open a Company settings route again;
     - the retired-switch list names it, with its migration;
     - every route that asked for that grant now carries the Admin check, and none asks the ability for it any more;
     - every route of a Company settings file is either Admin-checked or a declared read that stays open to everyone, so a route
       added later with no check (or the old check) fails here.
   The behaviour is proven against a real database by permission-company-settings-admin-only-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { PRESET_FOLLOW_UPS } from '../lib/permissions/switches/presetMigrationDrift';
import { scanRouteFiles, isAdminChecked, asksCompanySettingsGrant } from './permission-route-guards-scan';
import { COMPANY_SETTINGS_ROUTES, COMPANY_SETTINGS_FILES, OPEN_READS } from './permission-company-settings-routes';

const ALL = scanRouteFiles();

/** The reads of the company that stay open to everyone, in the one route that serves them. */
const COMPANY_READS = ['organization.routes.ts: GET /', 'organization.routes.ts: GET /preview-pdf'];

describe('Company settings is the Admin flag\'s alone, and the switch is retired', () => {
  it('has no company_settings switch, and its server checks are listed by no switch', () => {
    expect(findSwitch('company_settings')).toBeUndefined();
    const checks = ['organization-update', 'organization-email-sender', 'organization-email-sender-read', 'organization-email-readers-read',
      'org-tax-rate-create', 'job-sub-status-create', 'custom-field-definition-create', 'app-setting-update'];
    const listed = SWITCH_CATALOG.flatMap((s) => s.serverChecks);
    expect(checks.filter((c) => listed.includes(c))).toEqual([]);
  });

  it('has no switch that emits update on the company or on app settings, so nothing but the Admin flag can open a route that asks for it', () => {
    const emitters = SWITCH_CATALOG
      .filter((s) => s.grants.some((g) => g.action === 'update' && (g.subject === 'Organization' || g.subject === 'AppSetting')))
      .map((s) => s.key);
    expect(emitters).toEqual([]);
  });

  it('lists the switch as retired, with its migration', () => {
    const entry = PRESET_FOLLOW_UPS.find((f) => f.migration === '20261029120000_retire_company_settings_switch');
    expect(entry?.retired).toEqual(['company_settings']);
    expect(entry?.moves).toEqual([]);
  });

  it('finds the routes (guards against a scan that reads nothing and so passes)', () => {
    expect(ALL.length).toBeGreaterThan(300);
    expect(ALL.map((r) => r.key)).toEqual(expect.arrayContaining(COMPANY_SETTINGS_ROUTES));
  });

  it('carries the Admin check on every entry point of the retired switch', () => {
    const real = new Map(ALL.map((r) => [r.key, r]));
    expect(COMPANY_SETTINGS_ROUTES.filter((k) => !real.has(k))).toEqual([]);
    expect(COMPANY_SETTINGS_ROUTES.filter((k) => !isAdminChecked(real.get(k)!))).toEqual([]);
  });

  it('has no route that asks the ability for update on the company or on app settings any more', () => {
    expect(ALL.filter(asksCompanySettingsGrant).map((r) => r.key)).toEqual([]);
  });

  it('has no other source that asks for it either', () => {
    const SRC = join(__dirname, '..');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
    const ASKS = /\.can\(\s*['"]update['"]\s*,\s*['"](Organization|AppSetting)['"]|canDo\(\s*['"]update['"]\s*,\s*['"](Organization|AppSetting)['"]/;
    const offenders = walk(SRC).filter((f) => ASKS.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('leaves no route of a Company settings file unchecked unless it is a declared read that stays open', () => {
    const inFiles = ALL.filter((r) => COMPANY_SETTINGS_FILES.includes(r.file));
    expect(inFiles.length).toBeGreaterThan(25);
    const undecided = inFiles.filter((r) => !isAdminChecked(r) && !(r.key in OPEN_READS)).map((r) => r.key);
    expect(undecided).toEqual([]);
    expect(Object.keys(OPEN_READS).filter((k) => !ALL.some((r) => r.key === k))).toEqual([]);
    // A read declared open really is one.
    expect(Object.keys(OPEN_READS).filter((k) => !k.includes(': GET '))).toEqual([]);
  });

  it('keeps the company read open to everyone: it asks for no Admin check', () => {
    const reads = ALL.filter((r) => COMPANY_READS.includes(r.key));
    expect(reads).toHaveLength(COMPANY_READS.length);
    expect(reads.filter(isAdminChecked).map((r) => r.key)).toEqual([]);
    expect(reads.flatMap((r) => r.asks).filter((a) => a.startsWith('canDo:update') || a.startsWith('requireAdmin'))).toEqual([]);
  });

  describe('the check itself', () => {
    it('fails a planted route that still asks for the old grant', () => {
      expect(asksCompanySettingsGrant({ asks: ['canDo:update:Organization'] })).toBe(true);
      expect(asksCompanySettingsGrant({ asks: ["canDoAny:canDoAny([['update','AppSetting']])"] })).toBe(true);
      expect(asksCompanySettingsGrant({ asks: ['requireAdminTo'] })).toBe(false);
    });
  });
});
