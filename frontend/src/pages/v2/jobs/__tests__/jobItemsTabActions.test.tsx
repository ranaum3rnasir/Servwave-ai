import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { ALL_JOB_ACTIONS } from '@/__tests__/helpers';
import { JOB_ID, renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import api from '@/lib/axios';

const ME = 'u-me';

stubBrowser();

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const everything = buildAbility([{ action: 'manage', subject: 'all' }]);

// "Nothing" about editing: the person still sees prices (P11), which is a separate question from what they may change.
const nothing = buildAbility([{ action: 'read', subject: 'Prices' }]);

/** Part of the Technician preset's list: it holds Edit job line items and not Apply discounts. */
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
  // The signed-in person made this job and is credited with the sale.
  created_by_id: ME,
  salesperson: { id: ME, first_name: 'Me', last_name: 'Person' },
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [],
  visits: [{ ...VISIT, assignees: [{ user_id: ME }] }],
  service_location: { id: 'l-1', address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
  actions: [] as string[],
};

function mountWith(actions: string[], ability: ReturnType<typeof buildAbility>) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: ME, email: 'me@x.test', first_name: 'Me', last_name: 'Person', role: 'TECHNICIAN' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
  const job = { ...JOB, actions };
  serveJobDetail({
    job,
    visits: [VISIT],
    routes: [
      { match: (url) => url.includes('/financials'), data: { final_invoice: null, invoices: [], payments: [] } },
      { match: (url) => url.includes('/line-items'), data: { lines: [{ id: 'li-1', name: 'Rooftop unit', description: 'Rooftop unit', quantity: 1, unit_price: 4200, line_total: 4200, discount_amount: 0, is_taxable: false, sort_order: 0 }], billing: { subtotal: 4200, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 4200 } } },
      { match: (url) => url.includes('/scopes'), data: { scopes: [] } },
      { match: (url) => url.includes('/notes'), data: { notes: [] } },
      { match: (url) => url.includes('/api/attachments/'), data: { attachments: [] } },
      { match: (url) => url.includes('/communications'), data: { items: [] } },
    ],
  });
  return renderJobDetail({ ability, entry: `/jobs/${JOB_ID}` });
}

async function openItemsTab() {
  await screen.findByRole('heading', { name: /J00001/ });
  await userEvent.click(await screen.findByRole('tab', { name: 'Items' }));
  await screen.findByText('Rooftop unit');
}

/** Any control that sets a discount: the per-line column, or the job's discount row turned into an input. */
function discountControls() {
  return [
    ...screen.queryAllByLabelText(/discount (type|value)/i),
    ...screen.queryAllByRole('columnheader', { name: /discount/i }),
    ...screen.queryAllByRole('button', { name: /(set|edit|add|apply) discount/i }),
  ];
}

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

describe('job page - the Items tab follows the server list', () => {
  it('offers line and scope editing to a person whose list has edit_line_items, with an empty browser-side ability', async () => {
    mountWith(TECHNICIAN_ACTIONS, nothing);
    await openItemsTab();
    expect(await screen.findByRole('button', { name: /add item/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /price book/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add scope of work/i })).toBeInTheDocument();
  });

  it("hides line and scope editing from the job's creator and Sold By whose list has no edit_line_items, with a full browser-side ability", async () => {
    mountWith(ALL_JOB_ACTIONS.filter((a) => a !== 'edit_line_items' && a !== 'apply_discount'), everything);
    await openItemsTab();
    expect(screen.queryByRole('button', { name: /add item/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /price book/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add scope of work/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('shows no discount control with the Technician preset values, which price the job but never discount it', async () => {
    mountWith(TECHNICIAN_ACTIONS, nothing);
    await openItemsTab();
    expect(await screen.findByRole('button', { name: /add item/i })).toBeInTheDocument();
    expect(discountControls()).toEqual([]);
  });

  it('shows neither line editing nor a discount control with Edit job line items and Apply discounts both off', async () => {
    mountWith(['add_note'], everything);
    await openItemsTab();
    expect(screen.queryByRole('button', { name: /add item/i })).toBeNull();
    expect(discountControls()).toEqual([]);
  });
});
