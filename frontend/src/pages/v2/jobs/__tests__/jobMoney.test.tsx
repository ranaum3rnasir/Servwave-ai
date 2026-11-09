/**
 * Roles & Permissions, PRD 4, S04.26 - money on the job follows invoice access. The routed job page draws:
 *  - the job's balance and contract for anyone who can open the job, from the server's job-wide totals (not from the
 *    invoices the person can open);
 *  - the Payments tab when the person can open at least one invoice on the job or can create one, listing only the
 *    invoices the server sends;
 *  - Record Payment and Collect deposit only with Record payments, on an invoice the person can open; the Payment Received
 *    step follows the server's own answer (S06.22).
 * The person's ability below never holds "read Invoice": a control that shows can only be following the new rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';

const JOB_ID = 'j0000000-0000-0000-0000-000000000026';

stubBrowser();

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});


const VISIT = {
  id: 'v-1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2026-09-05T13:00:00.000Z', scheduled_end: '2026-09-05T15:00:00.000Z',
  is_all_day: false, completed_at: null, cancelled_at: null, cancelled_reason: null, created_at: '2026-08-20T10:00:00.000Z', status_steps: [],
};

const JOB = {
  id: JOB_ID, job_number: 'J00026', status: 'SCHEDULED', job_type: 'HVAC Installation', description: 'Replace the rooftop unit',
  scope_notes: null, estimated_duration: null, completion_notes: null, scheduled_start: '2026-09-05T13:00:00.000Z',
  scheduled_end: '2026-09-05T15:00:00.000Z', started_at: null, completed_at: null, cancelled_at: null, cancelled_reason: null,
  created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', dispatcher: null,
  customer: { id: 'c-1', first_name: 'Sarah', last_name: 'Johnson', company_name: null, email: 'sarah@example.com', phone: '5125550198' },
  assignees: [], visits: [VISIT],
  service_location: { id: 'l-1', address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
  estimate: null, invoices: [] as unknown[], linked_estimates: [] as unknown[], tags: [], source_plan_id: null, source_plan: null,
  actions: [] as string[],
};

const invoice = (over: Record<string, unknown>) => ({
  id: 'inv', invoice_number: 'I-X', status: 'PARTIAL', kind: 'STANDARD', total_amount: 100, amount_due: 70,
  sent_at: '2026-09-01T00:00:00.000Z', paid_at: null, processing_amount: 0, tip: 0, tax_rate: 0, tax_amount: 0,
  discount_amount: 0, subtotal: 100, line_items: [], ...over,
});
/** The invoice the person made on the job, and the one the office made (the job's final invoice, which they cannot open). */
const MINE = invoice({ id: 'inv-mine', invoice_number: 'I-MINE', total_amount: 100, amount_due: 70 });
const OFFICE = invoice({ id: 'inv-office', invoice_number: 'I-OFFICE', total_amount: 300, amount_due: 240 });
const finalOf = (i: Record<string, unknown>) => ({
  id: i.id, invoice_number: i.invoice_number, status: i.status, total_amount: i.total_amount, amount_due: i.amount_due,
  sent_at: i.sent_at, paid_at: null,
});
const payment = (over: Record<string, unknown>) => ({
  id: 'pay', amount: 30, method: 'CHECK', paid_at: '2026-09-02T00:00:00.000Z', invoice_id: 'inv-mine', invoice_number: 'I-MINE',
  invoice_kind: 'STANDARD', state: 'SUCCEEDED', reference_number: null, ...over,
});

interface Setup {
  financials: Record<string, unknown>;
  actions?: string[];
  job?: Record<string, unknown>;
  can?: Array<{ action: string; subject: string }>;
  /** False for a person without See prices (default true). */
  prices?: boolean;
}

