/**
 * Mobile slice 17: the gate's exemption list names EXACTLY the wide admin
 * tables that scroll inside their own box.
 *
 * `ui-kit/lib/intendedScrollers.ts` is the list; the mobile gate imports it.
 * This test holds the list and the code to each other from both sides:
 *   - every adopting table below carries its `scrollBox` name (a table that
 *     loses it would put its sideways scroll back on the page or fail the gate);
 *   - every listed admin name is used by exactly one call site (no stale or
 *     shared names, so one entry is one box);
 *   - no `data-mobile-scroll-x` marker is spelled by hand with an unlisted value.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  ADMIN_SCROLL_TABLES,
  INTENDED_X_SCROLLERS,
} from '@/ui-kit/lib/intendedScrollers';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.(tsx?)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }));

/** `scrollBox="x"`, `scrollBox={'x'}` and `scrollBox={cond ? undefined : 'x'}`. */
const SCROLL_BOX_USE = /scrollBox=(?:"([a-z0-9-]+)"|\{[^}\n]*?['"]([a-z0-9-]+)['"][^}\n]*\})|scrollBoxAttributes\(["']([a-z0-9-]+)["']\)/g;

function uses() {
  const found: Array<{ file: string; name: string }> = [];
  for (const f of FILES) {
    for (const m of f.text.matchAll(SCROLL_BOX_USE)) found.push({ file: f.path, name: (m[1] ?? m[2] ?? m[3])! });
  }
  return found;
}

/** The tables this slice adopts, by the file that renders each. */
const ADOPTED: Record<string, string | string[]> = {
  // The report grid, plus the summary tables inside three reports' cards (mobile slice 75: they were
  // a few px wider than their card at every width, so each scrolled sideways without a name).
  'report-table': [
    'pages/v2/reports/components/reportTable.tsx',
    'pages/v2/reports/reports/ActivityReport.tsx',
    'pages/v2/reports/reports/InventoryUsageReport.tsx',
    'pages/v2/reports/reports/PaymentsReport.tsx',
  ],
  'marketing-channels': 'pages/v2/reports/MarketingAnalyticsPage.tsx',
  'marketing-profitability': 'pages/v2/reports/MarketingAnalyticsPage.tsx',
  'marketing-organic': 'pages/v2/reports/MarketingAnalyticsPage.tsx',
  'settings-users': 'pages/v2/settings/UsersTeamsPage.tsx',
  'settings-locations': 'pages/v2/settings/LocationsPage.tsx',
  'settings-tax-rates': 'pages/settings/TaxRatesPage.tsx',
  'settings-phone-numbers': 'pages/v2/settings/components/callerIdTable.tsx',
  'phone-call-groups': 'components/communication/phone/CallGroups.tsx',
  'phone-call-flows': 'components/communication/phone/CallFlows.tsx',
  'phone-call-log': 'components/communication/phone/CallsView.tsx',
  'phone-numbers': 'components/communication/phone/NumbersView.tsx',
  'inventory-items': 'pages/v2/inventory/InventoryPage.tsx',
  'inventory-assets': 'pages/v2/inventory/components/assetsView.tsx',
  'inventory-low-stock': 'pages/v2/inventory/components/lowStockView.tsx',
  'inventory-activity': 'pages/v2/inventory/components/actionLogView.tsx',
  'inventory-logistic-orders': 'pages/v2/_shared/loList.tsx',
  'inventory-price-book': 'pages/v2/inventory/PriceBookPage.tsx',
  'inventory-purchase-orders-open': 'pages/v2/inventory/PurchaseOrdersPage.tsx',
  'inventory-purchase-orders-history': 'pages/v2/inventory/PurchaseOrdersPage.tsx',
  'inventory-vendors': 'pages/v2/inventory/VendorsPage.tsx',
};

describe('the gate exemption list and the admin tables that use it', () => {
  it('the list names exactly the adopted admin tables', () => {
    expect([...ADMIN_SCROLL_TABLES].sort()).toEqual(Object.keys(ADOPTED).sort());
  });

  it('each adopted table carries its name, in the file that renders it', () => {
    const found = uses();
    for (const [name, file] of Object.entries(ADOPTED)) {
      const files = [...new Set(found.filter((u) => u.name === name).map((u) => u.file))].sort();
      expect(files, name).toEqual([...(Array.isArray(file) ? file : [file])].sort());
    }
  });

  it('no scrollBox names a box the list does not hold', () => {
    const unknown = uses().filter((u) => !(ADMIN_SCROLL_TABLES as readonly string[]).includes(u.name));
    expect(unknown).toEqual([]);
  });

  it('every hand-spelled marker value is on the list', () => {
    const literal = /['"]data-mobile-scroll-x['"]\s*:\s*['"]([^'"]*)['"]|data-mobile-scroll-x="([^"]*)"/g;
    const bad: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(literal)) {
        const value = m[1] ?? m[2] ?? '';
        if (!(INTENDED_X_SCROLLERS as readonly string[]).includes(value)) bad.push(`${f.path}: "${value}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
