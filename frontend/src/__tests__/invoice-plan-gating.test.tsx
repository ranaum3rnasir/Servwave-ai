// SRVW-94 - a Scale module must not leak into, or degrade, a Pro-included one.
//
// Logistic Orders are inventory-module surface (minPlan SCALE); Invoices are not.
// DeleteInvoiceDialog lists an invoice's LOs on open, OUTSIDE App.tsx's
// <RequireFeature feature="inventory"> wrapper - so it called /api/logistic-orders
// for a PRO org. Once the router-level requireFeature('inventory') lands those calls
// 402, and handle402 keeps a GET 402 deliberately silent, so it would have failed
// quietly on every sub-SCALE org.
//
// InvoiceDetailPage's own LO tab was the other gated call site; the tab was retired
// (Logistic Orders stay reachable from Inventory and the Job Logistics tab), so its
// two cases were removed with it. The dialog is the remaining call site.
//
// The user is an ADMIN with `manage all` ON PURPOSE: CASL cannot express this gate
// (defineAbilityFor short-circuits every admin to a superuser), so an admin is
// exactly the case that used to slip through.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { DeleteInvoiceDialog } from '@/components/invoices/DeleteInvoiceDialog';
import { buildAbility } from '@/lib/ability';
import type { LogisticOrderListRow, LogisticOrderStatus } from '@/lib/api/logisticOrders';

const INVOICE_ID = 'inv-abc-001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: INVOICE_ID }),
    useNavigate: () => vi.fn(),
  };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// ─── Invoice fixture (mirrors invoice-detail-page.test.tsx) ───────────────────
const SCOPE = {
  id: 'scope-1',
  title: 'Demo & haul-away',
  body: 'Remove old unit.',
  flat_price: 250,
  is_taxable: true,
  internal_cost: 100,
};

const LINE = {
  id: 'line-1',
  sequence: 1,
  description: 'Compressor swap',
  quantity: 1,
  unit_price: 300,
  unit_cost: 200,
  is_taxable: true,
  line_total: 300,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
};

const BASE_INVOICE = {
  id: INVOICE_ID,
  invoice_number: 'I00001',
  status: 'DRAFT',
  subtotal: 550,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  tip: 0,
  deposit_credit: 0,
  total_amount: 550,
  amount_due: 550,
  public_token: null,
  sent_at: null,
  paid_at: null,
  due_date: null,
  voided_at: null,
  voided_reason: null,
  refunded_at: null,
  total_refunded: 0,
  refund_reason: null,
  refund_reason_category: null,
  line_items: [LINE],
  scopes: [SCOPE],
  net_collected: 0,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@doe.com',
    phone: '5551234567',
  },
  job: null,
  payments: [] as unknown[],
};

function mockInvoice(overrides: Partial<typeof BASE_INVOICE> = {}, loRows: unknown[] = []) {
  const invoice = { ...BASE_INVOICE, ...overrides };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/notes')) return { data: { notes: [] } };
    if (url.endsWith('/timeline')) return { data: { events: [] } };
    if (url.includes('/api/logistic-orders')) {
      return { data: { data: loRows, page: 1, limit: 50, total: loRows.length } };
    }
    if (url.includes('/api/invoices/')) return { data: { invoice } };
    return { data: [] };
  });
}

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
    anchors: { invoiceId: INVOICE_ID, invoiceNumber: 'I00001' },
    lineCount,
    createdBy: null,
    processedAt: status === 'PROCESSED' ? '2026-07-19T00:00:00.000Z' : null,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

/**
 * org_features is set EXPLICITLY on every fixture below, never omitted: useFeature
 * fails OPEN while it is undefined ("unknown is not denied", so a cached
 * pre-entitlements payload cannot grey out a paid org). Omitting it would make an
 * unentitled fixture look entitled and quietly void these assertions.
 */
function mockOrgFeatures(features: string[], plan: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_plan: plan,
        org_features: features,
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

const PRO_FEATURES = ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling', 'leads'];
const SCALE_FEATURES = [...PRO_FEATURES, 'inventory'];

const loCalls = () =>
  mockApi.get.mock.calls.filter(([url]) => String(url).includes('/api/logistic-orders'));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeleteInvoiceDialog - Logistic Order consequence list', () => {
  function renderDialog() {
    return renderWithProviders(
      <DeleteInvoiceDialog
        open
        onOpenChange={vi.fn()}
        invoiceId={INVOICE_ID}
        syncedLineCount={0}
        onSuccess={vi.fn()}
      />,
      { ability: adminAbility },
    );
  }

  it('fires no /api/logistic-orders request on a PRO org', async () => {
    mockOrgFeatures(PRO_FEATURES, 'PRO');
    mockInvoice({}, [loRow('LO-I00001-1', 'PROCESSED', 3)]);
    renderDialog();

    // Deleting the invoice stays fully available - only the LO warning disappears.
    expect(await screen.findByRole('heading', { name: /Delete Invoice/ })).toBeInTheDocument();
    expect(loCalls()).toEqual([]);
    expect(screen.queryByText('LO-I00001-1')).not.toBeInTheDocument();
  });

  // Sensitivity check for the case above.
  it("still lists the invoice's logistic orders on a SCALE org", async () => {
    mockOrgFeatures(SCALE_FEATURES, 'SCALE');
    mockInvoice({}, [loRow('LO-I00001-1', 'PROCESSED', 3)]);
    renderDialog();

    expect(await screen.findByText('LO-I00001-1')).toBeInTheDocument();
    expect(screen.getByText(/returns 3 items to stock/i)).toBeInTheDocument();
  });
});
