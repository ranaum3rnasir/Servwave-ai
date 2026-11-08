/**
 * The v2 Activity tab body - the port of
 * `src/__tests__/inventory-action-log.test.tsx` onto the rebuilt component at
 * `pages/v2/inventory/components/actionLogView.tsx`.
 *
 * Same method as the legacy suite, deliberately: `useMovements` stays REAL over
 * the setup-mocked axios, so the camelCase -> snake_case param mapping is
 * exercised end to end and every filter assertion is about the request that
 * actually goes out. The picker hooks resolve from the same URL-routed
 * `api.get` mock.
 *
 * Two DOCUMENTED divergences from the legacy suite (gaps doc, "Behaviour not
 * reproduced, slice 2"), both asserted in their new form rather than dropped:
 *   - the verb chip renders `Consume`, from the same label map the Type filter
 *     uses, instead of the raw enum capitalised in CSS. Rendered text identical,
 *     DOM text case changed.
 *   - the Job / Invoice / Logistic-Order links route through `v2Path`, so they
 *     resolve under `/`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import type { Movement } from '@/lib/api/inventory';

import { ActionLogView } from '../components/actionLogView';
// The component renders EM_DASH for an absent location, so the assertion below
// has to carry the same character. Imported from the same constant the
// component uses rather than typed literally, which keeps pages/v2 free of
// literal em dashes and makes the two sides impossible to drift apart.
import { EM_DASH } from '../glyphs';

// Unlike `src/__tests__/`, which tsconfig excludes, this directory IS
// typechecked - so the mocks carry their real signatures rather than leaning
// on `any` the way the legacy suite can.
const hoisted = vi.hoisted(() => ({
  toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
  downloadCSV: vi.fn(),
}));

vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

const mockApi = vi.mocked(api);

const MOVES: Movement[] = [
  {
    id: 'mv-1',
    occurredAt: '2026-07-15T10:30:00.000Z',
    itemSku: 'CAM-01',
    itemName: 'Dome Camera',
    type: 'consume',
    qty: 2,
    fromLocationId: 'loc-1',
    reference: 'Job J00042',
    actor: 'Mike Alvarez',
    itemId: 'itm-1',
    jobId: 'job-1',
    jobNumber: 'J00042',
    invoiceId: 'inv-1',
    invoiceNumber: 'I00007',
    fromLocationName: 'Main Warehouse',
    actorUserId: 'usr-1',
    unitCost: 12.5,
    logisticOrderId: 'lo-uuid-1',
    logisticOrderNumber: 'LO-J00224-1',
  },
  {
    id: 'mv-2',
    occurredAt: '2026-07-14T09:00:00.000Z',
    itemSku: 'LCK-02',
    itemName: 'Smart Lock',
    type: 'transfer',
    qty: 1.5,
    fromLocationId: 'loc-1',
    toLocationId: 'loc-2',
    reference: 'TR-1',
    actor: 'Stephanie Diaz',
    fromLocationName: 'Main Warehouse',
    toLocationName: 'Van 1',
  },
];

// Mutable per-test movements payload the URL router below serves.
let movementsPayload: { data: Movement[]; meta: { page: number; limit: number; total: number; totalPages: number } };

function installGetRouter() {
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/movements') {
      return Promise.resolve({ data: movementsPayload });
    }
    if (url.startsWith('/api/inventory/items')) {
      return Promise.resolve({
        data: { data: [{ id: 'itm-1', sku: 'CAM-01', name: 'Dome Camera', category: '', trade: 'security', kind: 'material', uom: 'ea', sellPrice: 0, serialized: false, hazmat: false, status: 'active', vendor: 'Acme', stock: [], updatedAt: '' }] },
      });
    }
    if (url === '/api/inventory/locations') {
      return Promise.resolve({
        data: { locations: [{ id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }, { id: 'loc-2', name: 'Van 1', type: 'truck', branch: 'HQ' }] },
      });
    }
    if (url === '/api/inventory/techs') {
      return Promise.resolve({ data: { techs: [{ id: 'usr-1', name: 'Mike Alvarez', role: 'field_tech', branch: 'HQ' }] } });
    }
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
}

function movementCalls() {
  return mockApi.get.mock.calls.filter((c) => c[0] === '/api/inventory/movements');
}

/** The params of the most recent movements request. */
function lastMovementParams(): Record<string, unknown> {
  const call = movementCalls().at(-1) as [string, { params?: Record<string, unknown> }] | undefined;
  return call?.[1]?.params ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  movementsPayload = { data: MOVES, meta: { page: 1, limit: 25, total: 2, totalPages: 1 } };
  installGetRouter();
});

