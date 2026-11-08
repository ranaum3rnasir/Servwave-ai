import { describe, it, expect } from 'vitest';
import { canShowReport, isReportVisible, findReport, reportCatalog, type ReportDef } from './report-catalog';
import { reportComponents } from '@/pages/reports/reports-registry';
import { catalogEntry } from '@/lib/entitlements/catalog';

const liveReport: ReportDef = { slug: 'x', label: 'X', icon: (() => null) as never, group: 'Sales', subject: 'Report', live: true };
const mockReport: ReportDef = { slug: 'y', label: 'Y', icon: (() => null) as never, group: 'Sales', subject: 'Report' };
const featureGatedReport: ReportDef = { ...liveReport, feature: 'inventory' };

describe('canShowReport (org-level report gating)', () => {
  it('demo org sees a mock-only report', () => {
    expect(canShowReport(mockReport, true, () => true)).toBe(true);
  });

  it('real org does NOT see a mock-only report (no fabricated data)', () => {
    expect(canShowReport(mockReport, false, () => true)).toBe(false);
  });

  it('real org sees a live (DB-backed) report', () => {
    expect(canShowReport(liveReport, false, () => true)).toBe(true);
  });

  it('demo org sees a live report too', () => {
    expect(canShowReport(liveReport, true, () => true)).toBe(true);
  });

  it('fails closed for an unknown report', () => {
    expect(canShowReport(undefined, true, () => true)).toBe(false);
    expect(canShowReport(undefined, false, () => true)).toBe(false);
  });

  it('hides a live report whose declared feature the org lacks', () => {
    expect(canShowReport(featureGatedReport, false, () => false)).toBe(false);
    expect(canShowReport(featureGatedReport, false, () => true)).toBe(true);
  });

  it('demo org still sees a feature-gated report, and a featureless report ignores the predicate', () => {
    expect(canShowReport(featureGatedReport, true, () => false)).toBe(true);
    expect(canShowReport(liveReport, false, () => false)).toBe(true);
  });
});

describe('isReportVisible - the shared per-card decision carries BOTH axes (the only coverage the mainCards site can have today)', () => {
  it('CASL true + entitlement false + real org -> false', () => {
    expect(
      isReportVisible(featureGatedReport, { canRead: () => true, isDemoOrg: false, hasFeature: () => false }),
    ).toBe(false);
  });

  it('CASL true + entitlement true -> true', () => {
    expect(
      isReportVisible(featureGatedReport, { canRead: () => true, isDemoOrg: false, hasFeature: () => true }),
    ).toBe(true);
  });

  it('CASL false + entitlement true -> false (CASL axis intact)', () => {
    expect(
      isReportVisible(featureGatedReport, { canRead: () => false, isDemoOrg: false, hasFeature: () => true }),
    ).toBe(false);
  });

  it('demo org + entitlement false -> true (mock-first bypass)', () => {
    expect(
      isReportVisible(featureGatedReport, { canRead: () => true, isDemoOrg: true, hasFeature: () => false }),
    ).toBe(true);
  });

  it('undefined report -> false', () => {
    expect(
      isReportVisible(undefined, { canRead: () => true, isDemoOrg: true, hasFeature: () => true }),
    ).toBe(false);
  });
});

describe('every report-declared feature is a real key in the entitlements catalog', () => {
  it('only inventory-usage declares a feature today, and it resolves in the frontend catalog', () => {
    const declaring = reportCatalog.filter((r) => r.feature).map((r) => r.slug);
    expect(declaring).toEqual(['inventory-usage']);
    for (const r of reportCatalog.filter((r) => r.feature)) {
      expect(catalogEntry(r.feature)).toBeDefined();
    }
  });
});

describe('catalog live flags', () => {
  // Regression guard: these are the only reports wired to real data so far.
  // A real org must see exactly this set; flipping more to `live` is intentional
  // and should update this list.
  it('marks exactly the currently-backed reports as live', () => {
    const live = reportCatalog.filter((r) => r.live).map((r) => r.slug).sort();
    expect(live).toEqual([
      'activity', 'estimate-conversion', 'estimates',
      'inventory-usage', 'invoices', 'jobs', 'payments', 'revenue', 'timesheets',
      'unpaid-invoices',
    ]);
  });

  it('estimate-conversion is live', () => {
    expect(findReport('estimate-conversion')?.live).toBe(true);
  });

  // `leads` needs the PRO `leads` feature (lead.routes.ts requireFeature) - a
  // Starter org can't create a lead, so the report is structurally empty for
  // them. `inventory-usage` IS live and stays so - `live` gates the ReportRoute
  // dispatch globally (ReportRoute.tsx), not per-plan; the per-plan gap is now
  // closed separately via `feature` (SRVW-160), which is ANDed with `live` and
  // never a substitute for it. Clearing `live` remains forbidden - it would
  // 404 the feature for every real org, including paying SCALE orgs.
  it('never marks leads live (PRO-gated, empty on Starter)', () => {
    expect(findReport('leads')?.live).toBeFalsy();
  });

  it('does not carry a duplicate live report pointing at the same page', () => {
    // payments-list was retired: it and `payments` both rendered PaymentsReport.
    expect(findReport('payments-list')).toBeUndefined();
  });
});

describe('registry ↔ catalog parity (no ungated direct-URL reports)', () => {
  it('every built report component maps to a catalog slug', () => {
    // A real (non-demo) org sees only mock-free data because ReportRoute gates every
    // catalog report through canShowReport. That gate is keyed on findReport(slug): a
    // registry slug with NO catalog entry makes findReport() return undefined, the gate
    // is skipped, and the built page renders ungated — a direct-URL path to fabricated
    // data for a live client. Keep the registry and catalog in lockstep.
    const orphaned = Object.keys(reportComponents).filter((slug) => !findReport(slug));
    expect(orphaned).toEqual([]);
  });
});
