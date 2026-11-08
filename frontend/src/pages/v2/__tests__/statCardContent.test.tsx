import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobsPage from '../jobs/JobsPage';
import LeadsPage from '../leads/LeadsPage';
import { ReportKpis } from '../reports/components/kpi';

/**
 * A KPI tile shows its TITLE and its NUMBER, and nothing else - unless a call
 * site opts a tile into a second figure of the SAME metric via `detail`
 * (#2011, e.g. a count's worth). None of Leads, Jobs or the report adapter do.
 *
 * StatCard grew two secondary slots - a `delta` chip beside the value and a
 * `meta` caption under it - and every KPI row in the v2 layer filled at least
 * one of them. Most of what they carried was not a trend at all: "All time",
 * "This week", "Completed, unbilled", "materials tracked" are captions wearing
 * a chip, and the few real ones ("-54%", "+4pp vs last mo") are the case the
 * owner ruled on directly. Both slots stay out, at the component and at every
 * call site.
 *
 * Asserted on the tile's whole textContent rather than on the absence of a
 * particular element, because that is the only form that catches a caption
 * moved into some other wrapper instead of removed.
 */

const mockApi = vi.mocked(api);

const PAGINATION = { page: 1, limit: 25, total: 0, totalPages: 1 };

const LEADS_FIXTURE = {
  leads: [],
  pagination: PAGINATION,
  stats: { total: 46, new_this_week: 7, unassigned: 0, won: 18, lost: 5 },
};

const JOBS_FIXTURE = {
  jobs: [],
  pagination: PAGINATION,
  stats: { unassigned: 1, scheduled: 9, in_progress: 1, completed: 20, cancelled: 2, need_invoices: 0 },
};

function mockGets(endpoint: string, data: unknown) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === endpoint) return { data };
    return { data: {} };
  });
}

/** Every rendered tile, as `label` + `value` concatenated with nothing between. */
function tileTexts(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="stat-card"]'))
    .map((tile) => tile.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a v2 KPI tile carries the title and the number only', () => {
  it('leads', async () => {
    mockGets('/api/leads', LEADS_FIXTURE);
    renderWithProviders(<LeadsPage />, {
      ability: buildAbility([{ action: 'read', subject: 'Lead' }]),
      initialEntries: ['/leads'],
    });

    expect(await screen.findByText('Total Leads')).toBeInTheDocument();
    expect(tileTexts()).toEqual([
      'Total Leads46',
      'New This Week7',
      'Unassigned0',
      'Won18',
      'Lost5',
    ]);
  });

  it('jobs', async () => {
    mockGets('/api/jobs', JOBS_FIXTURE);
    renderWithProviders(<JobsPage />, {
      ability: buildAbility([{ action: 'assign', subject: 'Job' }]),
      initialEntries: ['/jobs'],
    });

    expect(await screen.findByText('Unscheduled')).toBeInTheDocument();
    expect(tileTexts()).toEqual([
      'Unscheduled1',
      'Scheduled9',
      'In Progress1',
      'Completed20',
      'Cancelled2',
      'Need Invoices0',
    ]);
  });

  /**
   * The report adapter is the widest call site - every report file hands it the
   * legacy KpiStrip item shape, and it forwarded that shape's `sub` into the
   * chip. `sub` is off `ReportKpiItem` now, so the compiler is what stops it
   * coming back; this case covers the other half, that the adapter does not
   * grow a caption of its own from some other field.
   */
  it('the report KPI adapter renders the title and the number only', () => {
    renderWithProviders(
      <ReportKpis
        items={[
          { label: 'Completed Revenue', value: '$412,900' },
          { label: 'Avg Close Rate', value: '38%' },
        ]}
      />,
      { initialEntries: ['/reports'] },
    );

    expect(tileTexts()).toEqual(['Completed Revenue$412,900', 'Avg Close Rate38%']);
  });
});