function mountWith({ financials, actions = [], job = {}, can = [], prices = true }: Setup) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      // A role name the page must not read: the checks below follow the ability and the server's answers.
      user: { id: 'u-me', email: 'me@x.test', first_name: 'Me', last_name: 'Person', role: 'ADMIN' },
      isAuthenticated: true, isLoading: false, error: null,
    } as never),
  );
  const detail = { ...JOB, actions, ...job };
  serveJobDetail({
    jobId: JOB_ID,
    job: detail,
    visits: [VISIT],
    lines: [],
    billing: { subtotal: 0, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 0 },
    routes: [
      { match: (url) => url.includes('/financials'), data: financials },
      { match: (url) => url.includes('/notes'), data: { notes: [] } },
      { match: (url) => url.includes('/api/attachments/'), data: { attachments: [] } },
      { match: (url) => url.includes('/communications'), data: { items: [] } },
    ],
  });
  return renderJobDetail({
    // Prices are held unless the case says otherwise (P11): the balance block is for a person who sees them.
    ability: buildAbility([{ action: 'read', subject: 'Job' }, ...(prices ? [{ action: 'read', subject: 'Prices' }] : []), ...can] as never),
    entry: `/jobs/${JOB_ID}`,
  });
}

const TOTALS = { contract_total: 300, paid: 60, deposit_paid: 0, processing: 0, balance_due: 240 };
/** The financials of a job with two invoices on it, one the person made and one the office made. */
const TWO_INVOICES = {
  final_invoice: finalOf(OFFICE),
  invoices: [MINE],
  payments: [payment({})],
  first_sent_at: '2026-09-01T00:00:00.000Z', total_invoiced: 400, total_paid: 60, totals: TOTALS,
};

async function openPayments() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('job page - the balance block', () => {
  it('shows the job\'s whole balance and contract to a person who can open only some of its invoices', async () => {
    mountWith({ financials: TWO_INVOICES });

    // $300 contract, $60 paid across both invoices: $240. The list holds one invoice with a $30 payment, which would say $270.
    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    expect(screen.getByText('$240.00')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByText('20% collected')).toBeInTheDocument();
  });

  it('shows the estimate\'s total as the contract of a job with no invoice yet, though the estimate itself is hidden', async () => {
    mountWith({
      financials: { final_invoice: null, invoices: [], payments: [], totals: { contract_total: 4200, paid: 0, deposit_paid: 0, processing: 0, balance_due: 4200 } },
    });

    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    expect(screen.getAllByText('$4,200.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('No contract yet')).not.toBeInTheDocument();
  });

  it('shows the balance the server works out, not the contract less what was paid, when one invoice is overpaid beside an unpaid one', async () => {
    mountWith({
      financials: { ...TWO_INVOICES, totals: { contract_total: 300, paid: 250, deposit_paid: 0, processing: 0, balance_due: 100 } },
    });

    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText('$50.00')).not.toBeInTheDocument();
  });

  it('shows the owed figure Mark Done asks for on a job with priced lines and no invoice or estimate, not "No contract yet"', async () => {
    mountWith({
      financials: { final_invoice: null, invoices: [], payments: [], totals: { contract_total: 324.6, paid: 0, deposit_paid: 0, processing: 0, balance_due: 324.6 } },
    });

    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    expect(screen.getAllByText('$324.60').length).toBeGreaterThan(0);
    expect(screen.queryByText('No contract yet')).not.toBeInTheDocument();
  });
});

describe('job page - the Payments tab', () => {
  it('lists only the invoices the server sends, and the payments on them', async () => {
    mountWith({ financials: TWO_INVOICES });
    await openPayments();

    expect(await screen.findByRole('link', { name: 'I-MINE' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'I-OFFICE' })).not.toBeInTheDocument();
  });

  it('is there when the person can open one invoice or can create one, and not otherwise', async () => {
    const empty = { final_invoice: null, invoices: [], payments: [], totals: { contract_total: null, paid: 0, deposit_paid: 0, processing: 0, balance_due: 0 } };

    const none = mountWith({ financials: empty });
    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByRole('tab', { name: 'Payments' })).not.toBeInTheDocument();
    none.unmount();

    const canCreate = mountWith({ financials: empty, actions: ['create_invoice'] });
    expect(await screen.findByRole('tab', { name: 'Payments' })).toBeInTheDocument();
    canCreate.unmount();

    mountWith({ financials: TWO_INVOICES });
    expect(await screen.findByRole('tab', { name: 'Payments' })).toBeInTheDocument();
  });
});

