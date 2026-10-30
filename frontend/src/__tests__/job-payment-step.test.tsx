/**
 * Roles & Permissions, PRD 6, S06.22 - Record payment on the Payment Received step of the routed job page.
 *
 * The step offers Record payment from the server's own answer (`payment_received` on GET /api/jobs/:id/financials): offered,
 * or greyed with the one reason that applies. The browser never tests a switch, a role or an invoice's creator, so every
 * case below holds an ability that disagrees with the server's answer and the page follows the server. The dialog it opens
 * is the invoice page's record-payment dialog, which lists only the methods the person may record.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000022';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
/** Reads jobs and nothing else: the page must not take its Record payment answer from this. */
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Job' }]);

const CANNOT_OPEN = "You can't open this job's invoice.";
const NO_RECORD = "You don't have permission to record payments.";
const NO_CREATE = "You don't have permission to create invoices.";

const visit = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'COMPLETED', purpose: 'WORK',
  scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

const OWED = {
  final_invoice: {
    id: 'inv-1', invoice_number: 'I00001', status: 'SENT', total_amount: 1000, amount_due: 400,
    sent_at: '2026-10-03T12:00:00.000Z', paid_at: null,
  },
  first_sent_at: '2026-10-03T12:00:00.000Z', total_invoiced: 1000, total_paid: 600,
  invoices: [{ id: 'inv-1', invoice_number: 'I00001', status: 'SENT', kind: 'STANDARD', total_amount: 1000, amount_due: 400 }],
  payments: [],
};
const NO_INVOICE = { final_invoice: null, first_sent_at: null, total_invoiced: 0, total_paid: 0, invoices: [], payments: [] };
const PAID = {
  ...OWED, final_invoice: { ...OWED.final_invoice, status: 'PAID', amount_due: 0, paid_at: '2026-10-04T12:00:00.000Z' },
  total_paid: 1000,
};

type Step = { offered: boolean; reason: string | null };

function mount(financials: Record<string, unknown>, step: Step | undefined, ability = adminAbility) {
  const job = {
    id: JOB_ID, job_number: 'J00022', status: 'READY_TO_CLOSE', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null, cancelled_reason: null, closed_at: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [visit], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: false, locked_actions: [], actions: [],
    new_visit_closed_reason: null, close_out_money: null,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/accepted-payment-methods') return { data: { every_method: false, methods: ['CHECK', 'CASH', 'ZELLE'] } } as never;
    if (url === '/api/permission-switches/me') {
      return { data: { admin_box: false, values: { allowed_payment_methods: ['ZELLE', 'VENMO', 'CHECK'] }, rules: [] } } as never;
    }
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [visit] } } as never;
    if (url.endsWith('/financials')) return { data: step ? { ...financials, payment_received: step } : financials } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability, initialEntries: [`/jobs/${JOB_ID}`] });
}

const stepButton = () => screen.findByRole('button', { name: /payment received/i });

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('the Payment Received step on the job page (S06.22)', () => {
  it('offers Record payment when the server says so, even to an ability that holds nothing about invoices', async () => {
    mount(OWED, { offered: true, reason: null }, readOnlyAbility);
    expect(await stepButton()).toBeEnabled();
  });

  it('opens the invoice page\'s record-payment dialog on the job\'s invoice, offering only the methods this person may record', async () => {
    mount(OWED, { offered: true, reason: null });
    await userEvent.click(await stepButton());

    // The page also has its own standing Record Payment button, so look for the dialog's heading.
    expect(await screen.findByRole('heading', { name: 'Record Payment' })).toBeInTheDocument();
    expect(screen.getByText(/Record a payment for invoice I00001/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('combobox', { name: /payment method/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Check', 'Zelle']);
  });

  it.each([
    ["the person can't open the job's invoice", CANNOT_OPEN, OWED],
    ['the person does not hold Record payments', NO_RECORD, OWED],
    ['the job has no invoice and the person cannot create one', NO_CREATE, NO_INVOICE],
  ])('greys the step out with the server\'s words when %s, even to an ability that holds everything', async (_why, reason, financials) => {
    mount(financials, { offered: false, reason });

    const button = await stepButton();
    expect(button).toBeDisabled();
    // The reason is readable by a screen reader (the button's description) and on hover (the shell's title).
    expect(button).toHaveAccessibleDescription(reason);
    expect(screen.getByTitle(reason)).toBeInTheDocument();

    await userEvent.click(button);
    expect(screen.queryByRole('heading', { name: 'Record Payment' })).not.toBeInTheDocument();
  });

  it('names no invoice in the greyed words: no number, no amount', async () => {
    mount(OWED, { offered: false, reason: CANNOT_OPEN });
    const button = await stepButton();
    const words = button.getAttribute('aria-describedby');
    const described = within(document.body).getAllByText(CANNOT_OPEN).map((n) => n.textContent).join(' ');
    expect(words).toBeTruthy();
    expect(described).not.toContain('I00001');
    expect(described).not.toMatch(/\$|1000|400/);
  });

  it('draws nothing to press on a fully paid job, whatever the server says is offered', async () => {
    mount(PAID, { offered: true, reason: null });
    await screen.findByText('Payment Received');
    expect(screen.queryByRole('button', { name: /payment received/i })).not.toBeInTheDocument();
  });

  it('draws nothing to press, and no reason, when the answer carries no Payment Received step (an older server)', async () => {
    mount(OWED, undefined);
    await screen.findByText('Payment Received');
    expect(screen.queryByRole('button', { name: /payment received/i })).not.toBeInTheDocument();
  });

  it('draws no reason when the step offers nothing and says nothing (a service plan visit job)', async () => {
    mount(NO_INVOICE, { offered: false, reason: null });
    await screen.findByText('Payment Received');
    expect(screen.queryByRole('button', { name: /payment received/i })).not.toBeInTheDocument();
  });
});
