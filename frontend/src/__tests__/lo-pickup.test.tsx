// Roles & Permissions, PRD 7, slice S07.11 - the pickup mark on a Processed logistic order.
//
// "Taken by me" and "Taken by..." are drawn from the order's own action list (`pick_up`, `record_pickup`), the server's
// answer for this person and this order, on both screens that open the order sheet: the Logistics tab of the routed job
// page and the Logistic Orders tab of the routed Inventory page. A taken order reads "Taken by <name>" (", recorded by
// <name>" when someone else recorded it) and the time. The picker lists the people the server sends, the requester first,
// in a searchable list with a scroller of its own. Role names appear nowhere; the HTTP layer is mocked and the real list
// and sheet are mounted.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders, seedMySwitches, ALL_JOB_ACTIONS } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import type { LogisticOrderDetail, LogisticOrderStatus } from '@/lib/api/logisticOrders';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const ORDER_ID = 'o0000000-0000-0000-0000-000000000001';
const ISO = '2026-07-18T10:00:00.000Z';

vi.mock('@/components/jobs/JobStagesSection', () => ({ JobStagesSection: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: JOB_ID, job_number: 'J00042', status: 'UNSCHEDULED', scope_notes: null, estimated_duration: null,
  completion_notes: null, scheduled_start: null, scheduled_end: null, started_at: null, completed_at: null,
  cancelled_at: null, cancelled_reason: null, created_at: ISO, updated_at: ISO,
  customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
  assignees: [], service_location: null, estimate: null, invoices: [], tags: [], source_plan_id: null,
  actions: ALL_JOB_ACTIONS, source_plan: null, viewer_attached: false,
};

function detail(status: LogisticOrderStatus, actions: LogisticOrderDetail['actions'], over: Partial<LogisticOrderDetail> = {}): LogisticOrderDetail {
  return {
    id: ORDER_ID, number: 'LO00001', seq: 1, status, notes: null, anchors: { jobId: JOB_ID, jobNumber: 'J00042' },
    lines: [{ id: 'l1', itemId: 'i1', itemSku: 'SKU1', itemName: 'Filter 20x20', qty: 2, fromLocationId: 'loc1', fromLocationName: 'Main', sequence: 0 }],
    lineCount: 1, createdBy: { id: 'u1', name: 'Dana' }, submittedBy: null, approvedBy: null, processedBy: null, takenBy: null, recordedBy: null, takenAt: null,
    submittedAt: null, approvedAt: null, processedAt: null, cancelledAt: null, cancelledReason: null,
    createdAt: ISO, updatedAt: ISO, actions, ...over,
  };
}

function serve(order: LogisticOrderDetail, showOrdersPage = true) {
  mockApi.get.mockImplementation((async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: { view_logistic_orders: showOrdersPage }, rules: [] } };
    if (url === `/api/logistic-orders/${ORDER_ID}`) return { data: order };
    if (url === '/api/logistic-orders') {
      const limit = Number(config?.params?.limit ?? 50);
      return { data: { data: limit === 1 ? [] : [{ ...order, lineCount: 1, createdBy: order.createdBy }], page: 1, limit, total: 1 } };
    }
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.includes('/api/jobs/')) return { data: { job: BASE_JOB } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: [{ id: 'loc1', name: 'Main', type: 'warehouse', branch: 'HQ' }] } };
    return { data: { data: [], meta: { total: 0, page: 1, limit: 1, totalPages: 1 }, total: 0 } };
  }) as typeof mockApi.get);
}

const READ_ORDERS: AbilityRule = { action: 'read', subject: 'LogisticOrder' };
const READ_JOBS: AbilityRule = { action: 'read', subject: 'Job' };
const EVERYTHING: AbilityRule[] = [
  READ_ORDERS, READ_JOBS, { action: 'create', subject: 'LogisticOrder' }, { action: 'submit', subject: 'LogisticOrder' },
  { action: 'approve', subject: 'LogisticOrder' }, { action: 'process', subject: 'LogisticOrder' },
  { action: 'cancel', subject: 'LogisticOrder' }, { action: 'update', subject: 'LogisticOrder' }, { action: 'delete', subject: 'LogisticOrder' },
];

const PICK_UP_STAGED: AbilityRule = { action: 'pick_up_staged', subject: 'Inventory' };
const RECORD_FOR_OTHER: AbilityRule = { action: 'record_pickup_for_other', subject: 'Inventory' };

