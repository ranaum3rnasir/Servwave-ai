/**
 * Mobile slice 68 (PRD story 140, rubric CMP-01) - the customer page's tab tables on a phone.
 *
 * Below lg (1024; see `useRecordCards` for why not md) the Leads, Estimates, Jobs, Schedule, Invoices
 * and Payments tabs render each row as a card: one named control that opens the record, and the
 * row's other columns as labelled lines. From lg up each tab is exactly the table it was. The
 * layout is JS-chosen (useIsBelow), so ONE variant mounts; jsdom answers every media query `false`
 * (the table), and the cards describe block answers the lg max-width query `true`. The `md` query
 * alone does NOT switch it, which pins the iPad range (768 to 1023) to cards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { renderWithProviders as render } from '@/__tests__/helpers';
import { projectCustomerSchedule } from '@/lib/customers/customerSchedule';

import {
  LeadsTab, EstimatesTab, JobsTab, InvoicesTab, PaymentsTab,
  type CustomerEstimate, type CustomerInvoice, type JobSummary, type LeadSummary,
} from '../detailTabs';
import { ScheduleTab } from '../scheduleTab';
import type { CustomerListView } from '../../useCustomerListPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ORG = 'America/Los_Angeles';
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: { id: 'org-1', timezone: ORG }, isLoading: false, isError: false }) };
});

const originalMatchMedia = window.matchMedia;
function answerMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function view<T>(rows: T[]): CustomerListView<T> {
  return {
    rows, status: 'ready', failedPage: null, onRetry: vi.fn(),
    pager: { page: 1, pageSize: 20, total: rows.length, onPageChange: vi.fn(), onPageSizeChange: vi.fn(), isFetching: false },
  };
}

const LEAD: LeadSummary = {
  id: 'lead-1', lead_number: 'L00012', status: 'CONTACTED', service_request: 'Front door rekey',
  created_at: '2026-09-01T12:00:00.000Z',
  lead_assignees: [{ user: { id: 'u1', first_name: 'Ana', last_name: 'Lee' } }],
  estimates: [{ id: 'e1', total_amount: 250 }],
  next_walkthrough: null,
};
const ESTIMATE: CustomerEstimate = {
  id: 'est-1', estimate_number: 'EST-1001', status: 'SENT', total_amount: 250,
  created_at: '2026-09-02T12:00:00.000Z', lead: { id: 'lead-1', service_request: 'Front door rekey' },
};
const JOB: JobSummary = {
  id: 'job-1', job_number: 'J00041', status: 'SCHEDULED', scope_notes: null, completed_at: null,
  created_at: '2026-09-03T12:00:00.000Z', scheduled_start: '2026-09-10T14:00:00.000Z',
  assignees: [{ user: { id: 'u1', first_name: 'Ana', last_name: 'Lee' } }],
  service_location: { address_line1: '12 Oak St', city: 'Austin', state: 'TX' },
  invoices: [{ id: 'inv-1', status: 'SENT' }],
};
const INVOICE: CustomerInvoice = {
  id: 'inv-1', invoice_number: 'INV-1001', status: 'SENT', kind: 'STANDARD', total_amount: 300, amount_due: 120,
  due_date: '2099-01-01T12:00:00.000Z', created_at: '2026-09-04T12:00:00.000Z', job_number: 'J00041', job_id: 'job-1',
  payments: [{ id: 'pay-1', amount: 180, method: 'CASH', paid_at: '2026-09-05T12:00:00.000Z', notes: null, collector: { id: 'u1', first_name: 'Ana', last_name: 'Lee' } }],
};

describe('customer tabs - cards (below lg)', () => {
  beforeEach(() => answerMedia((q) => q === MEDIA.belowLg));
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('Leads: a card per lead, no table; the card opens the lead and carries the other columns', () => {
    const onNavigate = vi.fn();
    render(<LeadsTab view={view([LEAD])} timeZone={ORG} onNavigate={onNavigate} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Front door rekey' });
    const card = open.closest('li')!;
    expect(within(card).getByText('Assigned To')).toBeInTheDocument();
    expect(within(card).getByText('Ana Lee')).toBeInTheDocument();
    expect(within(card).getByText('Est. Value')).toBeInTheDocument();
    fireEvent.click(open);
    expect(onNavigate).toHaveBeenCalledWith('lead-1');
  });

  it('Estimates: a card per estimate, no table; the card opens the estimate', () => {
    const onNavigate = vi.fn();
    render(<EstimatesTab estimates={[ESTIMATE]} isLoading={false} isError={false} onRetry={vi.fn()} onNavigate={onNavigate} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'EST-1001' });
    const card = open.closest('li')!;
    expect(within(card).getByText('$250.00')).toBeInTheDocument();
    expect(within(card).getByText('Total')).toBeInTheDocument();
    fireEvent.click(open);
    expect(onNavigate).toHaveBeenCalledWith('est-1');
  });

  it('Jobs: a card per job, no table; the card opens the job', () => {
    const onNavigate = vi.fn();
    render(<JobsTab view={view([JOB])} onNavigate={onNavigate} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'J00041' });
    const card = open.closest('li')!;
    expect(within(card).getByText('Technician')).toBeInTheDocument();
    expect(within(card).getByText('12 Oak St, Austin')).toBeInTheDocument();
    fireEvent.click(open);
    expect(onNavigate).toHaveBeenCalledWith('job-1');
  });

  it('Invoices: a card per invoice, no table; the card is ONE link to the invoice', () => {
    render(<InvoicesTab invoices={[INVOICE]} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'INV-1001' });
    expect(link).toHaveAttribute('href', expect.stringContaining('/invoices/inv-1'));
    const card = link.closest('li')!;
    expect(within(card).getByText('Amount Due')).toBeInTheDocument();
    expect(within(card).getByText('$120.00')).toBeInTheDocument();
    expect(within(card).getAllByRole('link')).toHaveLength(1);
  });

  it('Payments: a card per payment, no table, and nothing to open (a payment has no page)', () => {
    render(<PaymentsTab invoices={[INVOICE]} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    const card = items[0]!;
    expect(within(card).getByText('INV-1001')).toBeInTheDocument();
    expect(within(card).getByText('$180.00')).toBeInTheDocument();
    expect(within(card).getByText('Collected By')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('Schedule: a card per visit, no table; a job visit opens its job', () => {
    const onNavigateJob = vi.fn();
    const visitRows = projectCustomerSchedule({
      jobs: [{
        id: 'job-1', job_number: 'J00041', status: 'SCHEDULED', scope_notes: 'Replace condenser',
        visits: [{
          id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2026-09-10T14:00:00.000Z',
          scheduled_end: '2026-09-10T16:00:00.000Z', is_all_day: false, created_at: '2026-09-01T00:00:00.000Z',
          crew: [{ id: 'u1', first_name: 'Ana', last_name: 'Lee' }],
        }],
      }],
      leads: [],
    });
    render(
      <ScheduleTab
        visitRows={visitRows}
        calendarEntries={[]}
        onNavigateJob={onNavigateJob}
        onNavigateWalkthrough={vi.fn()}
        onOpenEvent={vi.fn()}
        status="ready"
        onRetry={vi.fn()}
        timeZone={ORG}
      />,
    );

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Replace condenser' });
    expect(within(open.closest('li')!).getByText('Crew')).toBeInTheDocument();
    fireEvent.click(open);
    expect(onNavigateJob).toHaveBeenCalledWith('job-1');
  });
});

describe('customer tabs - from lg up they are the tables they were', () => {
  it('an iPad-width screen (md but not lg) still gets cards', () => {
    answerMedia((q) => q === MEDIA.belowLg || q === MEDIA.md);
    render(<EstimatesTab estimates={[ESTIMATE]} isLoading={false} isError={false} onRetry={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    window.matchMedia = originalMatchMedia;
  });

  it('Leads, Estimates, Jobs, Invoices and Payments render a table and no cards', () => {
    for (const ui of [
      <LeadsTab key="l" view={view([LEAD])} timeZone={ORG} onNavigate={vi.fn()} />,
      <EstimatesTab key="e" estimates={[ESTIMATE]} isLoading={false} isError={false} onRetry={vi.fn()} onNavigate={vi.fn()} />,
      <JobsTab key="j" view={view([JOB])} onNavigate={vi.fn()} />,
      <InvoicesTab key="i" invoices={[INVOICE]} />,
      <PaymentsTab key="p" invoices={[INVOICE]} />,
    ]) {
      const { unmount } = render(ui);
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.queryByRole('listitem')).toBeNull();
      unmount();
    }
  });
});
