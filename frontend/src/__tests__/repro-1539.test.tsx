/**
 * Repro for #1539 - Service Plans History tab rows are not clickable.
 *
 * Points at the ROUTED v2 page (`frontend/src/pages/v2/service-plans/ServicePlansPage.tsx`,
 * mounted at `/service-plans` via `pages/v2/routes/service-plans.routes.tsx:32`), not the
 * unrouted v1 twin at `@/pages/service-plans/ServicePlansPage` - the investigation found no
 * route imports the v1 file, so a fix there would turn this test green without changing what a
 * user reaches.
 *
 * `HistoryTab` (v2 ServicePlansPage.tsx:136) renders its completed-visit rows with no `onClick`
 * at all and is never handed the `onOpen` callback the page wires into `PlansTab`
 * (`onOpen={setDetailId}` at the Plans call site, v2 ServicePlansPage.tsx:239). Clicking a
 * History row therefore never opens the v2 `PlanDetailSheet`
 * (`pages/v2/service-plans/components/planDetailSheet.tsx`).
 *
 * The control test below clicks the equivalent Plans-tab row for the SAME plan and asserts the
 * sheet DOES open, proving the harness/mocks are sound and isolating the failure to the History
 * tab's missing wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import type { ServicePlan } from '@/lib/api/service-plans';

vi.mock('@/lib/api/users', () => ({ useUsers: () => ({ data: [] }) }));

import ServicePlansPage from '@/pages/v2/service-plans/ServicePlansPage';

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
  // One COMPLETED visit — the exact shape `HistoryTab`'s useMemo flattens into a row.
  visits: [
    { status: 'COMPLETED', scheduled_date: '2026-06-15', completed_at: '2026-06-20T10:00:00.000Z' },
  ],
  invoices: [],
  customer: { id: 'cust-1', company_name: null, first_name: 'qa-1539-Test', last_name: 'Customer' },
  service_location: { id: 'loc-1', address_line1: '1539 QA Test Street', city: 'Council Bluffs', state: 'IA' },
  planned_visit_count: 4,
  visits_remaining: 3,
  next_due: '2026-09-15',
  due_soon: false,
  overdue: false,
  emphasized: false,
  effective_status: 'ACTIVE',
};

function mockApi() {
  vi.mocked(api).get.mockImplementation((url: string) => {
    if (url === '/api/service-plans') {
      return Promise.resolve({ data: { servicePlans: [PLAN] } });
    }
    if (url === `/api/service-plans/${PLAN_ID}`) {
      return Promise.resolve({ data: { servicePlan: PLAN } });
    }
    return Promise.resolve({ data: {} });
  });
}

describe('#1539 — Service Plans History tab rows are not clickable (v2, routed page)', () => {
  it('control: clicking a Plans-tab row opens PlanDetailSheet', async () => {
    mockApi();
    renderWithProviders(<ServicePlansPage />, { initialEntries: ['/service-plans'] });

    // Default tab is "plans" (v2 ServicePlansPage.tsx:207).
    const plansRow = (await screen.findByText('SP00001')).closest('tr')!;
    await userEvent.click(plansRow);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('qa-1539-Quarterly Pest Control')).toBeInTheDocument();
  });

  it('clicking a History-tab row opens PlanDetailSheet for that visit\'s parent plan', async () => {
    mockApi();
    renderWithProviders(<ServicePlansPage />, { initialEntries: ['/service-plans'] });

    await userEvent.click(await screen.findByRole('tab', { name: 'History' }));

    const historyRow = (await screen.findByText('SP00001')).closest('tr')!;
    await userEvent.click(historyRow);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('qa-1539-Quarterly Pest Control')).toBeInTheDocument();
  });
});
