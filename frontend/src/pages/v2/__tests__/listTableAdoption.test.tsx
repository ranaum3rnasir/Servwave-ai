import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomersPage from '../customers/CustomersPage';
import EstimatesPage from '../estimates/EstimatesPage';
import InvoicesPage from '../invoices/InvoicesPage';
import JobsPage from '../jobs/JobsPage';
import LeadsPage from '../leads/LeadsPage';
import { buildCustomerColumns } from '../customers/customersColumns';
import { buildEstimateColumns } from '../estimates/estimatesColumns';
import { buildInvoiceColumns } from '../invoices/invoicesColumns';
import { buildJobColumns } from '../jobs/jobsColumns';
import { buildLeadColumns } from '../leads/leadsColumns';

/**
 * The adoption pass: the five v2 lists on the kit DataTable's real state props.
 *
 * Every assertion here was run against the pre-adoption pages first. The ones
 * that went red there - and are the point of this file - are the saved view
 * (no list had one), the resize grips (never drawn), the pinned identity run
 * (no `meta.pinned` survived the rebuild), the card layout, estimates' row
 * highlight (its checkboxes bypassed the table entirely, so a ticked row was
 * never `data-state="selected"`), and the `enableSorting: false` sweep. The
 * rest are regression guards over behaviour the workarounds did reproduce, and
 * are marked as such where it matters.
 */

const mockApi = vi.mocked(api);

// ─── fixtures ─────────────────────────────────────────────────────────────────

const PAGINATION = { page: 1, limit: 25, total: 1, totalPages: 1 };

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  customer_number: 'C00001',
  first_name: 'John',
  last_name: 'Doe',
  company_name: null,
  email: 'john@doe.test',
  phone: '5125550100',
  ad_source: null,
  created_at: '2026-01-15T00:00:00.000Z',
  service_locations: [],
  _count: { leads: 1, jobs: 2 },
  tags: [],
};

const CUSTOMERS_FIXTURE = { customers: [CUSTOMER], pagination: PAGINATION };
const CUSTOMER_STATS = { total: 10, newThisMonth: 2, activeLeads: 3, activeJobs: 4 };

const ESTIMATE = {
  id: 'e0000000-0000-0000-0000-000000000001',
  estimate_number: 'E00001',
  status: 'DRAFT',
  subtotal: 100,
  tax_amount: 0,
  total_amount: 100,
  created_at: '2026-01-15T00:00:00.000Z',
  lead: null,
  customer: {
    id: CUSTOMER.id, first_name: 'John', last_name: 'Doe',
    company_name: null, customer_number: 'C00001',
  },
  creator: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
  deposit: null,
  tags: [],
};

const ESTIMATES_FIXTURE = {
  estimates: [ESTIMATE],
  pagination: PAGINATION,
  stats: {
    draft: { count: 1, value: 100 }, sent: { count: 0, value: 0 },
    pending: { count: 0, value: 0 }, won: { count: 0, value: 0 },
    declined: { count: 0, value: 0 }, archived: { count: 0, value: 0 },
  },
};

const INVOICE = {
  id: 'i0000000-0000-0000-0000-000000000001',
  invoice_number: 'I00001',
  status: 'SENT',
  kind: 'STANDARD',
  subtotal: 100,
  discount_amount: 0,
  tax_amount: 8,
  deposit_credit: 0,
  total_amount: 108,
  amount_due: 108,
  due_date: null,
  sent_at: null,
  paid_at: null,
  created_at: '2026-01-15T00:00:00.000Z',
  customer: { id: CUSTOMER.id, first_name: 'John', last_name: 'Doe', company_name: null },
  job: null,
  tags: [],
};

const INVOICES_FIXTURE = {
  invoices: [INVOICE],
  pagination: PAGINATION,
  stats: {
    due: { total: 108, count: 1 },
    overdue: { total: 0, count: 0 },
    collected_this_month: { total: 0, count: 0 },
    unsent: 0,
    need_invoices: 0,
  },
};

const JOBS_FIXTURE = {
  jobs: [
    {
      id: 'j0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scheduled_start: null,
      created_at: '2026-01-15T00:00:00.000Z',
      customer: {
        id: CUSTOMER.id, first_name: 'John', last_name: 'Doe',
        company_name: null, customer_number: 'C00001',
      },
      assignees: [],
      service_location: null,
      tags: [],
    },
  ],
  pagination: PAGINATION,
  stats: { unassigned: 0, scheduled: 1, in_progress: 0, completed: 0, cancelled: 0, need_invoices: 0 },
};

