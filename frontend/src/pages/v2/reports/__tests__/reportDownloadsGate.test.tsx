/**
 * Roles & Permissions S07.20 - every report's download button shows only with Export reports.
 *
 * The ability is the server's own grant list: Export reports compiles into `export Report`, so a person is built
 * here from the grant (never from a role name). Access Reports alone opens the report but not its download.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

// Charts measure their container; jsdom has none.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

import { ReportToolbar } from '../components/shared';
import CommissionsReport from '../reports/CommissionsReport';
import CommunicationTrackingReport from '../reports/CommunicationTrackingReport';
import ExpensesReport from '../reports/ExpensesReport';
import CampaignRoiReport from '../reports/CampaignRoiReport';
import EstimatesReport from '../reports/EstimatesReport';

const READS_REPORTS = buildAbility([{ action: 'read', subject: 'Report' }]);
const EXPORTS_REPORTS = buildAbility([
  { action: 'read', subject: 'Report' },
  { action: 'export', subject: 'Report' },
]);

const noop = () => {};

/** Each place a report puts a download button, and the accessible name that button carries. */
const SURFACES: Array<{ name: string; ui: () => ReactElement; button: RegExp }> = [
  { name: 'the compact toolbar (Unpaid Invoices, Invoices, Payments, Job Profitability, Weekly Rep Diagnostic)', ui: () => <ReportToolbar variant="compact" onExport={noop} />, button: /export csv/i },
  {
    name: 'the full toolbar (Jobs, Leads, Sales)',
    ui: () => (
      <ReportToolbar search="" onSearchChange={noop} pageSize={25} onPageSizeChange={noop} pageSizeOptions={[25]} onExport={noop} />
    ),
    button: /^export$/i,
  },
  { name: 'Commissions', ui: () => <CommissionsReport />, button: /^export$/i },
  { name: 'Communication Tracking', ui: () => <CommunicationTrackingReport />, button: /^export$/i },
  { name: 'Expenses', ui: () => <ExpensesReport />, button: /^export$/i },
  { name: 'Campaign ROI', ui: () => <CampaignRoiReport />, button: /^export csv$/i },
  { name: 'Estimates', ui: () => <EstimatesReport />, button: /^export$/i },
];

describe('report download buttons follow Export reports', () => {
  it.each(SURFACES)('$name: no download button for a person who can read reports but not export them', ({ ui, button }) => {
    renderWithProviders(ui(), { ability: READS_REPORTS });
    expect(screen.queryByRole('button', { name: button })).toBeNull();
  });

  it.each(SURFACES)('$name: the download button is there for a person who holds Export reports', ({ ui, button }) => {
    renderWithProviders(ui(), { ability: EXPORTS_REPORTS });
    expect(screen.getByRole('button', { name: button })).toBeInTheDocument();
  });

  it('Commissions: the Export By Mail button follows it too', () => {
    renderWithProviders(<CommissionsReport />, { ability: READS_REPORTS });
    expect(screen.queryByRole('button', { name: /export by mail/i })).toBeNull();
    expect(screen.getByRole('button', { name: /print/i })).toBeInTheDocument();
  });

  it('the full toolbar keeps its search and Fields button without Export reports', () => {
    renderWithProviders(
      <ReportToolbar search="" onSearchChange={noop} pageSize={25} onPageSizeChange={noop} pageSizeOptions={[25]} onExport={noop} onFields={noop} />,
      { ability: READS_REPORTS },
    );
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fields/i })).toBeInTheDocument();
  });
});
