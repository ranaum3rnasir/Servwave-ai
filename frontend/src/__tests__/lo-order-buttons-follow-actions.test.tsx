import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { seedMySwitches, ALL_JOB_ACTIONS } from '@/__tests__/helpers';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { renderInventory } from '@/__tests__/harness/inventoryPage';
import type { LogisticOrderDetail, LogisticOrderStatus } from '@/lib/api/logisticOrders';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/components/jobs/JobStagesSection', () => ({ JobStagesSection: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: __route.id }), useNavigate: () => vi.fn() };
});

const __route = vi.hoisted(() => ({ id: '' }));

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

// The router mock reads the id this block's file used to fix.
beforeEach(() => { __route.id = JOB_ID; });
// Roles & Permissions, PRD 7, slice S07.10 - the buttons on a logistic order follow the order's own action list.
//
// The server answers each order with `actions`: what this person may do to it now (submit, approve, process,
// cancel, edit, delete). The detail sheet draws exactly those. Both screens that list orders open the same sheet:
// the Logistics tab of the routed job page, and the Logistic Orders tab of the routed Inventory page. Each case is
// run on both, with the HTTP layer mocked and the real list and sheet mounted.
//
// The ability each case holds is deliberately NOT the thing under test: a person whose ability could do everything
// gets nothing the list leaves out, and a person whose ability is read only gets what the list names. Role names
// appear nowhere.

stubBrowser();

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const ORDER_ID = 'o0000000-0000-0000-0000-000000000001';
const ISO = '2026-07-18T10:00:00.000Z';

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: JOB_ID, job_number: 'J00042', status: 'UNSCHEDULED', scope_notes: null, estimated_duration: null,
  completion_notes: null, scheduled_start: null, scheduled_end: null, started_at: null, completed_at: null,
  cancelled_at: null, cancelled_reason: null, created_at: ISO, updated_at: ISO,
  customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
  assignees: [], service_location: null, estimate: null, invoices: [], tags: [], source_plan_id: null,
  actions: ALL_JOB_ACTIONS, source_plan: null, viewer_attached: false,
};

function detail(status: LogisticOrderStatus, actions: LogisticOrderDetail['actions']): LogisticOrderDetail {
  return {
    id: ORDER_ID, number: 'LO00001', seq: 1, status, notes: null, anchors: { jobId: JOB_ID, jobNumber: 'J00042' },
    lines: [{ id: 'l1', itemId: 'i1', itemSku: 'SKU1', itemName: 'Filter 20x20', qty: 2, fromLocationId: 'loc1', fromLocationName: 'Main', sequence: 0 }],
    lineCount: 1, createdBy: { id: 'u1', name: 'Dana' }, submittedBy: null, approvedBy: null, processedBy: null, takenBy: null, recordedBy: null, takenAt: null,
    submittedAt: null, approvedAt: null, processedAt: null, cancelledAt: null, cancelledReason: null,
    createdAt: ISO, updatedAt: ISO, actions,
  };
}

function serve(order: LogisticOrderDetail, showOrdersPage = true) {
  serveJobDetail({
    job: BASE_JOB,
    routes: [
      { match: (url) => url === '/api/permission-switches/me', data: { admin_box: false, values: { view_logistic_orders: showOrdersPage }, rules: [] } },
      { match: (url) => url === `/api/logistic-orders/${ORDER_ID}`, data: order },
      {
        match: (url) => url === '/api/logistic-orders',
        data: (config) => {
          const limit = Number(config?.params?.limit ?? 50);
          return { data: limit === 1 ? [] : [{ ...order, lineCount: 1, createdBy: order.createdBy }], page: 1, limit, total: 1 };
        },
      },
      { match: (url) => url.startsWith('/api/inventory/locations'), data: { locations: [{ id: 'loc1', name: 'Main', type: 'warehouse', branch: 'HQ' }] } },
    ],
    otherwise: { data: [], meta: { total: 0, page: 1, limit: 1, totalPages: 1 }, total: 0 },
  });
}

const READ_ORDERS: AbilityRule = { action: 'read', subject: 'LogisticOrder' };
const READ_JOBS: AbilityRule = { action: 'read', subject: 'Job' };
const EVERYTHING: AbilityRule[] = [
  READ_ORDERS, READ_JOBS, { action: 'create', subject: 'LogisticOrder' }, { action: 'submit', subject: 'LogisticOrder' },
  { action: 'approve', subject: 'LogisticOrder' }, { action: 'process', subject: 'LogisticOrder' },
  { action: 'cancel', subject: 'LogisticOrder' }, { action: 'update', subject: 'LogisticOrder' }, { action: 'delete', subject: 'LogisticOrder' },
];

/** Shows the order list on the job page's Logistics tab. */
async function showOnJob(rules: AbilityRule[]) {
  renderJobDetail({ ability: buildAbility(rules) });
  await userEvent.click(await screen.findByRole('tab', { name: /Logistics/ }));
  await screen.findByText('LO00001');
}

/** Shows the order list on the Inventory page's Logistic Orders tab. */
async function showOnInventory(rules: AbilityRule[]) {
  seedMySwitches({ view_logistic_orders: true });
  renderInventory({ entry: '/inventory/logistic-orders', ability: buildAbility(rules) });
  await screen.findByText('LO00001');
}