/** Shows the order list on the job page's Logistics tab. */
async function showOnJob(rules: AbilityRule[]) {
  renderWithProviders(<JobDetailPage />, { ability: buildAbility(rules) });
  await userEvent.click(await screen.findByRole('tab', { name: /Logistics/ }));
  await screen.findByText('LO00001');
}

/** Shows the order list on the Inventory page's Logistic Orders tab. */
async function showOnInventory(rules: AbilityRule[]) {
  seedMySwitches({ view_logistic_orders: true });
  renderWithProviders(<InventoryPage />, { initialEntries: ['/inventory/logistic-orders'], ability: buildAbility(rules) });
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

beforeEach(() => {
  vi.clearAllMocks();
});

const PEOPLE_URL = `/api/logistic-orders/${ORDER_ID}/pickup-people`;
const TAKEN_BY_ME_URL = `/api/logistic-orders/${ORDER_ID}/taken-by-me`;
const TAKEN_BY_URL = `/api/logistic-orders/${ORDER_ID}/taken-by`;
const TAKEN_AT = '2026-10-09T14:05:00.000Z';

/** The order as the server answers once Lee Park's pickup is saved. */
const taken = (status: LogisticOrderStatus = 'PROCESSED') =>
  detail(status, [], {
    takenBy: { id: 'u-lee', name: 'Lee Park' }, recordedBy: { id: 'u-lee', name: 'Lee Park' }, takenAt: TAKEN_AT,
  });

/** Serves the order plus the picker's people on top of the usual answers. */
function serveWithPeople(order: LogisticOrderDetail, people: Array<{ id: string; name: string; requester: boolean }> = []) {
  serve(order);
  const base = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: unknown) =>
    url === PEOPLE_URL ? Promise.resolve({ data: { people } }) : base(url, config as never)) as typeof mockApi.get);
}

describe.each(SCREENS)('%s - the pickup buttons follow the order\'s own list', (_screen, open) => {
  it.each<[string, LogisticOrderDetail['actions'], string[], string[]]>([
    ['Taken by me alone', ['pick_up'], ['Taken by me'], ['Taken by...']],
    ['Taken by... alone', ['record_pickup'], ['Taken by...'], ['Taken by me']],
    ['both', ['pick_up', 'record_pickup'], ['Taken by me', 'Taken by...'], []],
    ['neither, though the order could be deleted', ['delete'], [], ['Taken by me', 'Taken by...']],
    ['nothing at all', [], [], ['Taken by me', 'Taken by...']],
  ])('on a Processed order listing %s, for a person whose ability could do everything', async (_name, actions, present, absent) => {
    serve(detail('PROCESSED', actions));
    await open([...EVERYTHING, PICK_UP_STAGED, RECORD_FOR_OTHER]);
    await openOrder();
    await screen.findByText('Filter 20x20');
    for (const name of present) expect(button(name), `${name} should show`).toBeInTheDocument();
    for (const name of absent) expect(button(name), `${name} should not show`).not.toBeInTheDocument();
  });

  it('shows the buttons to a person whose ability is read only when the list names them (the list is the truth, not the ability)', async () => {
    serve(detail('PROCESSED', ['pick_up', 'record_pickup']));
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    expect(await screen.findByRole('button', { name: 'Taken by me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Taken by...' })).toBeInTheDocument();
  });

  it.each<LogisticOrderStatus>(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'RETURNED'])('shows no pickup button on a %s order, whose list does not carry them', async (status) => {
    serve(detail(status, ['delete']));
    await open([...EVERYTHING, PICK_UP_STAGED, RECORD_FOR_OTHER]);
    await openOrder();
    await screen.findByText('Filter 20x20');
    expect(button('Taken by me')).not.toBeInTheDocument();
    expect(button('Taken by...')).not.toBeInTheDocument();
  });

  it('saves "Taken by me" on the server and then shows who took it', async () => {
    serve(detail('PROCESSED', ['pick_up']));
    mockApi.post.mockImplementation((async () => {
      serve(taken());
      return { data: taken() };
    }) as typeof mockApi.post);
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    await userEvent.click(await screen.findByRole('button', { name: 'Taken by me' }));

    expect(mockApi.post).toHaveBeenCalledWith(TAKEN_BY_ME_URL);
    expect(await screen.findByText(/^Taken by Lee Park/)).toBeInTheDocument();
    expect(button('Taken by me')).not.toBeInTheDocument();
  });

  it('says so, in the order\'s own words, when someone took it first', async () => {
    serve(detail('PROCESSED', ['pick_up']));
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'ALREADY_TAKEN', message: 'These parts are already marked as taken.' } } });
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    await userEvent.click(await screen.findByRole('button', { name: 'Taken by me' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('These parts are already marked as taken.');
  });
});

