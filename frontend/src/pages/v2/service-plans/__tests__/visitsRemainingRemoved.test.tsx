import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import type { ServicePlan } from '@/lib/api/service-plans';

import ServicePlansPage from '../ServicePlansPage';

/**
 * SRVW-230 - "Visits remaining" summed `visits_remaining` across every plan
 * regardless of status, so it mixed cancelled and draft plans in with live
 * ones and never meant anything operationally. This pins its removal and
 * that the remaining tiles reflow to fill the row.
 *
 * `showOverview()` clicks an "Overview" tab if one is still in the strip, and
 * is a no-op once it isn't - so this suite keeps passing whether or not
 * SRVW-229 (promoting the band above the tabs) has landed yet in this tree.
 */

vi.mock('@/lib/api/users', () => ({ useUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);

function mockGets(endpoint: string, data: unknown) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === endpoint) return { data };
    return { data: {} };
  });
}

function plan(overrides: Partial<ServicePlan>): ServicePlan {
  return {
    id: overrides.id ?? 'p1',
    service_plan_number: 'SP-0001',
    customer_id: 'c1',
    service_location_id: 'l1',
    name: 'Comfort Club',
    status: 'ACTIVE',
    visit_cadence: 'MONTHLY',
    interval_unit: null,
    interval_count: null,
    byweekday: [],
    occurrence_count: null,
    start_date: '2026-01-01',
    end_date: null,
    contract_price: 0,
    sold_by: null,
    renewals_count: 0,
    template_id: null,
    line_items: [],
    visits: [],
    customer: { id: 'c1', company_name: 'Acme Co', first_name: null, last_name: null },
    service_location: { id: 'l1', address_line1: '1 Main St', city: 'Austin', state: 'TX' },
    planned_visit_count: null,
    visits_remaining: null,
    next_due: '2026-02-01',
    due_soon: false,
    overdue: false,
    emphasized: false,
    effective_status: 'ACTIVE',
    ...overrides,
  };
}

const PLANS: ServicePlan[] = [
  plan({ id: 'p1', service_plan_number: 'SP-0001', status: 'ACTIVE', effective_status: 'ACTIVE', contract_price: 500, visits_remaining: 3 }),
  plan({ id: 'p2', service_plan_number: 'SP-0002', status: 'ACTIVE', effective_status: 'ACTIVE', contract_price: 700, visits_remaining: 5 }),
  plan({ id: 'p3', service_plan_number: 'SP-0003', status: 'DRAFT', effective_status: 'DRAFT', contract_price: 200, visits_remaining: null }),
  plan({ id: 'p4', service_plan_number: 'SP-0004', status: 'CANCELLED', effective_status: 'CANCELLED', contract_price: 100, visits_remaining: 10 }),
];

/** Every rendered KPI tile, label and value concatenated. */
function tileTexts(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="stat-card"]'))
    .map((tile) => tile.textContent ?? '');
}

/** Click the Overview tab if the strip still has one; a no-op once SRVW-229 removes it. */
async function showOverview() {
  const overviewTab = screen.queryByRole('tab', { name: 'Overview' });
  if (overviewTab) await userEvent.click(overviewTab);
}

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderPage() {
  mockGets('/api/service-plans', { servicePlans: PLANS });
  renderWithProviders(<ServicePlansPage />, { initialEntries: ['/service-plans'] });
  await showOverview();
  expect(await screen.findByText('Total plans')).toBeInTheDocument();
}

describe('service plans Overview KPI tiles', () => {
  it('no longer renders a Visits remaining tile, and the rest reflow to four tiles', async () => {
    await renderPage();

    expect(screen.queryByText('Visits remaining')).not.toBeInTheDocument();
    expect(tileTexts()).toEqual([
      'Total plans4',
      'Active2',
      'Drafts1',
      'Contract revenue (active)$1,200.00',
    ]);
  });

  it('the Drafts and Active tiles agree on what counts as a draft/active plan (denominator check)', async () => {
    await renderPage();

    // p3 is the only DRAFT-status plan, and it is also the only plan whose
    // effective_status is DRAFT - the two fields select the same set, so the
    // tile is not silently miscounting relative to Active's field.
    const draftPlans = PLANS.filter((p) => p.status === 'DRAFT');
    const draftByEffective = PLANS.filter((p) => p.effective_status === 'DRAFT');
    expect(draftPlans.map((p) => p.id)).toEqual(draftByEffective.map((p) => p.id));

    const draftsTile = within(
      screen.getByText('Drafts').closest('[data-slot="stat-card"]') as HTMLElement,
    );
    expect(draftsTile.getByText('1')).toBeInTheDocument();
  });
});
