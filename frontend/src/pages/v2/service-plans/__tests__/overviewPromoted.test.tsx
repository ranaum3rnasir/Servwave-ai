import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import type { ServicePlan } from '@/lib/api/service-plans';

import ServicePlansPage from '../ServicePlansPage';

/**
 * SRVW-229 - the Overview KPI band sat behind a tab nobody had a reason to
 * click (the page defaults to Plans), so the tiles were never seen on
 * arrival. This suite pins the band's promotion above the TabStrip: it
 * renders on every tab, the "Overview" tab itself is gone, the page still
 * defaults to Plans, and switching tabs does not refetch the underlying
 * query.
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
  plan({ id: 'p1', service_plan_number: 'SP-0001', status: 'ACTIVE', effective_status: 'ACTIVE', contract_price: 500 }),
  plan({ id: 'p2', service_plan_number: 'SP-0002', status: 'ACTIVE', effective_status: 'ACTIVE', contract_price: 700 }),
  plan({ id: 'p3', service_plan_number: 'SP-0003', status: 'DRAFT', effective_status: 'DRAFT', contract_price: 200 }),
  plan({ id: 'p4', service_plan_number: 'SP-0004', status: 'CANCELLED', effective_status: 'CANCELLED', contract_price: 100 }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderPage() {
  mockGets('/api/service-plans', { servicePlans: PLANS });
  renderWithProviders(<ServicePlansPage />, { initialEntries: ['/service-plans'] });
  expect(await screen.findByText('Total plans')).toBeInTheDocument();
}

describe('service plans KPI band promoted above the tabs', () => {
  it('the Overview tab is gone - the strip is Plans, History', async () => {
    await renderPage();

    expect(screen.queryByRole('tab', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Plans', 'History']);
  });

  it('still defaults to the Plans list, with the band already visible - no click needed', async () => {
    await renderPage();

    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('SP-0001')).toBeInTheDocument();
    // The band rendered without the user doing anything - this is the whole
    // point of the promotion.
    expect(screen.getByText('Total plans')).toBeInTheDocument();
  });

  it('the band stays visible after switching to History - not scoped to one panel', async () => {
    await renderPage();

    await userEvent.click(screen.getByRole('tab', { name: 'History' }));

    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Total plans')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('does not refetch when switching tabs', async () => {
    await renderPage();

    const callsAfterMount = mockApi.get.mock.calls.filter(([url]) => url === '/api/service-plans').length;
    expect(callsAfterMount).toBe(1);

    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Plans' }));

    const callsAfterSwitching = mockApi.get.mock.calls.filter(([url]) => url === '/api/service-plans').length;
    expect(callsAfterSwitching).toBe(1);
  });
});
