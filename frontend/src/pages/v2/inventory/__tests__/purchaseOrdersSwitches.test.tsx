/**
 * Roles & Permissions S07.19 - the Purchase Orders page follows its switches and See costs.
 *
 * Rendered through the routed page (`/inventory/purchase-orders`) and the dialogs it opens, with the data hooks
 * seam-mocked to stable answers (see poBulkExport.test.tsx for why). The person's rules are built from the switches
 * under test:
 *   - Create purchase orders: Create PO;
 *   - Export purchase orders: the Export button and the checkboxes that exist for Export selected;
 *   - See costs (`read Pricing`): every amount (the Total column, the lines' unit cost and extension, the
 *     subtotal and total, the print preview, the cost field on a new order, the Total in a file).
 * An amount the person may not see is absent: no column, no dash standing in for a figure, never a $0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders, seedMySwitches } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  function po(n: number, status: 'draft' | 'ordered' | 'received', extra: Record<string, unknown> = {}) {
    return {
      id: `f000000${n}-0000-0000-0000-000000000001`,
      poNumber: `PO-100${n}`,
      vendor: 'Acme Supply',
      status,
      orderedAt: '2026-07-01T00:00:00.000Z',
      expectedDate: '2026-07-20T00:00:00.000Z',
      receivedAt: status === 'received' ? '2026-07-05T00:00:00.000Z' : null,
      leadTimeDays: status === 'received' ? 4 : null,
      orderedBy: null,
      notes: null,
      signatureData: null,
      signatureName: null,
      signatureAt: null,
      createdAt: '2026-06-30T00:00:00.000Z',
      lines: [{ id: `l${n}`, itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: 0, unitCost: 12.5 }],
      ...extra,
    };
  }
  const WITHOUT_COSTS = {
    id: 'f0000009-0000-0000-0000-000000000001',
    poNumber: 'PO-1009',
    vendor: 'Acme Supply',
    status: 'ordered',
    orderedAt: '2026-07-01T00:00:00.000Z',
    orderedBy: null,
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: '2026-06-30T00:00:00.000Z',
    // What the server sends a person without See costs: the line has no cost keys at all.
    lines: [{ id: 'lx', itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: 0 }],
  };
  return {
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
    pos: [po(1, 'ordered'), po(2, 'received'), po(3, 'draft')],
    costFree: WITHOUT_COSTS,
    org: { id: 'org-1', name: 'ServWave Test Co', default_inventory_location_id: 'loc-1' as string | null },
  };
});

vi.mock('@/lib/inventory/csv', () => ({ toCSV: hoisted.toCSV, downloadCSV: hoisted.downloadCSV }));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    usePurchaseOrders: stable(hoisted.pos as unknown as import('@/lib/api/inventory').PurchaseOrder[]),
    useInventoryJobs: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBrands: stable(EMPTY),
    useBranches: stable(EMPTY),
    useLocations: stable([{ id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    usePOActivity: stable(EMPTY),
    useCreatePO: mutation,
    useReceivePO: mutation,
    useUpdatePO: mutation,
    useMarkOrdered: mutation,
    useDeletePO: mutation,
  };
});

vi.mock('@/lib/api/shared/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/shared/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }) };
});

const { default: PurchaseOrdersPage } = await import('../PurchaseOrdersPage');
const { PODetailDialog } = await import('@/components/inventory/PODetailDialog');
const { POPreviewDialog } = await import('@/components/inventory/POPreviewDialog');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

const READ: AbilityRule[] = [{ action: 'read', subject: 'PurchaseOrder' }];
// See costs needs See prices.
const FINANCIAL: AbilityRule[] = [{ action: 'read', subject: 'Pricing' }, { action: 'read', subject: 'Prices' }];
const EXPORT: AbilityRule[] = [{ action: 'export', subject: 'PurchaseOrder' }];
// Create purchase orders needs Edit purchase orders.
const CREATE: AbilityRule[] = [{ action: 'create', subject: 'PurchaseOrder' }, { action: 'update', subject: 'PurchaseOrder' }];
const VENDORS: AbilityRule[] = [{ action: 'read', subject: 'Vendor' }];

const abilityOf = (...rules: AbilityRule[][]) => buildAbility([...READ, ...rules.flat()]);

async function renderPage(...rules: AbilityRule[][]) {
  renderWithProviders(<PurchaseOrdersPage />, {
    initialEntries: ['/inventory/purchase-orders'],
    ability: abilityOf(...rules),
  });
  expect(await screen.findByText('PO-1001')).toBeInTheDocument();
}

describe('the lists: the Total column follows See costs', () => {
  it('has a Total column on both tabs with it', async () => {
    await renderPage(FINANCIAL);
    expect(screen.getByRole('columnheader', { name: /total/i })).toBeInTheDocument();
    expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect(await screen.findByRole('columnheader', { name: /total/i })).toBeInTheDocument();
  });

  it('has no Total column on either tab without it, and no dollar amount on the page', async () => {
    await renderPage();
    expect(screen.queryByRole('columnheader', { name: /total/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    await screen.findByText('PO-1002');
    expect(screen.queryByRole('columnheader', { name: /total/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });
});

describe('Export purchase orders gates the download', () => {
  it('offers the Export button and the row checkboxes with it', async () => {
    await renderPage(FINANCIAL, EXPORT);
    expect(screen.getByRole('button', { name: /^export$/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select PO-1001' })).toBeInTheDocument();
  });

  it('offers neither without it', async () => {
    await renderPage(FINANCIAL);
    expect(screen.queryByRole('button', { name: /^export$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select PO-1001' })).not.toBeInTheDocument();
  });

  it('writes the Total into the file for a person who sees costs', async () => {
    await renderPage(FINANCIAL, EXPORT);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    const open = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(open[0]).toHaveProperty('Total', 50);

    hoisted.toCSV.mockClear();
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    await userEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    const history = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(history[0]).toHaveProperty('Total', 50);
  });

  it('writes no Total column into either file for a person without See costs', async () => {
    await renderPage(EXPORT);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    const open = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(open.length).toBeGreaterThan(0);
    for (const row of open) expect(Object.keys(row)).not.toContain('Total');
    expect(JSON.stringify(open)).not.toContain('50');

    hoisted.toCSV.mockClear();
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    await userEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    const history = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(history.length).toBeGreaterThan(0);
    for (const row of history) expect(Object.keys(row)).not.toContain('Total');
  });

  it('writes no Total into the selected-rows file either', async () => {
    await renderPage(EXPORT);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select PO-1001' }));
    const bar = await screen.findByRole('status');
    await userEvent.click(within(bar).getByRole('button', { name: /export selected/i }));
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).not.toContain('Total');
  });
});

describe('Create purchase orders draws Create PO', () => {
  it('shows it with the switch and not without', async () => {
    await renderPage(CREATE, VENDORS);
    expect(screen.getByRole('button', { name: /create po/i })).toBeInTheDocument();
  });

  it('is absent with Create purchase orders but without View vendors: a new order needs a vendor to pick', async () => {
    await renderPage(CREATE);
    expect(screen.queryByRole('button', { name: /create po/i })).not.toBeInTheDocument();
  });

  it('is absent without Create purchase orders', async () => {
    await renderPage(FINANCIAL, EXPORT);
    expect(screen.queryByRole('button', { name: /create po/i })).not.toBeInTheDocument();
  });

  it('has no unit cost field on the new-order form without See costs', async () => {
    await renderPage(CREATE, VENDORS);
    await userEvent.click(screen.getByRole('button', { name: /create po/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('columnheader', { name: /unit cost/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/unit cost/i)).not.toBeInTheDocument();
  });

  it('has the unit cost field on the new-order form with it', async () => {
    await renderPage(CREATE, VENDORS, FINANCIAL);
    await userEvent.click(screen.getByRole('button', { name: /create po/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('columnheader', { name: /unit cost/i })).toBeInTheDocument();
  });
});

describe('the detail dialog and the print preview', () => {
  const asPO = (value: unknown) => value as import('@/lib/api/inventory').PurchaseOrder;

  it('shows unit cost, extension, subtotal and total with See costs', () => {
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={asPO(hoisted.pos[0])} onReceive={vi.fn()} />,
      { ability: abilityOf(FINANCIAL) },
    );
    expect(screen.getByRole('columnheader', { name: /unit \$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /ext\./i })).toBeInTheDocument();
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('shows none of it without, and no dollar amount, on a PO the server sent with no cost keys', () => {
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={asPO(hoisted.costFree)} onReceive={vi.fn()} />,
      { ability: abilityOf() },
    );
    expect(screen.getByText('Run Capacitor')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /unit \$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /ext\./i })).not.toBeInTheDocument();
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('leaves the cost field out of the draft line editor without See costs', async () => {
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={asPO({ ...hoisted.costFree, status: 'draft', orderedAt: null })} onReceive={vi.fn()} />,
      { ability: abilityOf([{ action: 'update', subject: 'PurchaseOrder' }]) },
    );
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await screen.findByLabelText('Description');
    expect(screen.queryByLabelText('Unit cost')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /unit \$/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();
  });

  it('prints the cost columns and the totals with See costs, and neither without', () => {
    const withIt = renderWithProviders(
      <POPreviewDialog open onClose={vi.fn()} po={asPO(hoisted.pos[0])} />,
      { ability: abilityOf(FINANCIAL) },
    );
    expect(screen.getByRole('columnheader', { name: 'Unit Cost' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Line Total' })).toBeInTheDocument();
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    withIt.unmount();

    renderWithProviders(
      <POPreviewDialog open onClose={vi.fn()} po={asPO(hoisted.costFree)} />,
      { ability: abilityOf() },
    );
    expect(screen.getByText('Run Capacitor')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Unit Cost' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Line Total' })).not.toBeInTheDocument();
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
  });
});

describe('the staging pointer on a staged order follows who may open the Staging page', () => {
  const staged = { ...hoisted.pos[0], stagedAsJobStageId: 'stage-1' } as unknown as import('@/lib/api/inventory').PurchaseOrder;

  it('is offered to a person who holds View stock', () => {
    seedMySwitches({ view_stock: true });
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={staged} onReceive={vi.fn()} />, {
      ability: abilityOf([{ action: 'update', subject: 'PurchaseOrder' }]),
    });
    expect(screen.getByRole('link', { name: /open staging/i })).toHaveAttribute('href', '/inventory/staging');
  });

  it('is not offered when the Staging page is hidden from them, though the receive hint stays', () => {
    seedMySwitches({ view_stock: false });
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={staged} onReceive={vi.fn()} />, {
      ability: abilityOf([{ action: 'update', subject: 'PurchaseOrder' }]),
    });
    expect(screen.getByRole('button', { name: /received via staging/i })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /open staging/i })).not.toBeInTheDocument();
  });
});
