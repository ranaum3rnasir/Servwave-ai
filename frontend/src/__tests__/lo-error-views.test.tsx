// loErrorViews — shared render surfaces for the typed LO API errors (task LO-3 §1).
//
// Contract under test:
//   • LoShortagePanel (409) renders one row per short line (item · location · on-hand vs needed),
//     the "nothing was deducted" heading, and the Inventory-page restock link.
//   • LoLineInvalidPanel (422) renders the server's human message per bad line, with the item label
//     when present and none for whole-order issues (line_id null).
//   • LoStaleStatusNotice (409) renders the reload copy and, when given onReload, a Reload button.
//   • LoErrorView dispatches on `.kind`, folds the hard blocks to a red banner from `.message`,
//     and renders nothing for a null error.
//   • toastLoWarnings toasts once for warn-mode process warnings, wording from payload fields.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import {
  LoErrorView,
  LoShortagePanel,
  LoLineInvalidPanel,
  LoStaleStatusNotice,
  toastLoWarnings,
} from '@/components/inventory/lo/loErrorViews';
import type { LoShortageDetail, LoLineInvalidDetail } from '@/lib/api/logisticOrders';

const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', () => ({
  toast: (args: unknown) => h.toast(args),
  useToast: () => ({ toast: h.toast }),
}));

beforeEach(() => vi.clearAllMocks());

const SHORTAGE: LoShortageDetail[] = [
  {
    item_id: 'i1', item_sku: 'SKU-1', item_name: 'Filter 20x20',
    location_id: 'l1', location_name: 'Main Warehouse', requested: 3, available: 1,
  },
  {
    item_id: 'i2', item_sku: 'SKU-2', item_name: 'Coil',
    location_id: 'l2', location_name: 'Van 12', requested: 5, available: 0,
  },
];

describe('LoShortagePanel (409)', () => {
  it('renders a row per short line plus the restock link', () => {
    renderWithProviders(<LoShortagePanel details={SHORTAGE} />);
    expect(
      screen.getByText('Not enough stock to process — nothing was deducted.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Filter 20x20')).toBeInTheDocument();
    expect(screen.getByText('at Main Warehouse:')).toBeInTheDocument();
    expect(screen.getByText('1 on hand, 3 needed.')).toBeInTheDocument();
    expect(screen.getByText('Coil')).toBeInTheDocument();
    expect(screen.getByText('0 on hand, 5 needed.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /inventory page/i })).toHaveAttribute('href', '/inventory');
  });

  it('falls back to "this location" when a line has no location name', () => {
    renderWithProviders(
      <LoShortagePanel
        details={[{ ...SHORTAGE[0], location_name: null }]}
      />,
    );
    expect(screen.getByText('at this location:')).toBeInTheDocument();
  });
});

describe('LoLineInvalidPanel (422)', () => {
  const INVALID: LoLineInvalidDetail[] = [
    {
      line_id: 'ln1', item_sku: 'SKU-1', item_name: 'Filter 20x20',
      reason: 'MISSING_LOCATION', message: 'Pick a source location before processing.',
    },
    {
      line_id: null, item_sku: null, item_name: null,
      reason: 'NO_LINES', message: 'Add at least one line.',
    },
  ];

  it('renders the human message per line, labelled by item when present', () => {
    renderWithProviders(<LoLineInvalidPanel details={INVALID} />);
    expect(screen.getByText('These lines need fixing before you can save.')).toBeInTheDocument();
    expect(screen.getByText('Filter 20x20:')).toBeInTheDocument();
    expect(screen.getByText('Pick a source location before processing.')).toBeInTheDocument();
    // Whole-order issue (line_id null, no item) → message only, no label.
    expect(screen.getByText('Add at least one line.')).toBeInTheDocument();
    expect(screen.queryByText('null:')).toBeNull();
  });
});

describe('LoStaleStatusNotice (409)', () => {
  it('renders the reload copy and no button when onReload is omitted', () => {
    renderWithProviders(<LoStaleStatusNotice />);
    expect(
      screen.getByText('This order changed since you opened it — reload to see the latest.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  });

  it('fires onReload when the Reload button is clicked', async () => {
    const onReload = vi.fn();
    renderWithProviders(<LoStaleStatusNotice onReload={onReload} />);
    await userEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('LoErrorView — dispatch by kind', () => {
  it('routes SHORTAGE to the shortage panel', () => {
    renderWithProviders(
      <LoErrorView error={{ kind: 'SHORTAGE', message: 'shortage', details: SHORTAGE }} />,
    );
    expect(
      screen.getByText('Not enough stock to process — nothing was deducted.'),
    ).toBeInTheDocument();
  });

  it('routes LO_LINE_INVALID to the line-invalid panel', () => {
    renderWithProviders(
      <LoErrorView
        error={{
          kind: 'LO_LINE_INVALID',
          message: 'invalid',
          details: [
            { line_id: 'x', item_sku: null, item_name: 'Widget', reason: 'UNKNOWN_LOCATION', message: 'That location no longer exists.' },
          ],
        }}
      />,
    );
    expect(screen.getByText('That location no longer exists.')).toBeInTheDocument();
  });

  it('routes STALE_STATUS to the reload notice', () => {
    renderWithProviders(
      <LoErrorView error={{ kind: 'STALE_STATUS', message: 'stale', expectedStatus: ['DRAFT'] }} onReload={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('folds a hard block (JOB_CANCELLED) to a banner carrying the server message', () => {
    renderWithProviders(
      <LoErrorView error={{ kind: 'JOB_CANCELLED', message: 'This job was cancelled — no stock can move.' }} />,
    );
    expect(screen.getByText('This job was cancelled — no stock can move.')).toBeInTheDocument();
  });

  it('renders nothing for a null error', () => {
    const { container } = renderWithProviders(<LoErrorView error={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('toastLoWarnings — warn-mode process warnings', () => {
  const warn = (over: Partial<{ itemName: string; itemSku: string; onHandAfter: number | null }>) => ({
    lineId: 'ln', itemId: 'i', itemSku: 'SKU', itemName: 'Filter 20x20',
    locationId: 'l', qty: 3, onHandAfter: -2, shortage: true, ...over,
  });

  it('does nothing when there are no warnings', () => {
    toastLoWarnings({ warnings: [] });
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('names the single over-drawn line and its resulting on-hand', () => {
    toastLoWarnings({ warnings: [warn({})] });
    expect(h.toast).toHaveBeenCalledWith({
      title: 'Processed — stock went negative',
      description: 'Filter 20x20 is now -2 on hand after processing.',
    });
  });

  it('summarises the count when several lines went negative', () => {
    toastLoWarnings({ warnings: [warn({}), warn({ itemName: 'Coil' })] });
    expect(h.toast).toHaveBeenCalledWith({
      title: 'Processed — stock went negative',
      description: 'Filter 20x20 and 1 more went below zero after processing.',
    });
  });
});
