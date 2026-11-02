/**
 * Roles & Permissions, PRD 7, S07.10 - the inventory surfaces on the routed job page's Items tab.
 *
 *   - "Create PO" needs Create purchase orders, and a vendor to pick (View vendors): absent without either.
 *   - The material cost ("Materials purchased (POs)" on the internal costs card) needs BOTH View purchase orders and
 *     See costs. Without both the card is absent and the cost is never even asked for.
 *
 * The person's rules are built from the grants the switches compile into (create / read PurchaseOrder, read Vendor,
 * read Pricing), never from a role name. The HTTP layer is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders, ALL_JOB_ACTIONS } from '@/__tests__/helpers';

import JobDetailPage from '../JobDetailPage';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);

const JOB = {
  id: JOB_ID, job_number: 'J00001', status: 'SCHEDULED', job_type: 'Install', description: 'Replace the unit',
  scope_notes: null, estimated_duration: null, completion_notes: null, scheduled_start: null, scheduled_end: null,
  started_at: null, completed_at: null, cancelled_at: null, cancelled_reason: null,
  created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', dispatcher: null,
  customer: { id: 'c1', first_name: 'Sarah', last_name: 'Johnson', company_name: null, email: 's@example.com', phone: '5125550198' },
  assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
  source_plan_id: null, source_plan: null, actions: ALL_JOB_ACTIONS,
};

const MATERIAL_LINE = {
  id: 'li-1', job_id: JOB_ID, sequence: 1, description: 'Rooftop unit', quantity: 1, unit_price: 4200, unit_cost: 2000,
  markup_percent: null, is_taxable: false, line_total: 4200, discount_type: null, discount_value: null, discount_amount: 0,
  item_type: 'MATERIAL', price_book_item_id: 'pb-1',
};

const requests = () => mockApi.get.mock.calls.map((c) => String(c[0]));
const materialCostCalls = () => requests().filter((u) => u.includes('/material-cost'));

function serve(materialCost: Record<string, unknown> = { jobId: JOB_ID, materialCost: 321.5, lineCount: 2 }) {
  mockApi.get.mockImplementation((async (url: string) => {
    if (url.includes('/material-cost')) return { data: materialCost };
    if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
    if (url.includes('/line-items')) {
      return { data: { lines: [MATERIAL_LINE], billing: { subtotal: 4200, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 4200 } } };
    }
    if (url.includes('/scopes')) return { data: { scopes: [] } };
    if (url.includes('/api/jobs/')) return { data: { job: JOB } };
    return { data: {} };
  }) as typeof mockApi.get);
}

async function openItemsTab(rules: AbilityRule[], materialCost?: Record<string, unknown>) {
  serve(materialCost);
  renderWithProviders(<JobDetailPage />, { ability: buildAbility([{ action: 'read', subject: 'Job' }, { action: 'manage_lines', subject: 'Job' }, { action: 'read', subject: 'Prices' }, ...rules]) });
  await userEvent.click(await screen.findByRole('tab', { name: 'Items' }));
  await screen.findByText('Rooftop unit');
}

const READ_POS: AbilityRule = { action: 'read', subject: 'PurchaseOrder' };
const CREATE_POS: AbilityRule = { action: 'create', subject: 'PurchaseOrder' };
// Create purchase orders needs View purchase orders and Edit purchase orders.
const EDIT_POS: AbilityRule = { action: 'update', subject: 'PurchaseOrder' };
const READ_VENDORS: AbilityRule = { action: 'read', subject: 'Vendor' };
const SEE_COSTS: AbilityRule = { action: 'read', subject: 'Pricing' };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the job page Items tab - Create PO', () => {
  it('shows with Create purchase orders and View vendors', async () => {
    await openItemsTab([READ_POS, EDIT_POS, CREATE_POS, READ_VENDORS]);
    expect(screen.getByRole('button', { name: /create po/i })).toBeInTheDocument();
  });

  it('is absent without Create purchase orders, whatever else the person holds', async () => {
    await openItemsTab([READ_POS, READ_VENDORS, SEE_COSTS]);
    expect(screen.queryByRole('button', { name: /create po/i })).not.toBeInTheDocument();
  });

  it('is absent with Create purchase orders but no View vendors: a new order needs a vendor to pick', async () => {
    await openItemsTab([EDIT_POS, CREATE_POS, READ_POS, SEE_COSTS]);
    expect(screen.queryByRole('button', { name: /create po/i })).not.toBeInTheDocument();
  });
});

describe('the job page Items tab - the material cost', () => {
  const COST_ROW = 'Materials purchased (POs)';

  it('shows with View purchase orders and See costs, and asks for the cost', async () => {
    await openItemsTab([READ_POS, SEE_COSTS]);
    expect(await screen.findByText(COST_ROW)).toBeInTheDocument();
    expect(materialCostCalls()).toHaveLength(1);
  });

  it('is absent, and never requested, with View purchase orders but not See costs', async () => {
    await openItemsTab([READ_POS]);
    expect(screen.queryByText(COST_ROW)).not.toBeInTheDocument();
    expect(materialCostCalls()).toHaveLength(0);
  });

  it('is absent, and never requested, with See costs but not View purchase orders', async () => {
    await openItemsTab([SEE_COSTS]);
    expect(screen.queryByText(COST_ROW)).not.toBeInTheDocument();
    expect(materialCostCalls()).toHaveLength(0);
  });

  it('is absent when the server sends a count and no figure, rather than drawing a blank amount', async () => {
    await openItemsTab([READ_POS, SEE_COSTS], { jobId: JOB_ID, lineCount: 2 });
    expect(screen.queryByText(COST_ROW)).not.toBeInTheDocument();
  });
});
