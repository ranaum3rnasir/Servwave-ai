// LO-3 — LOList (the one Logistic Order list, re-anchored by props).
//
// Contract under test:
//   • Status filter chips drive the server query — clicking a chip re-scopes the visible rows.
//   • The Pending chip carries a badge with the true pending-approval total (dedicated limit:1
//     query, independent of the active filter).
//   • The create button is ability-gated on `create LogisticOrder` — absent without the grant.
//   • The Anchor column is dropped when the list is anchored (jobId/invoiceId/servicePlanId).
//
// useLogisticOrders is mocked to serve a fixture array filtered by the passed filters (so the
// chip→query→rows wiring is exercised for real). LODetailSheet is stubbed — this file tests the
// list, not the editor (its own suite covers that), and stubbing keeps the picker's seams out.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LOList } from '@/components/inventory/lo/LOList';
import { buildAbility } from '@/lib/ability';
import type { LogisticOrderListRow } from '@/lib/api/logisticOrders';

const h = vi.hoisted(() => ({
  rows: [] as LogisticOrderListRow[],
}));

vi.mock('@/components/inventory/lo/LODetailSheet', () => ({
  LODetailSheet: () => null,
}));

vi.mock('@/lib/api/logisticOrders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/logisticOrders')>();
  return {
    ...actual,
    useLogisticOrders: (filters: Record<string, unknown> = {}) => {
      let list = h.rows;
      if (filters.job_id) list = list.filter((r) => r.anchors.jobId === filters.job_id);
      if (filters.invoice_id) list = list.filter((r) => r.anchors.invoiceId === filters.invoice_id);
      if (filters.status) list = list.filter((r) => r.status === filters.status);
      const total = list.length;
      const limit = (filters.limit as number) ?? 50;
      return {
        data: { data: list.slice(0, limit), page: 1, limit, total },
        isLoading: false,
        isError: false,
      };
    },
  };
});

const ISO = '2026-07-18T10:00:00.000Z';
const person = { id: 'u1', name: 'Test Admin' };

function row(over: Partial<LogisticOrderListRow>): LogisticOrderListRow {
  return {
    id: 'lo?',
    number: 'LO?',
    seq: null,
    status: 'DRAFT',
    anchors: {},
    lineCount: 1,
    createdBy: person,
    processedAt: null,
    createdAt: ISO,
    ...over,
  };
}

const FIXTURE: LogisticOrderListRow[] = [
  row({ id: 'lo1', number: 'LO00001', status: 'DRAFT', lineCount: 2 }),
  row({
    id: 'lo2',
    number: 'LO-J00042-1',
    seq: 1,
    status: 'PENDING_APPROVAL',
    anchors: { jobId: 'job-1', jobNumber: 'J00042' },
  }),
  row({
    id: 'lo3',
    number: 'LO-J00042-2',
    seq: 2,
    status: 'PENDING_APPROVAL',
    anchors: { jobId: 'job-1', jobNumber: 'J00042' },
  }),
  row({ id: 'lo4', number: 'LO00002', status: 'PROCESSED', lineCount: 3, processedAt: ISO }),
];

const createAbility = () => buildAbility([{ action: 'create', subject: 'LogisticOrder' }]);

function renderList(props: React.ComponentProps<typeof LOList> = {}, ability = createAbility()) {
  h.rows = FIXTURE;
  return renderWithProviders(<LOList {...props} />, { ability });
}

describe('LOList — filter chips', () => {
  it('shows every order by default and narrows to one status when a chip is clicked', async () => {
    renderList();
    // Default (All): all four numbers present.
    expect(screen.getByText('LO00001')).toBeInTheDocument();
    expect(screen.getByText('LO-J00042-1')).toBeInTheDocument();
    expect(screen.getByText('LO00002')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Processed' }));

    // Only the PROCESSED row survives the filter.
    expect(screen.getByText('LO00002')).toBeInTheDocument();
    expect(screen.queryByText('LO00001')).not.toBeInTheDocument();
    expect(screen.queryByText('LO-J00042-1')).not.toBeInTheDocument();
  });
});

describe('LOList — pending badge', () => {
  it('renders the true pending-approval count on the Pending chip', () => {
    renderList();
    // Two PENDING_APPROVAL rows in the fixture → the Pending chip reads "Pending 2".
    expect(screen.getByRole('button', { name: /Pending\s*2/ })).toBeInTheDocument();
  });

  it('omits the badge when nothing is pending', () => {
    h.rows = FIXTURE.filter((r) => r.status !== 'PENDING_APPROVAL');
    renderWithProviders(<LOList />, { ability: createAbility() });
    // No badge → the accessible name is just "Pending".
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pending\s*\d/ })).not.toBeInTheDocument();
  });
});

describe('LOList — create button ability gating', () => {
  it('renders the create button when the ability can create a LogisticOrder', () => {
    renderList();
    expect(screen.getByRole('button', { name: /New logistic order/i })).toBeInTheDocument();
  });

  it('hides the create button without the create grant', () => {
    h.rows = FIXTURE;
    renderWithProviders(<LOList />); // no ability → deny-everything
    expect(screen.queryByRole('button', { name: /New logistic order/i })).not.toBeInTheDocument();
  });
});

describe('LOList — anchor column', () => {
  it('shows the Anchor column on the standalone list', () => {
    renderList();
    expect(screen.getByRole('columnheader', { name: 'Anchor' })).toBeInTheDocument();
  });

  it('drops the Anchor column when the list is anchored to a job', () => {
    renderList({ jobId: 'job-1' });
    expect(screen.queryByRole('columnheader', { name: 'Anchor' })).not.toBeInTheDocument();
    // Still scoped to that job's rows.
    expect(screen.getByText('LO-J00042-1')).toBeInTheDocument();
    expect(screen.queryByText('LO00001')).not.toBeInTheDocument();
  });
});