describe('job page - Record Payment and Collect deposit', () => {
  const ownFinal = { ...TWO_INVOICES, final_invoice: finalOf(MINE) };

  it('offers Record Payment on an invoice the person can open only with Record payments', async () => {
    const without = mountWith({ financials: ownFinal });
    await openPayments();
    await screen.findByRole('link', { name: 'I-MINE' });
    expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
    without.unmount();

    mountWith({ financials: ownFinal, can: [{ action: 'record_payment', subject: 'Invoice' }] });
    await openPayments();
    expect(await screen.findByRole('button', { name: /record payment/i })).toBeInTheDocument();
  });

  it('offers Record Payment on no invoice the person cannot open, though the job\'s final invoice is the office\'s', async () => {
    mountWith({ financials: TWO_INVOICES, can: [{ action: 'record_payment', subject: 'Invoice' }] });
    await openPayments();
    await screen.findByRole('link', { name: 'I-MINE' });
    expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
  });

  it('offers Collect deposit on an open deposit invoice only with Record payments', async () => {
    const deposit = invoice({ id: 'inv-dep', invoice_number: 'I-DEP', kind: 'DEPOSIT', status: 'SENT', total_amount: 50, amount_due: 50 });
    const financials = { ...ownFinal, invoices: [MINE, deposit] };

    const without = mountWith({ financials });
    await openPayments();
    await screen.findByRole('link', { name: 'I-DEP' });
    expect(screen.queryByRole('button', { name: /collect deposit/i })).not.toBeInTheDocument();
    without.unmount();

    mountWith({ financials, can: [{ action: 'record_payment', subject: 'Invoice' }] });
    await openPayments();
    expect(await screen.findByRole('button', { name: /collect deposit/i })).toBeInTheDocument();
  });
});

describe('job page - the Payment Received step', () => {
  // S06.22: the step follows the server's own answer for this person on the job's final invoice, not the lists above.
  it('is pressable when the server offers Record payment on the job\'s final invoice, and greyed with its reason when it does not', async () => {
    const mine = mountWith({
      financials: { ...TWO_INVOICES, final_invoice: finalOf(MINE), payment_received: { offered: true, reason: null } },
      can: [{ action: 'record_payment', subject: 'Invoice' }],
    });
    expect(await screen.findByRole('button', { name: /payment received/i })).toBeEnabled();
    mine.unmount();

    mountWith({
      financials: { ...TWO_INVOICES, payment_received: { offered: false, reason: "You can't open this job's invoice." } },
      can: [{ action: 'record_payment', subject: 'Invoice' }],
    });
    await screen.findByText('Balance due');
    expect(screen.getByRole('button', { name: /payment received/i })).toBeDisabled();
  });
});

describe('job page - Delete job', () => {
  it('still knows the job has invoices the person cannot open', async () => {
    const hidden = mountWith({ financials: { final_invoice: null, invoices: [], payments: [] }, actions: ['delete', 'duplicate'], job: { invoice_count: 1 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions' }));
    await screen.findByRole('menuitem', { name: /duplicate/i });
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    hidden.unmount();

    mountWith({ financials: { final_invoice: null, invoices: [], payments: [] }, actions: ['delete', 'duplicate'], job: { invoice_count: 0 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });
});

describe('job page - a person without See prices', () => {
  it('sees no balance, contract, invoice total or Payments tab, and no figure at all where they would be', async () => {
    // The server leaves every price out of what it sends this person, so the answers below carry none.
    mountWith({
      prices: false,
      can: [{ action: 'read', subject: 'Invoice' }],
      financials: { final_invoice: null, invoices: [{ id: 'inv-mine', invoice_number: 'I-MINE', status: 'PARTIAL', kind: 'STANDARD' }], payments: [] },
      job: { invoices: [{ id: 'inv-mine', invoice_number: 'I-MINE', status: 'PARTIAL', kind: 'STANDARD' }] },
    });

    expect(await screen.findByRole('heading', { name: /J00026/ })).toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
    expect(screen.queryByText('No contract yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Payments' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$|NaN/);
  });
});