const LEADS_FIXTURE = {
  leads: [
    {
      id: 'l0000000-0000-0000-0000-000000000001',
      lead_number: 'L00001',
      status: 'NEW',
      service_request: 'AC not cooling',
      job_type: null,
      created_at: '2026-01-15T00:00:00.000Z',
      customer: {
        id: CUSTOMER.id, first_name: 'John', last_name: 'Doe',
        company_name: null, phone: '5125550100', customer_number: 'C00001', ad_source: null,
      },
      commission_owner: null,
      estimates: [],
    },
  ],
  pagination: PAGINATION,
  stats: { total: 1, new_this_week: 1, unassigned: 1, won: 0, lost: 0 },
};

/**
 * Every list under test, with the one ability its bulk affordances need and the
 * data its own endpoint returns. Table-driven so a list cannot quietly opt out
 * of an adoption assertion by not being in the file.
 */
const LISTS = [
  {
    name: 'customers',
    Page: CustomersPage,
    path: '/customers',
    endpoint: '/api/customers',
    data: CUSTOMERS_FIXTURE,
    ability: () => buildAbility([{ action: 'update', subject: 'Customer' }]),
    rowText: 'C00001',
    sortHeader: 'Customer #',
    sortBy: 'customer_number',
    /** A column the saved view can hide, and its header text. */
    hidable: { id: 'email', header: 'Email' },
    /** Leading pinned column header, by accessible name. */
    firstHeaderText: '',
    selection: { checkbox: /Select John Doe/i, bulkText: '1 customer selected' },
  },
  {
    name: 'estimates',
    Page: EstimatesPage,
    path: '/estimates',
    endpoint: '/api/estimates',
    data: ESTIMATES_FIXTURE,
    ability: () => buildAbility([{ action: 'update', subject: 'Estimate' }]),
    rowText: 'E00001',
    sortHeader: 'Estimate #',
    sortBy: 'estimate_number',
    hidable: { id: 'created_by', header: 'Created By' },
    firstHeaderText: '',
    selection: { checkbox: /Select estimate E00001/i, bulkText: '1 estimate selected' },
  },
  {
    name: 'invoices',
    Page: InvoicesPage,
    path: '/invoices',
    endpoint: '/api/invoices',
    data: INVOICES_FIXTURE,
    ability: () => buildAbility([{ action: 'send', subject: 'Invoice' }]),
    rowText: 'I00001',
    sortHeader: 'Invoice #',
    sortBy: 'invoice_number',
    hidable: { id: 'tags', header: 'Tags' },
    firstHeaderText: '',
    selection: { checkbox: /Select row/i, bulkText: '1 invoice selected' },
  },
  {
    name: 'jobs',
    Page: JobsPage,
    path: '/jobs',
    endpoint: '/api/jobs',
    data: JOBS_FIXTURE,
    ability: () => buildAbility([{ action: 'assign', subject: 'Job' }]),
    rowText: 'J00001',
    sortHeader: 'Job #',
    sortBy: 'job_number',
    hidable: { id: 'location', header: 'Location' },
    firstHeaderText: '',
    selection: { checkbox: /Select J00001/i, bulkText: '1 job selected' },
  },
  {
    name: 'leads',
    Page: LeadsPage,
    path: '/leads',
    endpoint: '/api/leads',
    data: LEADS_FIXTURE,
    ability: () => buildAbility([{ action: 'read', subject: 'Lead' }]),
    rowText: 'L00001',
    sortHeader: 'Lead #',
    sortBy: 'lead_number',
    hidable: { id: 'walkthrough', header: 'Walkthrough' },
    firstHeaderText: '',
    // NO selection on leads. Its one bulk action was Export selected, which the
    // toolbar's own Export already does from the same mapping, so the checkbox
    // column and the bulk bar came back out. Every other list keeps its
    // selection, which is why this is a per-list `null` and not a deletion of
    // the selection block below.
    selection: null,
  },
] as const;

// ─── harness ──────────────────────────────────────────────────────────────────

/**
 * One `api.get` resolver for every endpoint any of these pages touches.
 *
 * `savedView` seeds `GET /api/me/table-views/:key`; `null` is what the real
 * endpoint returns for a user with nothing stored, and the DataTable
 * distinguishes that from "still loading".
 */
function mockGets(list: (typeof LISTS)[number], savedView: unknown = null) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/me/table-views/')) {
      return { data: savedView ?? {} };
    }
    if (url === '/api/customers/stats') return { data: CUSTOMER_STATS };
    if (url === list.endpoint) return { data: list.data };
    // The lists also fetch tags, assignable users, departments, creators and
    // the org record; an empty object satisfies every one of them.
    return { data: {} };
  });
  mockApi.put.mockResolvedValue({ data: {} });
}

async function renderList(list: (typeof LISTS)[number]) {
  const result = renderWithProviders(<list.Page />, {
    ability: list.ability(),
    initialEntries: [list.path],
  });
  expect(await screen.findByText(list.rowText)).toBeInTheDocument();
  return result;
}

