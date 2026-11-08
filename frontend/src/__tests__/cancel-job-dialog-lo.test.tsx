// LO-3 (spec §5 / §12 rec 6 / §14 H3) — CancelJobDialog Logistic-Order rows.
//
// Contract under test:
//   • One row per LO anchored to the job: number · status badge · aggregated consequence.
//     PROCESSED → "returns N item(s) to stock"; open (DRAFT/PENDING/APPROVED) → "will be
//     cancelled"; terminal (CANCELLED/RETURNED) → "no change". One number, never a per-line list.
//   • The single closing sentence "Processed orders return their stock automatically." renders
//     whenever any LO row is shown.
//   • The legacy "N synced inventory item(s) will be returned to stock." row (H3) COEXISTS with
//     the LO rows while any SYNCED job line still exists — neither replaces the other.
//   • No LOs + no synced lines → neither block renders (just the reason box).
//
// `api` is globally mocked (setup.ts). listJobLines + useLogisticOrders both hit it, so we route
// by URL in one mockImplementation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { CancelJobDialog } from '@/components/jobs/CancelJobDialog';
import type { LogisticOrderListRow, LogisticOrderStatus } from '@/lib/api/logisticOrders';

const mockApi = vi.mocked(api);

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

function loRow(
  number: string,
  status: LogisticOrderStatus,
  lineCount: number,
): LogisticOrderListRow {
  return {
    id: `id-${number}`,
    number,
    seq: 1,
    status,
    anchors: { jobId: JOB_ID, jobNumber: 'J00042' },
    lineCount,
    createdBy: null,
    processedAt: status === 'PROCESSED' ? '2026-07-19T00:00:00.000Z' : null,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

const SYNCED_LINE = {
  id: 'line-1',
  sequence: 1,
  description: 'Filter 20x20',
  quantity: 2,
  unit_price: 25,
  is_taxable: true,
  line_total: 50,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'MATERIAL',
  price_book_item_id: 'pb-1',
  stock_status: 'SYNCED',
};

function mockData(loRows: LogisticOrderListRow[], syncedLines: unknown[]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/line-items')) {
      return { data: { lines: syncedLines, billing: { total: 50, invoiced: 0, remaining: 50 } } };
    }
    if (url.includes('/api/logistic-orders')) {
      return { data: { data: loRows, page: 1, limit: 50, total: loRows.length } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

function render() {
  return renderWithProviders(
    <CancelJobDialog open onOpenChange={vi.fn()} jobId={JOB_ID} />,
  );
}

describe('CancelJobDialog — Logistic Order rows (spec §12 rec 6)', () => {
  it('renders one row per LO with the right badge + aggregated consequence across mixed statuses', async () => {
    mockData(
      [
        loRow('LO-J00042-1', 'PROCESSED', 3),
        loRow('LO-J00042-2', 'DRAFT', 2),
        loRow('LO-J00042-3', 'PENDING_APPROVAL', 1),
        loRow('LO-J00042-4', 'CANCELLED', 5),
      ],
      [],
    );

    render();

    // Numbers
    expect(await screen.findByText('LO-J00042-1')).toBeInTheDocument();
    expect(screen.getByText('LO-J00042-2')).toBeInTheDocument();
    expect(screen.getByText('LO-J00042-3')).toBeInTheDocument();
    expect(screen.getByText('LO-J00042-4')).toBeInTheDocument();

    // Status badges (shared StatusBadge, domain="logisticOrder", labels)
    expect(screen.getByText('Processed')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();

    // Aggregated consequence per status
    expect(screen.getByText('returns 3 items to stock')).toBeInTheDocument();
    expect(screen.getAllByText('will be cancelled')).toHaveLength(2); // DRAFT + PENDING
    expect(screen.getByText('no change')).toBeInTheDocument(); // CANCELLED

    // One closing sentence
    expect(
      screen.getByText('Processed orders return their stock automatically.'),
    ).toBeInTheDocument();
  });

  it('singularises the consequence for a one-line PROCESSED order', async () => {
    mockData([loRow('LO-J00042-9', 'PROCESSED', 1)], []);
    render();
    expect(await screen.findByText('returns 1 item to stock')).toBeInTheDocument();
  });

  it('shows the legacy SYNCED row COEXISTING with the LO rows (H3)', async () => {
    mockData([loRow('LO-J00042-1', 'PROCESSED', 3)], [SYNCED_LINE, { ...SYNCED_LINE, id: 'line-2' }]);
    render();

    // Both the LO block …
    expect(await screen.findByText('LO-J00042-1')).toBeInTheDocument();
    expect(
      screen.getByText('Processed orders return their stock automatically.'),
    ).toBeInTheDocument();
    // … and the legacy synced-line row are present at the same time.
    expect(
      screen.getByText('2 synced inventory item(s) will be returned to stock.'),
    ).toBeInTheDocument();
  });

  it('renders neither block when the job has no LOs and no synced lines', async () => {
    mockData([], []);
    render();

    // The dialog itself is up …
    expect(await screen.findByRole('button', { name: 'Keep Open' })).toBeInTheDocument();
    // … but no LO closing sentence and no legacy synced row.
    expect(
      screen.queryByText('Processed orders return their stock automatically.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/synced inventory item/)).not.toBeInTheDocument();
  });
});
