/**
 * Roles & Permissions, PRD 4, S04.13 - the job page draws a control only for an action in the list the server sends
 * on the job (`job.actions`). The person's browser-side ability is deliberately generous in the cases below, so a
 * control that shows or hides can only be following the list, never a role name or the ability.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
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
const everything = buildAbility([{ action: 'manage', subject: 'all' }]);
const nothing = buildAbility([]);

/** What the server lists for a person holding the Technician preset's values (the backend suite derives it from the catalog). */
const TECHNICIAN_ACTIONS = ['create_estimate', 'edit_line_items', 'add_note', 'upload_attachment', 'log_communication'];

const VISIT = {
  id: 'v-1',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: '2026-09-05T13:00:00.000Z',
  scheduled_end: '2026-09-05T15:00:00.000Z',
  is_all_day: false,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-08-20T10:00:00.000Z',
  status_steps: [],
};

const JOB = {
  id: JOB_ID,
  job_number: 'J00001',
  status: 'SCHEDULED',
  job_type: 'HVAC Installation',
  description: 'Replace the rooftop unit',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: '2026-09-05T13:00:00.000Z',
  scheduled_end: '2026-09-05T15:00:00.000Z',
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [],
  visits: [VISIT],
  service_location: { id: 'l-1', address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
  estimate: null,
  invoices: [],
  linked_estimates: [{ id: 'e-1', estimate_number: 'E-100', total_amount: 4200, status: 'SENT' }],
  tags: [{ id: 't-1', name: 'Rooftop', color: '#336699' }],
  source_plan_id: null,
  source_plan: null,
  actions: [] as string[],
};

function mountWith(actions: string[], opts: { ability?: ReturnType<typeof buildAbility>; role?: string } = {}) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: 'u-me', email: 'me@x.test', first_name: 'Me', last_name: 'Person', role: opts.role ?? 'TECHNICIAN' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
  const job = { ...JOB, actions };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/visits')) return { data: { visits: [VISIT] } };
    if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
    if (url.includes('/line-items')) {
      return { data: { lines: [{ id: 'li-1', name: 'Rooftop unit', description: 'Rooftop unit', quantity: 1, unit_price: 4200, line_total: 4200, discount_amount: 0, is_taxable: false, sort_order: 0 }], billing: { subtotal: 4200, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 4200 } } };
    }
    if (url.includes('/notes')) {
      return { data: { notes: [{ id: 'n-1', content: 'Gate code is 4321', created_at: '2026-08-02T00:00:00.000Z', creator: { id: 'u-x', first_name: 'Ola', last_name: 'Office' } }] } };
    }
    if (url.includes('/api/attachments/')) {
      return { data: { attachments: [{ id: 'a-1', file_name: 'roof.jpg', file_url: 'https://files.test/roof.jpg', file_type: 'image/jpeg', display_name: 'roof.jpg' }] } };
    }
    if (url.includes('/communications')) return { data: { items: [] } };
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } };
    return { data: {} };
  });
  return renderWithProviders(<JobDetailPage />, {
    ability: opts.ability ?? everything,
    initialEntries: [`/jobs/${JOB_ID}`],
  });
}

