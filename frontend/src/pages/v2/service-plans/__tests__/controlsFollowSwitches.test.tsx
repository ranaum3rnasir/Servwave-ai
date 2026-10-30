/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.21 - the Service Plans page's controls follow the module's switches.
   Renders the ROUTED page (pages/v2/service-plans/ServicePlansPage) and its detail sheet.

   New Plan follows Create service plans; Activate, Renew, Cancel plan, Edit default materials and Schedule visit follow
   Edit service plans; Delete follows Delete service plans. Each person below is described by the rules those switches
   compile into (read, create, update, delete on ServicePlan - the pairs the backend catalog emits and the plan routes
   check). The signed-in user's role NAME is the opposite of what an old role-name check wanted, so a page that still
   read the name would answer wrongly in both directions.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import type { ServicePlan } from '@/lib/api/service-plans';

import ServicePlansPage from '../ServicePlansPage';

vi.mock('@/lib/api/users', () => ({ useUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);

const VIEW: AbilityRule = { action: 'read', subject: 'ServicePlan' };
const CREATE: AbilityRule = { action: 'create', subject: 'ServicePlan' };
const EDIT: AbilityRule = { action: 'update', subject: 'ServicePlan' };
const DELETE: AbilityRule = { action: 'delete', subject: 'ServicePlan' };

function plan(overrides: Partial<ServicePlan>): ServicePlan {
  return {
    id: 'plan-1',
    service_plan_number: 'SP00001',
    customer_id: 'cust-1',
    service_location_id: 'loc-1',
    name: 'Quarterly pest control',
    status: 'ACTIVE',
    visit_cadence: 'QUARTERLY',
    interval_unit: null,
    interval_count: null,
    byweekday: [],
    occurrence_count: null,
    start_date: '2026-06-01',
    end_date: '2027-06-01',
    contract_price: '400',
    sold_by: null,
    renewals_count: 0,
    template_id: null,
    line_items: [],
    material_lines: [],
    visits: [],
    invoices: [],
    customer: { id: 'cust-1', company_name: null, first_name: 'Dana', last_name: 'Reyes' },
    service_location: { id: 'loc-1', address_line1: '1 Main St', city: 'Springfield', state: 'IL' },
    planned_visit_count: 4,
    visits_remaining: 2,
    next_due: '2026-12-15',
    due_soon: false,
    overdue: false,
    emphasized: false,
    effective_status: 'ACTIVE',
    ...overrides,
  };
}

const DRAFT = plan({ status: 'DRAFT', effective_status: 'DRAFT' });
const ACTIVE = plan({});

/** The signed-in user's role NAME. No built-in role name may decide anything on this page. */
function signedInWithRoleName(role: string) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000020', email: 'custom@test.com', first_name: 'Cu', last_name: 'Stom', role },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })
  ) as typeof useAuthStore);
}

async function openSheet(rules: AbilityRule[], served: ServicePlan, role: string) {
  signedInWithRoleName(role);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/service-plans') return { data: { servicePlans: [served] } };
    if (url === `/api/service-plans/${served.id}`) return { data: { servicePlan: served } };
    return { data: {} };
  });
  const user = userEvent.setup();
  renderWithProviders(<ServicePlansPage />, { initialEntries: ['/service-plans'], ability: buildAbility(rules) });
  await user.click(await screen.findByText(served.service_plan_number));
  return within(await screen.findByRole('dialog'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the page header', () => {
  it.each(['ADMIN', 'TECHNICIAN'])('offers New Plan to a %s who holds Create service plans', async (role) => {
    signedInWithRoleName(role);
    mockApi.get.mockResolvedValue({ data: { servicePlans: [] } });
    renderWithProviders(<ServicePlansPage />, { ability: buildAbility([VIEW, CREATE]) });
    expect(await screen.findByRole('button', { name: 'New Plan' })).toBeInTheDocument();
  });

  it.each(['ADMIN', 'DISPATCHER'])('hides New Plan from a %s who holds every service plan switch except Create', async (role) => {
    signedInWithRoleName(role);
    mockApi.get.mockResolvedValue({ data: { servicePlans: [] } });
    renderWithProviders(<ServicePlansPage />, { ability: buildAbility([VIEW, EDIT, DELETE]) });
    await screen.findByText('No service plans yet.');
    expect(screen.queryByRole('button', { name: 'New Plan' })).toBeNull();
  });
});

describe('a draft plan', () => {
  it('offers Activate with Edit service plans alone, and no Delete', async () => {
    const sheet = await openSheet([VIEW, EDIT], DRAFT, 'TECHNICIAN');
    expect(await sheet.findByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(sheet.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('offers Delete with Delete service plans alone, and no Activate', async () => {
    const sheet = await openSheet([VIEW, DELETE], DRAFT, 'ADMIN');
    expect(await sheet.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(sheet.queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it('offers Edit for the default materials with Edit service plans', async () => {
    const withEdit = await openSheet([VIEW, EDIT], DRAFT, 'SALES');
    expect(await withEdit.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('offers no control at all to a person who can only view', async () => {
    const sheet = await openSheet([VIEW], DRAFT, 'ADMIN');
    expect(await sheet.findByText('Quarterly pest control')).toBeInTheDocument();
    for (const name of ['Activate', 'Delete', 'Edit']) expect(sheet.queryByRole('button', { name })).toBeNull();
  });
});

describe('an active plan', () => {
  it('offers Renew, Cancel plan and Schedule visit with Edit service plans, and no Delete', async () => {
    const sheet = await openSheet([VIEW, EDIT], ACTIVE, 'TECHNICIAN');
    expect(await sheet.findByRole('button', { name: 'Renew' })).toBeInTheDocument();
    expect(sheet.getByRole('button', { name: 'Cancel plan' })).toBeInTheDocument();
    expect(sheet.getByRole('button', { name: 'Schedule visit' })).toBeInTheDocument();
    expect(sheet.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(sheet.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('offers none of them with Create and Delete service plans but not Edit', async () => {
    const sheet = await openSheet([VIEW, CREATE, DELETE], ACTIVE, 'DISPATCHER');
    expect(await sheet.findByText('Quarterly pest control')).toBeInTheDocument();
    for (const name of ['Renew', 'Cancel plan', 'Schedule visit', 'Edit']) {
      expect(sheet.queryByRole('button', { name })).toBeNull();
    }
    expect(sheet.queryByText('Schedule next visit')).toBeNull();
  });
});