const SCREENS: Array<[string, (rules: AbilityRule[]) => Promise<void>]> = [
  ['the job page Logistics tab', showOnJob],
  ['the Inventory page Logistic Orders tab', showOnInventory],
];

async function openOrder() {
  await userEvent.click(await screen.findByText('LO00001'));
}

const button = (name: string) => screen.queryByRole('button', { name });

// [what the order is, the list the server sent, the buttons that must show, the ones that must not]
// Written out by hand from the rules, never derived from the code under test.
const CASES: Array<[string, LogisticOrderStatus, LogisticOrderDetail['actions'], string[], string[]]> = [
  ['a draft with Submit', 'DRAFT', ['submit'], ['Submit for approval'], ['Approve', 'Process', 'Cancel order', 'Delete']],
  ['a draft with Process (carried straight through)', 'DRAFT', ['process'], ['Process'], ['Submit for approval', 'Approve', 'Cancel order', 'Delete']],
  ['a draft with Submit and Process: Process wins, one primary action', 'DRAFT', ['submit', 'process'], ['Process'], ['Submit for approval']],
  ['a draft with nothing listed', 'DRAFT', [], [], ['Submit for approval', 'Approve', 'Process', 'Cancel order', 'Delete', 'Save draft']],
  ['a submitted order with Approve', 'PENDING_APPROVAL', ['approve'], ['Approve'], ['Submit for approval', 'Process', 'Cancel order', 'Delete']],
  ['a submitted order with Approve and Process: Approve is the step', 'PENDING_APPROVAL', ['approve', 'process'], ['Approve'], ['Process']],
  ['a submitted order with nothing listed', 'PENDING_APPROVAL', [], [], ['Approve', 'Process', 'Submit for approval']],
  ['an approved order with Process', 'APPROVED', ['process'], ['Process'], ['Approve', 'Submit for approval']],
  ['an approved order with Approve only listed', 'APPROVED', [], [], ['Approve', 'Process']],
  ['an open order with Cancel and Delete', 'PENDING_APPROVAL', ['cancel', 'delete'], ['Cancel order', 'Delete'], ['Approve', 'Process']],
  ['a processed order with Delete', 'PROCESSED', ['delete'], ['Delete'], ['Cancel order', 'Process', 'Approve', 'Submit for approval']],
  ['a cancelled order with Delete', 'CANCELLED', ['delete'], ['Delete'], ['Process', 'Approve', 'Submit for approval']],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(SCREENS)('%s - each order button is present only when the order lists its action', (_screen, open) => {
  it.each(CASES)('%s, for a person whose ability could do everything', async (_name, status, actions, present, absent) => {
    serve(detail(status, actions));
    await open(EVERYTHING);
    await openOrder();
    await screen.findByText('Filter 20x20');
    for (const name of present) expect(button(name), `${name} should show`).toBeInTheDocument();
    for (const name of absent) expect(button(name), `${name} should not show`).not.toBeInTheDocument();
  });

  it('shows Approve to a person whose ability is read only when the list names it (the list is the truth, not the ability)', async () => {
    serve(detail('PENDING_APPROVAL', ['approve']));
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('draws the lines as editable only when Edit is listed', async () => {
    serve(detail('DRAFT', ['submit', 'edit']));
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    expect(await screen.findByLabelText('Search tracked items')).toBeInTheDocument();
  });

  it('draws the lines as read only when Edit is not listed, even for an ability that could edit', async () => {
    serve(detail('DRAFT', ['submit']));
    await open(EVERYTHING);
    await openOrder();
    await screen.findByText('Filter 20x20');
    expect(screen.queryByLabelText('Search tracked items')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeDisabled();
  });
});

describe.each(SCREENS)('%s - the New logistic order button follows Create logistic orders', (_screen, open) => {
  it('shows with Create logistic orders', async () => {
    serve(detail('DRAFT', []));
    // Create logistic orders needs Edit logistic orders.
    await open([READ_ORDERS, READ_JOBS, { action: 'update', subject: 'LogisticOrder' }, { action: 'create', subject: 'LogisticOrder' }]);
    expect(screen.getByRole('button', { name: /New logistic order/ })).toBeInTheDocument();
  });

  it('is absent without it, even for a person who can do everything else to an order', async () => {
    serve(detail('DRAFT', []));
    await open(EVERYTHING.filter((r) => r.action !== 'create'));
    expect(screen.queryByRole('button', { name: /New logistic order/ })).not.toBeInTheDocument();
  });
});

describe('an order opened from the job', () => {
  it('opens with View logistic orders on, and the sheet carries its buttons', async () => {
    serve(detail('PENDING_APPROVAL', ['approve']), false);
    await showOnJob([READ_ORDERS, READ_JOBS]);
    await openOrder();
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('has no orders part at all without View logistic orders, and asks the server for no order', async () => {
    serve(detail('PENDING_APPROVAL', ['approve']), true);
    renderJobDetail({ ability: buildAbility([READ_JOBS]) });
    await screen.findByRole('tab', { name: /Overview/ });
    expect(screen.queryByRole('tab', { name: /Logistics/ })).not.toBeInTheDocument();
    expect(mockApi.get.mock.calls.filter((c) => String(c[0]).startsWith('/api/logistic-orders'))).toHaveLength(0);
  });
});
