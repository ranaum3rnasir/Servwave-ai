/**
 * QA Fix 2/3 — Entity-wide Tasks tab fetch + Customer/Estimate Tasks tabs
 *
 * FIX A: JobLeadTasksTab calls listTasks({ linked_entity_type, linked_entity_id })
 *   and renders the returned tasks. After a create (modal close) it refetches.
 *
 * FIX B: CustomerDetailPage renders a "Tasks" tab, and (originally)
 *   EstimateDetailPage rendered one too — both mount JobLeadTasksTab with the
 *   entity UUID (not the human-readable number).
 *
 * Re-pointed 2026-07-20 (D5, prototype→ServWave port plan §14.6): the
 * EstimateDetailPage half of FIX B originally exercised `EstimateDetailPage.tsx`,
 * which was dead and unrouted (App.tsx never routed to it — only
 * `/estimates/:id` → `EstimateWorkspacePage`). That page has been deleted; the
 * "EstimateWorkspacePage — Tasks section (FIX B)" describe block below now
 * exercises the real live surface. GAP vs the original intent: Tasks is no
 * longer a clickable tab — EstimateWorkspacePage mounts <JobLeadTasksTab>
 * directly, always visible near the bottom of the page — so the entity-filtered
 * fetch fires on mount, not on a tab click.
 *
 * Re-pointed AGAIN 2026-08-27, for the same reason a second time: `/estimates/:id`
 * moved to the v2 page (`pages/v2/estimates/`) on 2026-08-13 and this suite kept
 * importing the v1 copy at `pages/`, so "the real live surface" above quietly
 * stopped being true. The v1 copy is now deleted and this suite imports the v2
 * page. If a third fork ever appears, the import here is the thing to check first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import * as tasksApi from '@/lib/api/tasks';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { renderWithProviders } from './helpers';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import CustomerDetailPage from '@/pages/CustomerDetailPage';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

// ── Stubs ──────────────────────────────────────────────────────────────────────

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Stub react-router-dom: keep all real exports, mock useParams to return the
// estimate UUID when EstimateDetailPage reads it.
const ESTIMATE_UUID = 'e0000000-0000-0000-0000-000000000099';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: ESTIMATE_UUID }),
    useLocation: () => ({ state: null, pathname: `/estimates/${ESTIMATE_UUID}` }),
  };
});

// Stub CreateTaskModal to avoid portal / Radix complexity in tests.
vi.mock('@/components/tasks/CreateTaskModal', () => ({
  CreateTaskModal: (props: { open: boolean; onOpenChange: (v: boolean) => void }) =>
    props.open ? (
      <div data-testid="create-task-modal">
        <button onClick={() => props.onOpenChange(false)}>Close Modal</button>
      </div>
    ) : null,
}));

// Stub TaskDetailDrawer
vi.mock('@/components/tasks/TaskDetailDrawer', () => ({
  TaskDetailDrawer: () => null,
}));

// Stub TaskCard to render a simple data-testid element. The assignee names are
// rendered too so the stale-card defect (an assignee edit made in the drawer
// leaving the card's avatar stack untouched) is observable from the test.
vi.mock('@/components/tasks/TaskCard', () => ({
  TaskCard: ({ task }: { task: { id: string; title: string; assignees?: { id: string; name: string | null }[] } }) => (
    <div data-testid={`task-card-${task.id}`}>
      {task.title}
      <span data-testid={`task-card-assignees-${task.id}`}>
        {(task.assignees ?? []).map((a) => a.name ?? a.id).join(', ')}
      </span>
    </div>
  ),
}));

// Stub CustomerCommunicationsTab
vi.mock('@/components/communication/CustomerCommunicationsTab', () => ({
  CustomerCommunicationsTab: () => <div data-testid="customer-comms-tab" />,
}));

// Stub heavy dialogs on EstimateWorkspacePage
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));

// Stub the rest of EstimateWorkspacePage's surface — none of it bears on the
// Tasks section, and several sub-components fetch their own data on mount.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({
  EstimateTabs: () => null,
}));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/components/estimates/EstimateReceiptCard', () => ({
  EstimateReceiptCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({
  SignatureCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({
  NotesCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({
  HistoryPanel: () => null,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ENTITY_UUID = 'a1b2c3d4-0000-0000-0000-000000000001';
const TASK_UUID_1 = 't0000000-0000-0000-0000-000000000001';
const TASK_UUID_2 = 't0000000-0000-0000-0000-000000000002';
const CUSTOMER_UUID = 'c0000000-0000-0000-0000-000000000099';

function makeTask(id: string, title: string) {
  return {
    id,
    task_number: 'T00001',
    title,
    description: '',
    status: 'TODO' as const,
    priority: 'MEDIUM' as const,
    assignee_ids: ['user-1'],
    assignees: [{ id: 'user-1', name: 'Casey Field' }],
    watcher_ids: [],
    due_at: null,
    linked_entity: { type: 'JOB' as const, id: ENTITY_UUID, label: 'J00001' },
    tags: [],
    subtasks: [],
    created_by: 'user-1',
    created_at: '2026-06-18T00:00:00.000Z',
    updated_at: '2026-06-18T00:00:00.000Z',
    completed_at: null,
    activity: [],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
  };
}

const ENTITY_TASKS = [makeTask(TASK_UUID_1, 'Inspect HVAC unit'), makeTask(TASK_UUID_2, 'Replace filter')];

const CUSTOMER_FIXTURE = {
  id: CUSTOMER_UUID,
  customer_number: 'C00099',
  first_name: 'Test',
  last_name: 'Customer',
  company_name: null,
  email: 'test@example.com',
  extra_emails: [],
  phone: '5551234567',
  phone_ext: null,
  secondary_phone: null,
  secondary_phone_ext: null,
  ad_source: null,
  allow_billing: false,
  tax_exempt: false,
  payment_type: null,
  notes: [],
  is_active: true,
  archived_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  service_locations: [],
  _count: { jobs: 0, leads: 0 },
  jobs: [],
};

const CUSTOMER_SUMMARY = {
  financials: {
    lifetime_revenue: 0,
    total_invoiced: 0,
    past_due_balance: 0,
    due_balance: 0,
    paid_invoice_count: 0,
    unpaid_invoice_count: 0,
  },
  estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
  deposits: { collected: 0, pending: 0 },
};

const ESTIMATE_FIXTURE = {
  id: ESTIMATE_UUID,
  lead_id: 'lead-99',
  estimate_number: 'E00099',
  name: null,
  status: 'DRAFT',
  sent_at: null,
  approved_at: null,
  declined_at: null,
  expired_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  scopes: [],
  scope_notes: null,
  tax_rate: '0.00',
  subtotal: '0.00',
  tax_amount: '0.00',
  total_amount: '0.00',
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: '0.00',
  signature_data: null,
  signature_ip: null,
  signature_at: null,
  valid_until: null,
  public_token: null,
  created_by: 'user-1',
  created_at: '2026-06-18T00:00:00.000Z',
  updated_at: '2026-06-18T00:00:00.000Z',
  lead: {
    id: 'lead-99',
    // Real Prisma LeadStatus value. Was 'ESTIMATING', which is not a LeadStatus
    // member at all - see the lead domain in design-system/status-registry.ts.
    status: 'ESTIMATED',
    service_request: 'AC repair',
    service_address_line1: '100 Test St',
    service_address_line2: null,
    service_city: 'Austin',
    service_state: 'TX',
    service_zip: '78701',
    walkthrough_scheduled_at: null,
    walkthrough_completed_at: null,
    walkthrough_notes: null,
    walkthrough_performers: [],
    customer: {
      id: 'cust-lead-99',
      first_name: 'Alice',
      last_name: 'Smith',
      company_name: null,
      email: 'alice@test.com',
      phone: '5550001111',
      service_locations: [],
    },
  },
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  job: null,
  invoices: [],
  send_config: null,
};

// ── FIX A: JobLeadTasksTab entity-filtered fetch ───────────────────────────────

describe('JobLeadTasksTab — entity-filtered server fetch (FIX A)', () => {
  let listTasksSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // The drawer store is module state shared by every test in this file.
    useTaskDetailStore.setState({ openTaskId: null });
    listTasksSpy = vi
      .spyOn(tasksApi, 'listTasks')
      .mockResolvedValue(ENTITY_TASKS);
  });

  it('calls listTasks with linked_entity_type and linked_entity_id on mount', async () => {
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'JOB', id: ENTITY_UUID, label: 'J00001' }} />
    );

    await waitFor(() => {
      expect(listTasksSpy).toHaveBeenCalledWith({
        linked_entity_type: 'JOB',
        linked_entity_id: ENTITY_UUID,
      });
    });
  });

  it('renders the tasks returned by the entity-filtered call', async () => {
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'JOB', id: ENTITY_UUID, label: 'J00001' }} />
    );

    await screen.findByTestId(`task-card-${TASK_UUID_1}`);
    expect(screen.getByText('Inspect HVAC unit')).toBeInTheDocument();
    expect(screen.getByText('Replace filter')).toBeInTheDocument();
  });

  it('shows the correct task count in the header', async () => {
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'JOB', id: ENTITY_UUID, label: 'J00001' }} />
    );

    await waitFor(() => {
      // SectionCard renders the title and count as separate nodes
      // ("Tasks" + a "(2)" suffix span), so assert the count via the heading.
      const heading = screen.getByText('Tasks', { selector: 'h3' });
      expect(heading.textContent).toContain('(2)');
    });
  });

  it('refetches entity tasks when the CreateTaskModal closes', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'JOB', id: ENTITY_UUID, label: 'J00001' }} />
    );

    // Wait for initial fetch
    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledTimes(1));

    // Open the modal
    await user.click(screen.getByRole('button', { name: /\+ New task/i }));
    expect(screen.getByTestId('create-task-modal')).toBeInTheDocument();

    // Close the modal (simulates successful create)
    await user.click(screen.getByRole('button', { name: /Close Modal/i }));

    // Should refetch
    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledTimes(2));
    // The second call should still use the entity params
    expect(listTasksSpy).toHaveBeenNthCalledWith(2, {
      linked_entity_type: 'JOB',
      linked_entity_id: ENTITY_UUID,
    });
  });

  // ── Stale-card defect (#1718's class) ───────────────────────────────────────
  // The tab holds its rows in LOCAL state; every drawer edit writes to
  // `useTasksStore.tasks`, a different array. Without a refresh the card under
  // the drawer keeps the pre-edit assignee stack until a full page reload.

  it('refetches entity tasks when the detail drawer closes, so a drawer edit reaches the card', async () => {
    const EDITED = [
      {
        ...makeTask(TASK_UUID_1, 'Inspect HVAC unit'),
        assignee_ids: ['user-2'],
        assignees: [{ id: 'user-2', name: 'Dana Rivera' }],
      },
      makeTask(TASK_UUID_2, 'Replace filter'),
    ];

    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'JOB', id: ENTITY_UUID, label: 'J00001' }} />
    );

    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId(`task-card-assignees-${TASK_UUID_1}`).textContent).toBe('Casey Field');

    // Open the drawer on this task. Opening alone must NOT refetch.
    act(() => { useTaskDetailStore.getState().open(TASK_UUID_1); });
    expect(listTasksSpy).toHaveBeenCalledTimes(1);

    // The edit lands in the tasks store, which this tab does not read from.
    listTasksSpy.mockResolvedValue(EDITED);

    act(() => { useTaskDetailStore.getState().close(); });

    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId(`task-card-assignees-${TASK_UUID_1}`).textContent).toBe('Dana Rivera')
    );

    // The refresh must still be the ENTITY-FILTERED call: the tab shows only
    // tasks linked to this entity, and the row set must not widen.
    expect(listTasksSpy).toHaveBeenNthCalledWith(2, {
      linked_entity_type: 'JOB',
      linked_entity_id: ENTITY_UUID,
    });
    expect(screen.getByText('Tasks', { selector: 'h3' }).textContent).toContain('(2)');
  });

  it('refreshes when the drawer switches straight from one task to another', async () => {
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'JOB', id: ENTITY_UUID, label: 'J00001' }} />
    );
    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledTimes(1));

    act(() => { useTaskDetailStore.getState().open(TASK_UUID_1); });
    // t1 -> t2 never passes through null, so a "closed?" test alone would miss it.
    act(() => { useTaskDetailStore.getState().open(TASK_UUID_2); });

    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledTimes(2));
  });

  it('drops a task deleted from the drawer once the drawer closes', async () => {
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'JOB', id: ENTITY_UUID, label: 'J00001' }} />
    );
    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId(`task-card-${TASK_UUID_1}`)).toBeInTheDocument();

    act(() => { useTaskDetailStore.getState().open(TASK_UUID_1); });
    listTasksSpy.mockResolvedValue([makeTask(TASK_UUID_2, 'Replace filter')]);
    act(() => { useTaskDetailStore.getState().close(); });

    await waitFor(() =>
      expect(screen.queryByTestId(`task-card-${TASK_UUID_1}`)).not.toBeInTheDocument()
    );
    expect(screen.getByTestId(`task-card-${TASK_UUID_2}`)).toBeInTheDocument();
  });

  it('works with LEAD entity type', async () => {
    const LEAD_UUID = 'l0000000-0000-0000-0000-000000000099';
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'LEAD', id: LEAD_UUID, label: 'L00099' }} />
    );

    await waitFor(() => {
      expect(listTasksSpy).toHaveBeenCalledWith({
        linked_entity_type: 'LEAD',
        linked_entity_id: LEAD_UUID,
      });
    });
  });

  it('works with CUSTOMER entity type', async () => {
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'CUSTOMER', id: CUSTOMER_UUID, label: 'Test Customer' }} />
    );

    await waitFor(() => {
      expect(listTasksSpy).toHaveBeenCalledWith({
        linked_entity_type: 'CUSTOMER',
        linked_entity_id: CUSTOMER_UUID,
      });
    });
  });

  it('works with ESTIMATE entity type', async () => {
    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'ESTIMATE', id: ESTIMATE_UUID, label: 'E00099' }} />
    );

    await waitFor(() => {
      expect(listTasksSpy).toHaveBeenCalledWith({
        linked_entity_type: 'ESTIMATE',
        linked_entity_id: ESTIMATE_UUID,
      });
    });
  });
});

// ── #398: Suggested tasks must start UNCHECKED ────────────────────────────────

describe('JobLeadTasksTab — suggested tasks start unchecked (#398)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(tasksApi, 'listTasks').mockResolvedValue(ENTITY_TASKS);
  });

  it('renders every suggestion unchecked and disables the Add button until one is checked', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <JobLeadTasksTab entity={{ type: 'LEAD', id: ENTITY_UUID, label: 'L00001' }} />
    );

    await user.click(screen.getByRole('button', { name: /Generate tasks/i }));

    // All suggestion checkboxes start UNCHECKED — the user opts in.
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(box).not.toBeChecked();
    }

    // Add button is disabled at 0 selected.
    expect(screen.getByRole('button', { name: /Add 0 tasks/i })).toBeDisabled();

    // Checking one suggestion enables "Add 1 task".
    await user.click(checkboxes[0]);
    expect(screen.getByRole('button', { name: /Add 1 task/i })).toBeEnabled();
  });
});

// ── FIX B: CustomerDetailPage Tasks tab ───────────────────────────────────────
// Note: useParams is mocked globally to return the estimate UUID.
// CustomerDetailPage reads `id` from useParams — so we pass the customer UUID
// via the route path instead, which the Routes/Route mechanism resolves correctly
// since the Route path is `/customers/:id` and MemoryRouter provides the initial entry.
// The global useParams mock returns ESTIMATE_UUID but the Routes wrapper overrides
// what :id resolves to for components rendered under <Route path="/customers/:id">.
// However, since useParams is mocked at module level, CustomerDetailPage will still
// read ESTIMATE_UUID from it. To test the correct customer UUID, we directly
// pass the customer detail page with its own params.

describe('CustomerDetailPage — Tasks tab (FIX B)', () => {
  let listTasksSpy: ReturnType<typeof vi.spyOn>;
  const mockApi = vi.mocked(api);

  beforeEach(() => {
    vi.clearAllMocks();
    // The global vi.mock('react-router-dom') mocks useParams to return ESTIMATE_UUID.
    // CustomerDetailPage uses `const { id } = useParams()`, so id = ESTIMATE_UUID here.
    // That's intentional — we can still verify the Tasks tab renders and passes the
    // id from useParams down to JobLeadTasksTab as the entity UUID.
    mockApi.get.mockResolvedValue({
      data: { customer: { ...CUSTOMER_FIXTURE, id: ESTIMATE_UUID }, summary: CUSTOMER_SUMMARY },
    });
    listTasksSpy = vi.spyOn(tasksApi, 'listTasks').mockResolvedValue(ENTITY_TASKS);
  });

  it('renders a "Tasks" tab trigger on the customer detail page', async () => {
    renderWithProviders(<CustomerDetailPage />);

    // Wait for load — customer name heading
    await screen.findByRole('heading', { name: /Test Customer/ });
    expect(screen.getByRole('tab', { name: /Tasks/i })).toBeInTheDocument();
  });

  it('passes the UUID from useParams to JobLeadTasksTab when Tasks tab is clicked', async () => {
    const user = userEvent.setup();

    renderWithProviders(<CustomerDetailPage />);

    await screen.findByRole('heading', { name: /Test Customer/ });
    await user.click(screen.getByRole('tab', { name: /Tasks/i }));

    // JobLeadTasksTab calls listTasks — verify it used the UUID (not number "C00099")
    await waitFor(() => {
      expect(listTasksSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          linked_entity_type: 'CUSTOMER',
          linked_entity_id: ESTIMATE_UUID, // This is what useParams returns per our mock
        })
      );
    });

    const call = listTasksSpy.mock.calls.find(
      (c) => c[0]?.linked_entity_type === 'CUSTOMER'
    );
    // id must be the UUID value from useParams (not the customer_number string)
    expect(call?.[0]?.linked_entity_id).not.toBe('C00099');
  });
});

// ── FIX B: EstimateWorkspacePage Tasks section ─────────────────────────────────
// Tasks is no longer behind a tab (see the file-header GAP note) — JobLeadTasksTab
// mounts unconditionally, so the entity-filtered fetch fires on page load.

describe('EstimateWorkspacePage — Tasks section (FIX B)', () => {
  let listTasksSpy: ReturnType<typeof vi.spyOn>;
  const mockApi = vi.mocked(api);

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: [] } };
      if (url.includes('/api/estimates/')) return { data: { estimate: ESTIMATE_FIXTURE } };
      return { data: {} };
    });
    listTasksSpy = vi.spyOn(tasksApi, 'listTasks').mockResolvedValue(ENTITY_TASKS);
  });

  it('renders the Tasks section on the estimate workspace page', async () => {
    renderWithProviders(<EstimateWorkspacePage />);

    // Wait for page load — the estimate's fallback title (no custom name set).
    await screen.findByText('Estimate E00099');
    // No tab to find any more — Tasks is a standing section (SectionCard "Tasks").
    expect(screen.getByText('Tasks', { selector: 'h3' })).toBeInTheDocument();
  });

  it('mounts JobLeadTasksTab with the estimate UUID on load (no click required)', async () => {
    renderWithProviders(<EstimateWorkspacePage />);

    await screen.findByText('Estimate E00099');

    // JobLeadTasksTab calls listTasks — verify it used the estimate UUID (not number)
    await waitFor(() => {
      expect(listTasksSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          linked_entity_type: 'ESTIMATE',
          linked_entity_id: ESTIMATE_UUID,
        })
      );
    });

    const call = listTasksSpy.mock.calls.find(
      (c) => c[0]?.linked_entity_type === 'ESTIMATE'
    );
    // Must be the UUID, not the human-readable estimate_number
    expect(call?.[0]?.linked_entity_id).toBe(ESTIMATE_UUID);
    expect(call?.[0]?.linked_entity_id).not.toBe('E00099');
  });
});
