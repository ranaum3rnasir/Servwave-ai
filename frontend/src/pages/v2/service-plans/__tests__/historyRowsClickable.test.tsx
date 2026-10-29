import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import type { ServicePlan } from '@/lib/api/service-plans';

import ServicePlansPage from '../ServicePlansPage';

/**
 * #1539 - AC7: a plan with several COMPLETED visits (on distinct dates, so
 * the pre-existing `${plan.id}-${visit.scheduled_date}` key collision is not
 * provoked) renders one History row per visit, and EVERY row opens the SAME
 * parent plan. This is the check that the row's click handler reads a real
 * `planId` field rather than parsing or reusing the composite row key.
 */

vi.mock('@/lib/api/users', () => ({ useUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);

const PLAN_ID = 'plan-1539';

const PLAN: ServicePlan = {
  id: PLAN_ID,
  service_plan_number: 'SP00001',
  customer_id: 'cust-1',
  service_location_id: 'loc-1',
  name: 'qa-1539-Quarterly Pest Control',
  status: 'ACTIVE',
  visit_cadence: 'QUARTERLY',
  interval_unit: null,
  interval_count: null,
  byweekday: [],
  occurrence_count: null,
  start_date: '2026-06-01',
  end_date: null,
  contract_price: '400',
  sold_by: null,
  renewals_count: 0,
  template_id: null,
  line_items: [],
  material_lines: [],
  // Two COMPLETED visits on distinct scheduled dates.
  visits: [
    { status: 'COMPLETED', scheduled_date: '2026-06-15', completed_at: '2026-06-20T10:00:00.000Z' },
    { status: 'COMPLETED', scheduled_date: '2026-09-15', completed_at: '2026-09-20T10:00:00.000Z' },
  ],
  invoices: [],
  customer: { id: 'cust-1', company_name: null, first_name: 'qa-1539-Test', last_name: 'Customer' },
  service_location: { id: 'loc-1', address_line1: '1539 QA Test Street', city: 'Council Bluffs', state: 'IA' },
  planned_visit_count: 4,
  visits_remaining: 2,
  next_due: '2026-12-15',
  due_soon: false,
  overdue: false,
  emphasized: false,
  effective_status: 'ACTIVE',
};

function mockGets() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/service-plans') {
      return Promise.resolve({ data: { servicePlans: [PLAN] } });
    }
    if (url === `/api/service-plans/${PLAN_ID}`) {
      return Promise.resolve({ data: { servicePlan: PLAN } });
    }
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#1539 - History rows for a multi-visit plan all open the same plan', () => {
  it('renders two rows for the two completed visits, and each opens the shared parent plan', async () => {
    mockGets();
    renderWithProviders(<ServicePlansPage />, { initialEntries: ['/service-plans'] });

    await userEvent.click(await screen.findByRole('tab', { name: 'History' }));

    const rows = await screen.findAllByText('SP00001');
    expect(rows).toHaveLength(2);

    // Click the first row - the sheet opens on the fixture plan.
    await userEvent.click(rows[0]!.closest('tr')!);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('qa-1539-Quarterly Pest Control')).toBeInTheDocument();

    // Close it, then click the second row - same plan, not a different id.
    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    await userEvent.click(rows[1]!.closest('tr')!);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('qa-1539-Quarterly Pest Control')).toBeInTheDocument();

    // Never a request for a different plan id.
    const getUrls = mockApi.get.mock.calls.map(([url]) => url);
    expect(getUrls.every((url) => url === '/api/service-plans' || url === `/api/service-plans/${PLAN_ID}`)).toBe(true);
  });
});
