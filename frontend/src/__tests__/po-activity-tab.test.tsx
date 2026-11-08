// D7 — the PO detail Activity tab renders the REAL server timeline (audit-log
// lifecycle + outbound send history), replacing the old ActivityTabStub that
// fabricated actor names ("Emanuel Dahan" / "Counter staff") and timestamps off
// PO status and carried a "Synthesized from PO status" disclaimer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import type { PurchaseOrder, POActivityEvent } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => ({
  activity: [
    { id: 'a1', at: '2026-02-01T10:00:00Z', kind: 'created', summary: 'Purchase order created', actor: 'buyer@acme.test', detail: 'Vendor: ADI' },
    { id: 'a2', at: '2026-02-02T10:00:05Z', kind: 'email_sent', summary: 'Emailed to sales@adi.test', actor: null, detail: 'PO-2305 — ADI' },
    { id: 'a3', at: '2026-02-04T10:00:00Z', kind: 'received', summary: 'Received 2 lines', actor: 'counter@acme.test', detail: 'Status: partial' },
  ] as POActivityEvent[],
  state: { data: [] as POActivityEvent[], isLoading: false, isError: false },
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useLocations: stable([]),
    useUpdatePO: () => ({ mutate: vi.fn(), isPending: false }),
    usePOActivity: () => hoisted.state,
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', default_inventory_location_id: null }, isLoading: false, isError: false }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const PO: PurchaseOrder = {
  id: 'po-1',
  poNumber: 'PO-2305',
  vendor: 'ADI',
  status: 'partial',
  orderedAt: '2026-02-01T00:00:00Z',
  lines: [{ id: 'l1', itemSku: 'SKU-001', itemName: 'Strike', uom: 'EA', qtyOrdered: 5, qtyReceived: 2, unitCost: 10 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.state = { data: hoisted.activity, isLoading: false, isError: false };
});

describe('PODetailDialog — Activity tab (D7, real data)', () => {
  it('renders the real server timeline with real actors — no synthesized fallback', async () => {
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={PO} onReceive={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /activity/i }));

    // Real events, real actors from the audit log + send history.
    expect(screen.getByText('Purchase order created')).toBeInTheDocument();
    expect(screen.getByText(/buyer@acme\.test/)).toBeInTheDocument();
    expect(screen.getByText('Emailed to sales@adi.test')).toBeInTheDocument();
    expect(screen.getByText('Received 2 lines')).toBeInTheDocument();
    expect(screen.getByText(/counter@acme\.test/)).toBeInTheDocument();

    // The synthesized stub is gone: no fabricated actor, no disclaimer banner.
    expect(screen.queryByText(/Emanuel Dahan/)).toBeNull();
    expect(screen.queryByText(/Synthesized from PO status/)).toBeNull();
    expect(screen.queryByText(/purchase_order_status_history/)).toBeNull();
  });

  it('shows a truthful empty state when the PO has no recorded activity', async () => {
    hoisted.state = { data: [], isLoading: false, isError: false };
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={PO} onReceive={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /activity/i }));

    expect(screen.getByText(/No activity recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Emanuel Dahan/)).toBeNull();
  });
});
