/**
 * Roles & Permissions S07.19 - the Vendors page follows its switches and See costs.
 *
 * Rendered through the routed page (`/inventory/vendors`), with the data hooks seam-mocked to stable answers (see
 * vendorSpendBulkExport.test.tsx for why). The person's rules are built from the switches under test:
 *   - Create / Edit / Delete vendors: Add Vendor, the detail dialog's Edit and Archive, and Delete;
 *   - See costs (`read Pricing`): the account number (card, detail, form, search) and every spend figure;
 *   - View purchase orders: the orders the spend is summed from;
 *   - Export vendors: the spend file's buttons and the checkboxes that exist for Export selected.
 * Money the person may not see is absent, never a $0 and never a dash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  const ACME_ID = 'e0000001-0000-0000-0000-000000000001';
  return {
    ACME_ID,
    vendors: [
      {
        id: ACME_ID, name: 'Acme Supply', category: 'HVAC', contactPersonName: 'Dana Rep', status: 'active' as const,
        accountNumber: 'ACCT-4471',
      },
    ],
    pos: [
      {
        id: 'f0000001-0000-0000-0000-000000000001', poNumber: 'PO-3201', vendor: 'Acme Supply', vendorId: ACME_ID,
        status: 'received' as const, orderedAt: new Date().toISOString(), orderedBy: null, receivedAt: null, leadTimeDays: null,
        notes: null, signatureData: null, signatureName: null, signatureAt: null, createdAt: new Date().toISOString(),
        lines: [{ id: 'l1', itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 10, qtyReceived: 0, unitCost: 12 }],
      },
    ],
    items: [],
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
    // What the page asked each list hook for: the argument that switches the request on.
    poEnabled: [] as boolean[],
  };
});

vi.mock('@/lib/inventory/csv', () => ({ toCSV: hoisted.toCSV, downloadCSV: hoisted.downloadCSV }));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  type Api = typeof import('@/lib/api/inventory');
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useVendors: stable(hoisted.vendors as unknown as ReturnType<Api['useVendors']>['data']),
    // A list the person may not read is not requested: the hook returns nothing when it is switched off.
    usePurchaseOrders: (enabled = true) => {
      hoisted.poEnabled.push(enabled);
      return { data: enabled ? hoisted.pos : undefined, isLoading: false, isError: false };
    },
    useInventoryItems: stable(hoisted.items as unknown as ReturnType<Api['useInventoryItems']>['data']),
    useUpsertVendor: mutation,
    useDeleteVendor: mutation,
  };
});

const { VendorsPage } = await import('../VendorsPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.poEnabled.length = 0;
});

const READ_ONLY: AbilityRule[] = [{ action: 'read', subject: 'Vendor' }];
// See costs needs See prices.
const FINANCIAL: AbilityRule[] = [{ action: 'read', subject: 'Prices' }, { action: 'read', subject: 'Pricing' }];
// Create vendors needs Edit vendors.
const CREATE_VENDORS: AbilityRule[] = [{ action: 'update', subject: 'Vendor' }, { action: 'create', subject: 'Vendor' }];
const READ_POS: AbilityRule[] = [{ action: 'read', subject: 'PurchaseOrder' }];

function renderVendors(...rules: AbilityRule[][]) {
  return renderWithProviders(<VendorsPage />, {
    initialEntries: ['/inventory/vendors'],
    ability: buildAbility([...READ_ONLY, ...rules.flat()]),
  });
}

describe('the account number follows See costs', () => {
  it('is on the card and found by search with it', async () => {
    renderVendors(FINANCIAL);
    const card = (await screen.findByText('Acme Supply')).closest('button')!;
    expect(within(card).getByText('Account #')).toBeInTheDocument();
    expect(within(card).getByText('ACCT-4471')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Search vendors…'), 'ACCT-4471');
    expect(screen.getByText('Acme Supply')).toBeInTheDocument();
  });

  it('is nowhere on the card without it, and a search for it finds nothing', async () => {
    // The number is on the vendor the page holds (a stale answer, a cache): the page must not draw it or match on it.
    renderVendors();
    const card = (await screen.findByText('Acme Supply')).closest('button')!;
    expect(within(card).queryByText('Account #')).not.toBeInTheDocument();
    expect(screen.queryByText('ACCT-4471')).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Search vendors…'), 'ACCT-4471');
    expect(screen.queryByText('Acme Supply')).not.toBeInTheDocument();
    expect(screen.getByText('No vendors match your filters.')).toBeInTheDocument();
  });

  it('is in the detail dialog and the Add Vendor form with it, and in neither without it', async () => {
    const withIt = renderVendors(FINANCIAL, CREATE_VENDORS);
    await userEvent.click((await screen.findByText('Acme Supply')).closest('button')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Account')).toBeInTheDocument();
    expect(within(dialog).getByText(/acct ACCT-4471/)).toBeInTheDocument();
    withIt.unmount();

    renderVendors(CREATE_VENDORS);
    await userEvent.click((await screen.findByText('Acme Supply')).closest('button')!);
    const without = await screen.findByRole('dialog');
    expect(within(without).queryByText('Account')).not.toBeInTheDocument();
    expect(within(without).queryByText(/acct /)).not.toBeInTheDocument();
    expect(within(without).queryByText(/ACCT-4471/)).not.toBeInTheDocument();
  });

  it('has an Account Number field on the Add Vendor form only with See costs', async () => {
    const withIt = renderVendors(FINANCIAL, CREATE_VENDORS);
    await userEvent.click(await screen.findByRole('button', { name: /add vendor/i }));
    expect(await screen.findByPlaceholderText('Your account # with this vendor')).toBeInTheDocument();
    withIt.unmount();

    renderVendors(CREATE_VENDORS);
    await userEvent.click(await screen.findByRole('button', { name: /add vendor/i }));
    await screen.findByRole('dialog');
    expect(screen.queryByPlaceholderText('Your account # with this vendor')).not.toBeInTheDocument();
    expect(screen.queryByText('Account Number')).not.toBeInTheDocument();
  });
});

describe('vendor spend follows See costs and View purchase orders', () => {
  it('draws the spend tile, the card strip, the category total and the analytics tab with both', async () => {
    renderVendors(FINANCIAL, READ_POS);
    expect(await screen.findByText('Total Spend YTD')).toBeInTheDocument();
    const card = screen.getByText('Acme Supply').closest('button')!;
    expect(within(card).getByText('YTD Spend')).toBeInTheDocument();
    expect(within(card).getByText('$120')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Spend Analytics/ })).toBeInTheDocument();
  });

  it('draws none of it without See costs: no tile, no strip, no tab, no dollar amount', async () => {
    const { container } = renderVendors(READ_POS);
    const card = (await screen.findByText('Acme Supply')).closest('button')!;
    expect(screen.queryByText('Total Spend YTD')).not.toBeInTheDocument();
    expect(within(card).queryByText('YTD Spend')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Spend Analytics/ })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  it('draws none of it without View purchase orders either, and never asks for the orders', async () => {
    const { container } = renderVendors(FINANCIAL);
    await screen.findByText('Acme Supply');
    expect(screen.queryByText('Total Spend YTD')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Spend Analytics/ })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\d/);
    // The purchase-order list is switched off: no refused request goes out.
    expect(hoisted.poEnabled.length).toBeGreaterThan(0);
    expect(hoisted.poEnabled.every((enabled) => enabled === false)).toBe(true);
  });

  it('shows the vendor detail with no spend tiles, no recent-order totals and no "No POs yet" without them', async () => {
    renderVendors(READ_POS);
    await userEvent.click((await screen.findByText('Acme Supply')).closest('button')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('YTD Spend')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/No POs yet/)).not.toBeInTheDocument();
    // The orders list itself needs only View purchase orders; its Total column needs See costs.
    expect(within(dialog).getByText('Recent purchase orders')).toBeInTheDocument();
    expect(within(dialog).queryByRole('columnheader', { name: 'Total' })).not.toBeInTheDocument();
  });
});

describe('Export vendors gates the spend file', () => {
  async function openAnalytics(...rules: AbilityRule[][]) {
    renderVendors(FINANCIAL, READ_POS, ...rules);
    await userEvent.click(await screen.findByRole('tab', { name: /Spend Analytics/ }));
    await screen.findByText('Spend leaderboard · YTD');
  }

  it('offers the Export button and row checkboxes with it, and the file is the spend', async () => {
    await openAnalytics([{ action: 'export', subject: 'Vendor' }]);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    expect(hoisted.downloadCSV).toHaveBeenCalled();
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ Vendor: 'Acme Supply', 'YTD Spend': 120 });
    expect(screen.getByRole('checkbox', { name: /select acme supply/i })).toBeInTheDocument();
  });

  it('offers neither without it', async () => {
    await openAnalytics();
    expect(screen.queryByRole('button', { name: /^export$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /select/i })).not.toBeInTheDocument();
  });
});

describe('Create, Edit and Delete vendors draw one set of controls each', () => {
  it('shows Add Vendor and Add category only with Create vendors', async () => {
    const withIt = renderVendors(CREATE_VENDORS);
    expect(await screen.findByRole('button', { name: /add vendor/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add category/i })).toBeInTheDocument();
    withIt.unmount();

    renderVendors([{ action: 'update', subject: 'Vendor' }, { action: 'delete', subject: 'Vendor' }]);
    await screen.findByText('Acme Supply');
    expect(screen.queryByRole('button', { name: /add vendor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add category/i })).not.toBeInTheDocument();
  });

  it('shows Edit and Archive only with Edit vendors, and Delete only with Delete vendors', async () => {
    const edit = renderVendors([{ action: 'update', subject: 'Vendor' }]);
    await userEvent.click((await screen.findByText('Acme Supply')).closest('button')!);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /archive/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    edit.unmount();

    renderVendors([{ action: 'delete', subject: 'Vendor' }]);
    await userEvent.click((await screen.findByText('Acme Supply')).closest('button')!);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });
});