describe.each(SCREENS)('%s - the taken display', (_screen, open) => {
  it('reads "Taken by <name>" and the time, with no recorder when the taker recorded it', async () => {
    serve(taken());
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    const line = await screen.findByText(/^Taken by Lee Park/);
    expect(line.textContent).not.toMatch(/recorded by/);
    expect(line.textContent).toMatch(/Oct 9/);
  });

  it('adds ", recorded by <name>" only when someone else recorded it', async () => {
    serve(detail('PROCESSED', [], {
      takenBy: { id: 'u-lee', name: 'Lee Park' }, recordedBy: { id: 'u-rae', name: 'Rae Roe' }, takenAt: TAKEN_AT,
    }));
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    expect(await screen.findByText(/^Taken by Lee Park, recorded by Rae Roe/)).toBeInTheDocument();
  });

  it('shows nothing about a pickup on an order that is not taken', async () => {
    serve(detail('PROCESSED', []));
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    await screen.findByText('Filter 20x20');
    expect(screen.queryByText(/Taken by/)).not.toBeInTheDocument();
  });

  it('keeps the record on an order that was returned afterwards', async () => {
    serve(taken('RETURNED'));
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    expect(await screen.findByText(/^Taken by Lee Park/)).toBeInTheDocument();
  });
});

describe.each(SCREENS)('%s - "Taken by..." picks the colleague', (_screen, open) => {
  it('lists the people the server returns in its order, the requester first, and saves the chosen one on the server', async () => {
    serveWithPeople(detail('PROCESSED', ['record_pickup']), [
      { id: 'u-dana', name: 'Dana Requester', requester: true },
      { id: 'u-ann', name: 'Ann Baker', requester: false },
      { id: 'u-lee', name: 'Lee Park', requester: false },
    ]);
    mockApi.post.mockResolvedValue({ data: taken() });
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    await userEvent.click(await screen.findByRole('button', { name: 'Taken by...' }));

    const dialog = await screen.findByRole('dialog', { name: 'Who took the parts?' });
    await userEvent.click(await within(dialog).findByRole('combobox'));
    const names = screen.getAllByRole('option').map((o) => (o.textContent ?? '').replace(/Requested$/, '').trim());
    expect(names).toEqual(['Dana Requester', 'Ann Baker', 'Lee Park']);
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Requested');
    await userEvent.click(screen.getByRole('option', { name: /Lee Park/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record pickup' }));

    expect(mockApi.post).toHaveBeenCalledWith(TAKEN_BY_URL, { takenById: 'u-lee' });
  });

  it('stays usable for a company of hundreds of people: a search narrows the list, which scrolls on its own', async () => {
    const crowd = Array.from({ length: 270 }, (_, i) => ({ id: `u-${i}`, name: `Person ${String(i).padStart(3, '0')}`, requester: i === 0 }));
    serveWithPeople(detail('PROCESSED', ['record_pickup']), crowd);
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    await userEvent.click(await screen.findByRole('button', { name: 'Taken by...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Who took the parts?' });
    await userEvent.click(await within(dialog).findByRole('combobox'));

    const search = await screen.findByLabelText('Search options');
    const listbox = screen.getByRole('listbox');
    expect(listbox.closest('[class*="overflow-y-auto"]')).not.toBeNull();
    await userEvent.type(search, 'Person 269');

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Person 269/ })).toBeInTheDocument();
  });

  it('keeps Record pickup unavailable until someone is chosen', async () => {
    serveWithPeople(detail('PROCESSED', ['record_pickup']), [{ id: 'u-ann', name: 'Ann Baker', requester: false }]);
    await open([READ_ORDERS, READ_JOBS]);
    await openOrder();
    await userEvent.click(await screen.findByRole('button', { name: 'Taken by...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Who took the parts?' });

    expect(within(dialog).getByRole('button', { name: 'Record pickup' })).toBeDisabled();
  });
});
