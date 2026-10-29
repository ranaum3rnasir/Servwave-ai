// "Outstanding AR" -> "Unpaid Balance": the dashboard KPI, the F4 report and its
// slug are user-facing copy, and "AR" is accountant's jargon the peer products
// deliberately keep out of their own UIs.
//
// The slug carries the extra risk, because a report's slug IS its URL
// (`/reports/:slug`). Renaming it silently retires every bookmark and pasted
// link under the old name, so `RENAMED_REPORT_SLUGS` + the redirect in
// `ReportRoute` are the half of this change that is not cosmetic - and the half
// a later "tidy up the catalog" commit would delete without noticing. These
// assertions are what makes that deletion fail.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';

import { renderWithProviders } from './helpers';
import {
  RENAMED_REPORT_SLUGS,
  findReport,
  reportCatalog,
} from '@/lib/reports/report-catalog';
import { WIDGETS } from '@/components/dashboard/widgetRegistry';
import ReportRoute from '@/pages/v2/reports/ReportRoute';

describe('the F4 report is published under its plain-language slug', () => {
  it('publishes `unpaid-invoices` and no longer publishes `ar-aging`', () => {
    expect(findReport('unpaid-invoices')).toBeDefined();
    expect(findReport('ar-aging')).toBeUndefined();
  });

  it('keeps the F4 code, so this is a rename and not a second report', () => {
    const f4 = reportCatalog.filter((r) => r.code === 'F4');
    expect(f4).toHaveLength(1);
    expect(f4[0]!.slug).toBe('unpaid-invoices');
    expect(f4[0]!.live).toBe(true);
  });

  it('drops "AR" from the label a user reads', () => {
    const label = findReport('unpaid-invoices')!.label;
    expect(label).toBe('Unpaid Invoices & Collections');
    // \bAR\b, not a substring match: "Aging" and "Charge" contain "ar".
    expect(label).not.toMatch(/\bAR\b/);
  });
});

describe('the old report URL still resolves', () => {
  it('maps the retired slug to the current one', () => {
    expect(RENAMED_REPORT_SLUGS['ar-aging']).toBe('unpaid-invoices');
  });

  it('redirects /reports/ar-aging to /reports/unpaid-invoices instead of the "no such report" stub', () => {
    renderWithProviders(
      <Routes>
        <Route path="/reports/:slug" element={<ReportRoute />} />
        <Route path="/reports/unpaid-invoices" element={<div>ARRIVED</div>} />
      </Routes>,
      { initialEntries: ['/reports/ar-aging'] },
    );

    expect(screen.getByText('ARRIVED')).toBeInTheDocument();
  });

  it('leaves a genuinely unknown slug alone, so the redirect is not a catch-all', () => {
    renderWithProviders(
      <Routes>
        <Route path="/reports/:slug" element={<ReportRoute />} />
        <Route path="/reports/unpaid-invoices" element={<div>ARRIVED</div>} />
      </Routes>,
      { initialEntries: ['/reports/no-such-report'] },
    );

    expect(screen.queryByText('ARRIVED')).toBeNull();
  });
});

describe('the dashboard KPI reads "Unpaid Balance"', () => {
  const widget = WIDGETS['kpi.ar']!;

  it('keeps the widget id, so a saved home-page layout survives the rename', () => {
    // The id is persisted in each user's customized layout. Renaming it would
    // silently drop the tile from every dashboard that has been customized.
    expect(widget.id).toBe('kpi.ar');
  });

  it('titles the widget for the customize-home-page picker', () => {
    expect(widget.title).toBe('Unpaid Balance');
  });

  it('renders the new label and no longer renders "Outstanding AR"', () => {
    const navigate = vi.fn();
    renderWithProviders(
      <>{widget.render({
        data: { kpis: { ar: { total: 688682, current: 0, over_30: 15868, over_60: 672813 } } } as never,
        range: '30d',
        navigate,
      })}</>,
    );

    expect(screen.getByText('Unpaid Balance')).toBeInTheDocument();
    expect(screen.queryByText(/Outstanding AR/i)).toBeNull();
  });
});
