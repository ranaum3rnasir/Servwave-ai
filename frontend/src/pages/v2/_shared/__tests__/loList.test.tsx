/**
 * The v2 Logistic Orders list - the port of `src/__tests__/lo-list.test.tsx`
 * onto the rebuilt component, now promoted to `pages/v2/_shared/loList.tsx`.
 *
 * The rebuild is a PRESENTATION rebuild: the pill chips became kit Buttons
 * carrying `aria-pressed` inside a `role="group"`, the hand-rolled `<table>`
 * became the kit DataTable and the card header became a PageHeader. Everything
 * the legacy suite pinned was meant to survive:
 *   - the status chips drive the SERVER query, not a client filter;
 *   - the Pending chip's badge comes from its own `status: PENDING_APPROVAL,
 *     limit: 1` query, so it is independent of the active chip;
 *   - the create button is gated on `create LogisticOrder`;
 *   - the Anchor column is dropped once the list is anchored.
 *
 * DIVERGENCE from the legacy suite, one, and it was NOT in the ledger: the kit
 * DataTable renders a `role="separator"` resize grip inside every `<th>` when
 * `enableColumnResizing` is on, and that grip's `aria-label` is folded into the
 * column header's accessible name by name-from-content. The legacy
 * `getByRole('columnheader', { name: 'Anchor' })` therefore misses; the name is
 * now literally `Anchor Resize Anchor column`. Nothing is lost - the column is
 * there and its visible text is unchanged - so the assertion selects on the
 * header's own text and pins the new name beside it rather than being weakened.
 *
 * `useLogisticOrders` is mocked to serve a fixture array filtered by the passed
 * filters (so the chip -> query -> rows wiring is exercised for real).
 * `LODetailSheet` is stubbed - v2 mounts the LEGACY sheet unchanged and its own
 * suite covers it.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { LogisticOrderListRow } from '@/lib/api/logisticOrders';

import { LOList } from '../loList';

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

/** The header row's cells, by their own text - see the DIVERGENCE note above. */
function columnHeaderTexts(): string[] {
  return screen
    .getAllByRole('columnheader')
    .map((th) => th.textContent?.trim() ?? '');
}

describe('v2 LOList - filter chips', () => {
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

  it('the chips are a labelled group and the active one carries aria-pressed', async () => {
    renderList();
    const group = screen.getByRole('group', { name: 'Logistic order status' });
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(within(group).getByRole('button', { name: 'Processed' }));

    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(group).getByRole('button', { name: 'Processed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('v2 LOList - pending badge', () => {
  it('renders the true pending-approval count on the Pending chip', () => {
    renderList();
    // Two PENDING_APPROVAL rows in the fixture -> the Pending chip reads "Pending 2".
    expect(screen.getByRole('button', { name: /Pending\s*2/ })).toBeInTheDocument();
  });

  it('keeps the badge on the true total after a chip narrows the list', async () => {
    renderList();
    // Filtering to PROCESSED empties the list of pending rows; the badge rides
    // its own limit:1 query, so it must not follow.
    await userEvent.click(screen.getByRole('button', { name: 'Processed' }));
    expect(screen.getByRole('button', { name: /Pending\s*2/ })).toBeInTheDocument();
  });

  it('omits the badge when nothing is pending', () => {
    h.rows = FIXTURE.filter((r) => r.status !== 'PENDING_APPROVAL');
    renderWithProviders(<LOList />, { ability: createAbility() });
    // No badge -> the accessible name is just "Pending".
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pending\s*\d/ })).not.toBeInTheDocument();
  });
});

describe('v2 LOList - create button ability gating', () => {
  it('renders the create button when the ability can create a LogisticOrder', () => {
    renderList();
    expect(screen.getByRole('button', { name: /New logistic order/i })).toBeInTheDocument();
  });

  it('hides the create button without the create grant', () => {
    h.rows = FIXTURE;
    renderWithProviders(<LOList />); // no ability -> deny-everything
    expect(screen.queryByRole('button', { name: /New logistic order/i })).not.toBeInTheDocument();
  });
});

describe('v2 LOList - anchor column', () => {
  it('shows the Anchor column on the standalone list', () => {
    renderList();
    expect(columnHeaderTexts()).toContain('Anchor');
    // The exact accessible name today, pinned so the divergence above is a
    // fact in the suite and not just a comment.
    expect(
      screen.getByRole('columnheader', { name: 'Anchor Resize Anchor column' }),
    ).toBeInTheDocument();
  });

  it('drops the Anchor column when the list is anchored to a job', () => {
    renderList({ jobId: 'job-1' });
    expect(columnHeaderTexts()).not.toContain('Anchor');
    // Still scoped to that job's rows.
    expect(screen.getByText('LO-J00042-1')).toBeInTheDocument();
    expect(screen.queryByText('LO00001')).not.toBeInTheDocument();
  });

  it('an anchored row links to its job record and the link does not open the sheet', () => {
    renderList();
    const link = screen.getAllByRole('link', { name: 'J00042' })[0]!;
    expect(link).toHaveAttribute('href', expect.stringContaining('job-1'));
  });
});

describe('v2 LOList - empty states', () => {
  it('the unfiltered empty list explains itself', () => {
    h.rows = [];
    renderWithProviders(<LOList />, { ability: createAbility() });
    expect(screen.getByText(/No logistic orders yet/)).toBeInTheDocument();
  });

  it('a chip that matches nothing names the status it filtered on', async () => {
    h.rows = FIXTURE.filter((r) => r.status !== 'PROCESSED');
    renderWithProviders(<LOList />, { ability: createAbility() });
    await userEvent.click(screen.getByRole('button', { name: 'Processed' }));
    expect(screen.getByText('No processed logistic orders.')).toBeInTheDocument();
  });
});