/** The params of the most recent GET against this list's own endpoint. */
function lastListParams(list: (typeof LISTS)[number]): Record<string, unknown> {
  const calls = mockApi.get.mock.calls.filter(([url]) => url === list.endpoint);
  const last = calls[calls.length - 1];
  return (last?.[1] as { params?: Record<string, unknown> })?.params ?? {};
}

function headerTexts(): string[] {
  return screen.getAllByRole('columnheader').map((th) => th.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. sorting ───────────────────────────────────────────────────────────────

describe('sorting reaches the table', () => {
  /**
   * RED before the adoption. Every column in all five sets carried
   * `enableSorting: false`, because the kit table owned its sorting state with
   * no way in, so declaring a column sortable would have made the table sort
   * rows the server had already sorted.
   */
  // Built inside the case, not in the `it.each` table: a builder that throws
  // must fail its own test rather than the whole file's collection.
  it.each([
    ['customers', () => buildCustomerColumns([], () => {}, true)],
    ['estimates', () => buildEstimateColumns({ sorting: [], onToggleSort: () => {} })],
    ['invoices', () => buildInvoiceColumns([], () => {}, () => {}, 'America/New_York')],
    // These builders all take a trailing org-tz argument - jobs from the
    // Scheduled-cell change, leads from #1703, invoices from the days-overdue
    // fix - and it is irrelevant to this structural assertion, so a fixed
    // literal stands in for it.
    ['jobs', () => buildJobColumns([], () => {}, true, 'America/New_York')],
    ['leads', () => buildLeadColumns([], () => {}, 'America/New_York')],
  ])('%s declares no column unsortable', (_name, build) => {
    const disabled = build().filter((c) => c.enableSorting === false).map((c) => c.id);
    expect(disabled).toEqual([]);
  });

  it.each(LISTS)('$name sends the column id as sortBy when its header is clicked', async (list) => {
    mockGets(list);
    await renderList(list);

    await userEvent.click(screen.getByRole('button', { name: list.sortHeader }));

    await waitFor(() => {
      expect(lastListParams(list)).toMatchObject({ sortBy: list.sortBy, sortDir: 'asc' });
    });
  });

  it.each(LISTS)('$name leaves the rows in server order under manualSorting', async (list) => {
    mockGets(list);
    await renderList(list);

    await userEvent.click(screen.getByRole('button', { name: list.sortHeader }));

    // One row in, one row out: the table must not have dropped or reordered it
    // while the refetch for the new sort is in flight.
    await waitFor(() => {
      expect(lastListParams(list)).toMatchObject({ sortBy: list.sortBy });
    });
    expect(screen.getByText(list.rowText)).toBeInTheDocument();
  });
});

// ─── 2. row selection ─────────────────────────────────────────────────────────

const SELECTABLE = LISTS.filter((l) => l.selection !== null);

describe('selection reaches the bulk bar', () => {
  it.each(SELECTABLE)('$name lifts a ticked row into the bulk action bar', async (list) => {
    mockGets(list);
    await renderList(list);

    await userEvent.click(screen.getByRole('checkbox', { name: list.selection!.checkbox }));

    const bar = await screen.findByRole('status');
    expect(within(bar).getByText(list.selection!.bulkText)).toBeInTheDocument();
  });

  /**
   * RED before the adoption on estimates specifically: its checkboxes bound
   * straight to the page's selected-id array and never told the table, so the
   * row never carried `data-state="selected"` and the footer never read a
   * selection back. The other three already went through the table.
   */
  it.each(SELECTABLE)('$name marks the ticked ROW selected, not just the box', async (list) => {
    mockGets(list);
    await renderList(list);

    await userEvent.click(screen.getByRole('checkbox', { name: list.selection!.checkbox }));

    const body = document.querySelector('[data-slot="table-body"]')!;
    const selected = Array.from(body.querySelectorAll('tr[data-state="selected"]'));
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain(list.rowText);
  });

  it.each(SELECTABLE)('$name drops the selection when the query scope moves', async (list) => {
    mockGets(list);
    await renderList(list);

    await userEvent.click(screen.getByRole('checkbox', { name: list.selection!.checkbox }));
    await screen.findByRole('status');

    // A sort change is a scope change: the selected id was picked against the
    // previous ordering and means nothing against the next one.
    await userEvent.click(screen.getByRole('button', { name: list.sortHeader }));

    await waitFor(() => {
      expect(screen.queryByText(list.selection!.bulkText)).not.toBeInTheDocument();
    });
  });

  it.each(SELECTABLE)('$name clears from the bulk bar itself', async (list) => {
    mockGets(list);
    await renderList(list);

    await userEvent.click(screen.getByRole('checkbox', { name: list.selection!.checkbox }));
    const bar = await screen.findByRole('status');

    await userEvent.click(within(bar).getByRole('button', { name: /clear/i }));

    expect(screen.queryByText(list.selection!.bulkText)).not.toBeInTheDocument();
  });
});

// ─── 3. column visibility ─────────────────────────────────────────────────────

describe('invoices default column visibility', () => {
  const invoices = LISTS.find((l) => l.name === 'invoices')!;

  it('starts with the four money columns hidden and the rest shown', async () => {
    mockGets(invoices);
    await renderList(invoices);

    const headers = headerTexts();
    for (const hidden of ['Subtotal', 'Discount', 'Tax', 'Deposit Credit']) {
      expect(headers).not.toContain(hidden);
    }
    expect(headers.some((h) => h.includes('Total'))).toBe(true);
    expect(headers.some((h) => h.includes('Amount Due'))).toBe(true);
  });
});

// ─── 4. the saved-view menu is gone ───────────────────────────────────────────

/**
 * The inverse of what this block used to assert.
 *
 * The saved view was restored during the adoption pass because five v2 lists
 * had silently lost per-user column layouts. The owner has since asked for the
 * "View" toolbar control to go, which makes both halves of the feature - the
 * save and the restore - unreachable, so the whole path is out rather than left
 * as a menu nobody can open. These three cases pin the removal: no control, no
 * fetch, and a stored view that no longer moves a column.
 *
 * `useTableView` itself stays - `components/data/data-table.tsx`, the LEGACY
 * table, still drives it from `tableKey`, and legacy is the live app.
 */
describe('the saved-view menu is gone', () => {
  it.each(LISTS)('$name renders no View control in the toolbar', async (list) => {
    mockGets(list);
    await renderList(list);

    const toolbar = document.querySelector('[data-slot="data-table-toolbar"]') as HTMLElement;
    expect(within(toolbar).queryByRole('button', { name: /^view$/i })).toBeNull();
  });

  it.each(LISTS)('$name never fetches a stored table view', async (list) => {
    mockGets(list);
    await renderList(list);

    const viewCalls = mockApi.get.mock.calls
      .filter(([url]) => String(url).startsWith('/api/me/table-views/'));
    expect(viewCalls).toEqual([]);
  });

  it.each(LISTS)('$name shows every column even when a stored view would hide one', async (list) => {
    mockGets(list, {
      version: 1,
      columns: { [list.hidable.id]: { visible: false } },
    });
    await renderList(list);

    // Substring rather than exact match: a sortable header wraps its title in a
    // button, so the cell's textContent carries more than the label.
    expect(headerTexts().some((h) => h.includes(list.hidable.header))).toBe(true);
  });
});

// ─── 5. pinning and resize ────────────────────────────────────────────────────

describe('pinned columns and resizable widths', () => {
  /**
   * RED before the adoption: the rebuilt column sets dropped `meta.pinned`
   * entirely, so the identity columns scrolled away with everything else.
   */
  it.each(LISTS)('$name sticks its leading column to the left edge', async (list) => {
    mockGets(list);
    await renderList(list);

    const first = screen.getAllByRole('columnheader')[0]!;
    expect(first.style.position).toBe('sticky');
    expect(first.style.left).toBe('0px');
  });

  it.each(LISTS)('$name leaves a column outside the leading run unpinned', async (list) => {
    mockGets(list);
    await renderList(list);

    const headers = screen.getAllByRole('columnheader');
    expect(headers[headers.length - 1]!.style.position).toBe('');
  });

  /**
   * RED before the adoption: `enableColumnResizing` was never passed, so the
   * table accepted column sizing state but drew no handle to change it - which
   * made the widths a saved view stores unreachable.
   */
  it.each(LISTS)('$name draws a resize grip', async (list) => {
    mockGets(list);
    await renderList(list);

    expect(screen.getAllByRole('separator').length).toBeGreaterThan(0);
  });

  // "offers a way back from a drag" lived here and asserted the View menu's
  // "Reset column widths" item. That menu is gone with the saved view (see
  // block 4), and the reset had no other host, so the case goes with it rather
  // than being restated against a control that no longer exists.
});

// ─── 6. mobile cards ──────────────────────────────────────────────────────────

describe('the phone layout', () => {
  function setNarrowViewport() {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
  }

  /**
   * RED before the adoption: `mobileCards` was never passed, so a phone got the
   * full table and a horizontal scroll.
   */
  it.each(LISTS)('$name renders one labelled card per row below md', async (list) => {
    setNarrowViewport();
    mockGets(list);
    const { container } = await renderList(list);

    expect(container.querySelector('table')).toBeNull();
    const cards = container.querySelectorAll('[data-slot="table-card"]');
    expect(cards).toHaveLength(1);
    // Labels come from `meta.label`, so a card reads "Customer", never
    // "customer_number".
    expect(within(cards[0] as HTMLElement).getAllByRole('term').length).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });
});