describe('v2 ActionLogView', () => {
  it('renders the ledger: type chip, item, qty, route names, job/invoice links, actor, cost', async () => {
    renderWithProviders(<ActionLogView />);

    expect(await screen.findByText('Dome Camera')).toBeInTheDocument();
    // DIVERGENCE (documented): the chip carries the label, not the raw enum.
    expect(screen.getByText('Consume')).toBeInTheDocument();
    expect(screen.queryByText('consume')).toBeNull();
    // a consume movement has no destination location, so the route dashes out
    expect(screen.getByText(`Main Warehouse → ${EM_DASH}`)).toBeInTheDocument();
    expect(screen.getByText('Main Warehouse → Van 1')).toBeInTheDocument();
    expect(screen.getByText('1.50')).toBeInTheDocument(); // Decimal-safe qty
    // DIVERGENCE (documented): cross-record links resolve under /v2.
    expect(screen.getByRole('link', { name: 'J00042' })).toHaveAttribute('href', '/jobs/job-1');
    expect(screen.getByRole('link', { name: 'I00007' })).toHaveAttribute('href', '/invoices/inv-1');
    expect(screen.getByText('Mike Alvarez')).toBeInTheDocument();
    // Cost column present because a row carries unitCost (canSeePricing server-side).
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
  });

  it('renders the row-level Logistic Order link on an unfiltered view', async () => {
    renderWithProviders(<ActionLogView />);
    await screen.findByText('Dome Camera');

    // mv-1 carries a logisticOrderId; the view isn't filtered to it, so the
    // row-level link renders (suppression only applies to the active LO filter).
    const loLink = screen.getByRole('link', { name: 'LO-J00224-1' });
    expect(loLink).toHaveAttribute('href', expect.stringContaining('/inventory/activity?lo='));
    expect(loLink).toHaveAttribute('href', '/inventory/activity?lo=lo-uuid-1');
  });

  it('each filter control re-queries with the right snake_case param', async () => {
    renderWithProviders(<ActionLogView />);
    await screen.findByText('Dome Camera');

    // Type
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Consume' }));
    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({ type: 'consume', page: 1, limit: 25 }),
      }),
    );

    // Item
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by item' }));
    await userEvent.click(await screen.findByRole('option', { name: 'CAM-01 · Dome Camera' }));
    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({ item_id: 'itm-1' }),
      }),
    );

    // Location
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by location' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Van 1' }));
    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({ location_id: 'loc-2' }),
      }),
    );

    // Actor
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by actor' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Mike Alvarez' }));
    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({ actor_user_id: 'usr-1' }),
      }),
    );

    // Dates. `_shared/datePicker` replaced the native inputs (whose field ORDER
    // came from the browser locale), so these are typeable text fields that
    // commit on blur - the ISO form stays an accepted input pattern, and the
    // string handed to the query is unchanged.
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-07-01' } });
    fireEvent.blur(screen.getByLabelText('From date'));
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-07-16' } });
    fireEvent.blur(screen.getByLabelText('To date'));
    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({
          occurred_from: '2026-07-01',
          occurred_to: '2026-07-16',
        }),
      }),
    );
  });

  it('cost column is absent when no row carries unitCost (server-stripped)', async () => {
    movementsPayload = {
      data: MOVES.map(({ unitCost: _unitCost, ...m }) => m as Movement),
      meta: { page: 1, limit: 25, total: 2, totalPages: 1 },
    };
    renderWithProviders(<ActionLogView />);

    await screen.findByText('Dome Camera');
    expect(screen.queryByText('Cost')).toBeNull();
    expect(screen.queryByText('$12.50')).toBeNull();
  });

  it('CSV export snapshots the current filters (limit 100) through toCSV/downloadCSV', async () => {
    renderWithProviders(<ActionLogView />);
    await screen.findByText('Dome Camera');

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Consume' }));
    await screen.findByText('Dome Camera');

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const exportCall = movementCalls().at(-1)!;
    expect(exportCall[1]).toMatchObject({
      params: expect.objectContaining({ type: 'consume', page: 1, limit: 100 }),
    });
    const csvRows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(csvRows).toHaveLength(2);
    // The CSV keeps the RAW enum - the label map is a chip concern, not a
    // payload one, so the exported file is byte-identical to the legacy one.
    expect(csvRows[0]).toMatchObject({
      sku: 'CAM-01',
      type: 'consume',
      job: 'J00042',
      from: 'Main Warehouse',
      unitCost: 12.5,
    });
    expect(hoisted.downloadCSV).toHaveBeenCalledWith('csv-content', expect.stringMatching(/^stock-activity-.*\.csv$/));
  });

  it('pagination drives page params off meta.totalPages', async () => {
    movementsPayload = { data: MOVES, meta: { page: 1, limit: 25, total: 60, totalPages: 3 } };
    renderWithProviders(<ActionLogView />);

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({ page: 2 }),
      }),
    );
  });

  it('reads ?lo= from the URL, filters by it, and shows a dismissible chip', async () => {
    renderWithProviders(<ActionLogView />, { initialEntries: ['/inventory/activity?lo=lo-uuid-1'] });

    await waitFor(() => {
      expect(lastMovementParams().logistic_order_id).toBe('lo-uuid-1');
    });

    await waitFor(() => {
      expect(screen.getByText(/LO-J00224-1/)).toBeInTheDocument();
    });

    // Actually dismiss it: the chip (and its close control) must disappear, and
    // the next query must drop logistic_order_id - not just the label text
    // matching (mv-1's row-level LO link would still say "LO-J00224-1" once
    // unfiltered).
    await userEvent.click(screen.getByRole('button', { name: 'Clear Logistic Order filter' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Clear Logistic Order filter' })).toBeNull();
    });
    expect(screen.queryByText(/Filtered to/)).toBeNull();

    await waitFor(() => {
      expect(lastMovementParams().logistic_order_id).toBeUndefined();
    });
  });

  it('resets pagination when the LO filter changes (e.g. via a row link)', async () => {
    movementsPayload = { data: MOVES, meta: { page: 1, limit: 25, total: 60, totalPages: 3 } };
    renderWithProviders(<ActionLogView />);

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();

    // Advance to page 2 first.
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({ page: 2 }),
      }),
    );

    // Now change the LO filter via the row link - page must snap back to 1
    // instead of re-querying page 2 of a (likely single-page) LO result set.
    await userEvent.click(screen.getByRole('link', { name: 'LO-J00224-1' }));

    await waitFor(() =>
      expect(movementCalls().at(-1)![1]).toMatchObject({
        params: expect.objectContaining({ logistic_order_id: 'lo-uuid-1', page: 1 }),
      }),
    );
  });

  it('CSV export honours the LO filter it claims to snapshot', async () => {
    renderWithProviders(<ActionLogView />, { initialEntries: ['/inventory/activity?lo=lo-uuid-1'] });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() => {
      expect(lastMovementParams().logistic_order_id).toBe('lo-uuid-1');
      expect(lastMovementParams().limit).toBe(100);
    });
  });
});