async function openActionsMenu() {
  await userEvent.click(await screen.findByRole('button', { name: 'Actions' }));
}

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole('tab', { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('job page - the Technician preset values', () => {
  it('shows none of the office controls on the header, the details or the Visits tab', async () => {
    mountWith(TECHNICIAN_ACTIONS);
    await screen.findByRole('heading', { name: /J00001/ });

    // Header: no Complete job or Create Invoice, and nothing left to put in the Actions menu (assign, schedule,
    // duplicate, cancel and delete are all gone), so the menu is not offered at all.
    expect(screen.queryByRole('button', { name: /complete job/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create invoice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
    expect(screen.getByRole('button', { name: /new task/i })).toBeInTheDocument();

    // Details: address, service type and tags cannot be changed.
    expect(screen.queryByRole('button', { name: /edit service location/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit service type/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove tag/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^\s*tag\s*$/i })).toBeNull();
    expect(screen.getByText('Rooftop')).toBeInTheDocument();
    // The renumber pencil is gone too.
    expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();

    // Visits: the visit is listed, with no add, reschedule or cancel.
    await openTab('Visits');
    expect((await screen.findAllByText('Visit 1')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /add visit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reschedule/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^cancel/i })).toBeNull();
  });

  it('shows Add note, Upload and Log communication, and the estimate door, with their switches', async () => {
    mountWith(TECHNICIAN_ACTIONS);
    await screen.findByRole('heading', { name: /J00001/ });

    await openTab('Notes');
    expect(await screen.findByPlaceholderText(/write a note/i)).toBeInTheDocument();

    await openTab('Attachments');
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
    expect(await screen.findByRole('button', { name: /^upload$/i })).toBeInTheDocument();

    await openTab('Communication');
    expect(await screen.findByRole('button', { name: /log communication/i })).toBeInTheDocument();

    await openTab('Estimates');
    expect(await screen.findByRole('button', { name: /add estimate/i })).toBeInTheDocument();
  });

  it('shows the customer, the work, the prices, the estimates, the notes, the files and the history to anyone who opens the job', async () => {
    // A person with no listed action at all, and an ability that reads the job's records and nothing else.
    const reader = buildAbility([
      { action: 'read', subject: 'Job' },
      { action: 'read', subject: 'Estimate' },
      { action: 'read', subject: 'Invoice' },
      { action: 'read', subject: 'Communication' },
      { action: 'read', subject: 'Attachment' },
    ]);
    mountWith([], { ability: reader });
    await screen.findByRole('heading', { name: /J00001/ });

    // The customer.
    expect((await screen.findAllByText(/Sarah Johnson/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/555.?0198/).length).toBeGreaterThan(0);
    // The history rail.
    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument();

    // The work and its prices.
    await openTab('Items');
    expect(await screen.findByText('Rooftop unit')).toBeInTheDocument();
    expect(screen.getAllByText(/4,200/).length).toBeGreaterThan(0);

    // The estimates.
    await openTab('Estimates');
    expect(await screen.findByText('E-100')).toBeInTheDocument();

    // The notes, with no composer.
    await openTab('Notes');
    expect(await screen.findByText('Gate code is 4321')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/write a note/i)).toBeNull();

    // The files, with no upload.
    await openTab('Attachments');
    expect(await screen.findByText('roof.jpg')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^upload$/i })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();

    // The communication tab opens, with no log button.
    await openTab('Communication');
    expect(screen.queryByRole('button', { name: /log communication/i })).toBeNull();
  });
});

describe('job page - controls follow the list, not the ability', () => {
  it('offers every listed control to a person whose browser-side ability is empty', async () => {
    mountWith(ALL_JOB_ACTIONS, { ability: nothing });
    await screen.findByRole('heading', { name: /J00001/ });

    expect(screen.getByRole('button', { name: /complete job/i })).toBeInTheDocument();
    await openActionsMenu();
    for (const shown of [/^assign$/i, /duplicate job/i, /^cancel$/i, /^delete$/i]) {
      expect(await screen.findByRole('menuitem', { name: shown }), String(shown)).toBeInTheDocument();
    }
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeInTheDocument();
  });

  it('shows Duplicate Job only with Duplicate jobs', async () => {
    const { unmount } = mountWith(['duplicate']);
    await screen.findByRole('heading', { name: /J00001/ });
    await openActionsMenu();
    expect(await screen.findByRole('menuitem', { name: /duplicate job/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^cancel$/i })).toBeNull();
    unmount();

    mountWith(ALL_JOB_ACTIONS.filter((a) => a !== 'duplicate'));
    await screen.findByRole('heading', { name: /J00001/ });
    await openActionsMenu();
    expect(await screen.findByRole('menuitem', { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /duplicate job/i })).toBeNull();
  });

  it('lets a custom role with Edit jobs change the service location and service type, whatever the role is called', async () => {
    mountWith(['edit'], { role: 'TECHNICIAN' });
    await screen.findByRole('heading', { name: /J00001/ });
    expect(await screen.findByRole('button', { name: /edit service location/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit service type/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove tag rooftop/i })).toBeInTheDocument();
  });

  it('keeps the service location and service type fixed for an Admin-named role whose list has no Edit jobs', async () => {
    mountWith([], { role: 'ADMIN' });
    await screen.findByRole('heading', { name: /J00001/ });
    await screen.findAllByText(/1 Test Way/);
    expect(screen.queryByRole('button', { name: /edit service location/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit service type/i })).toBeNull();
  });

  it('hides the add-visit, reschedule and cancel-visit controls without Schedule visits and offers them with it', async () => {
    const { unmount } = mountWith([]);
    await screen.findByRole('heading', { name: /J00001/ });
    await openTab('Visits');
    await screen.findAllByText('Visit 1');
    expect(screen.queryByRole('button', { name: /add visit/i })).toBeNull();
    unmount();

    mountWith(['schedule']);
    await screen.findByRole('heading', { name: /J00001/ });
    await openTab('Visits');
    await screen.findAllByText('Visit 1');
    expect(await screen.findByRole('button', { name: /add visit/i })).toBeInTheDocument();
    expect((await screen.findAllByRole('button', { name: /^reschedule$/i })).length).toBeGreaterThan(0);
  });
});
