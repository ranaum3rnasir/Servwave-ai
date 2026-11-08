// Purchasing Audit Verdict PR 2 (S2.3) — the printed PO is a complete document:
// "Deliver to" is the company address from Settings (with a hint when it is
// empty), the vendor block carries the contact person / phone / email / account
// number, "Notes to the vendor" prints the PO's notes, the buyer signature is
// PERSISTED through PATCH (image + name + time once signed, "Clear" unsigns),
// the vendor line is blank, and status labels come off the registry.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { POPreviewDialog } from '@/components/inventory/POPreviewDialog';
import type { PurchaseOrder } from '@/lib/api/inventory';
import { signatureImageDataUrl } from '@/lib/inventory/signatures';

const hoisted = vi.hoisted(() => ({
  org: {
    id: 'org-1',
    name: 'ServWave Test Co',
    address_line1: '12 Dock Street',
    address_line2: 'Suite 4',
    city: 'Brooklyn',
    state: 'NY',
    postal_code: '11201',
    phone: '7185550100',
    email: 'orders@servwave.test',
    logo_url: null as string | null,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    usePurchaseOrders: stable([]),
    useVendors: stable([
      {
        id: 'v1',
        name: 'Acme Supply',
        category: 'Hardware',
        status: 'active',
        contactPersonName: 'Rita Rep',
        contactPhone: '2125550199',
        contactEmail: 'rita@acme.test',
        accountNumber: 'ACCT-778',
      },
    ]),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const BASE: PurchaseOrder = {
  id: 'po-1',
  poNumber: 'PO-3102',
  vendor: 'Acme Supply',
  vendorId: 'v1',
  status: 'ordered',
  orderedAt: '2026-08-01T12:00:00Z',
  orderedBy: { id: 'u1', name: 'Test Admin' },
  expectedDate: '2026-08-10',
  receivedAt: null,
  leadTimeDays: null,
  notes: null,
  signatureData: null,
  signatureName: null,
  signatureAt: null,
  createdAt: '2026-07-30T09:00:00Z',
  jobNumber: 'J00042',
  customer: 'Jane Doe',
  site: '9 Elm St',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 10 }],
};

const ORG_ADDRESS = {
  address_line1: '12 Dock Street',
  address_line2: 'Suite 4',
  city: 'Brooklyn',
  state: 'NY',
  postal_code: '11201',
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(hoisted.org, ORG_ADDRESS);
  window.localStorage.clear();
});

describe('POPreviewDialog — the document (S2.3)', () => {
  it('"Deliver to" is the organization address from Settings; there is no Ship-to block', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={BASE} />);

    const deliverTo = screen.getByTestId('po-deliver-to');
    expect(within(deliverTo).getByText(/deliver to/i)).toBeInTheDocument();
    expect(within(deliverTo).getByText('12 Dock Street')).toBeInTheDocument();
    expect(within(deliverTo).getByText('Suite 4')).toBeInTheDocument();
    expect(within(deliverTo).getByText(/Brooklyn, NY 11201/)).toBeInTheDocument();
    expect(screen.queryByText(/ship to/i)).toBeNull();
    expect(screen.queryByText(/signs via/i)).toBeNull();
  });

  it('points at Settings when the organization has no address yet', () => {
    Object.assign(hoisted.org, {
      address_line1: null,
      address_line2: null,
      city: null,
      state: null,
      postal_code: null,
    });
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={BASE} />);

    const deliverTo = screen.getByTestId('po-deliver-to');
    expect(within(deliverTo).getByText(/set your company address in settings/i)).toBeInTheDocument();
  });

  it('prints the vendor contact block and the job reference', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={BASE} />);

    const vendor = screen.getByTestId('po-vendor-block');
    expect(within(vendor).getByText('Acme Supply')).toBeInTheDocument();
    expect(within(vendor).getByText('Rita Rep')).toBeInTheDocument();
    expect(within(vendor).getByText('rita@acme.test')).toBeInTheDocument();
    expect(within(vendor).getByText('ACCT-778')).toBeInTheDocument();
    expect(within(vendor).getByText(/\(212\) 555-0199/)).toBeInTheDocument();
    expect(screen.getByText(/For Job · J00042/)).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows created / ordered / expected dates', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={BASE} />);

    const meta = screen.getByTestId('po-meta');
    expect(within(meta).getByText(/^created$/i)).toBeInTheDocument();
    expect(within(meta).getByText(/^ordered$/i)).toBeInTheDocument();
    expect(within(meta).getByText(/^expected$/i)).toBeInTheDocument();
    expect(within(meta).getByText(/Jul 30, 2026/)).toBeInTheDocument();
    expect(within(meta).getByText(/Aug 1, 2026/)).toBeInTheDocument();
    expect(within(meta).getByText(/Aug 10, 2026/)).toBeInTheDocument();
  });

  it('a draft has no ordered date — the meta strip shows "—", never the created date', () => {
    renderWithProviders(
      <POPreviewDialog open onClose={vi.fn()} po={{ ...BASE, status: 'draft', orderedAt: null, orderedBy: null }} />,
    );
    const meta = screen.getByTestId('po-meta');
    const ordered = within(meta).getByText(/^ordered$/i).parentElement!;
    expect(ordered).toHaveTextContent('—');
  });

  it('renders "Notes to the vendor" from the PO notes, and omits the block when there are none', () => {
    const { unmount } = renderWithProviders(
      <POPreviewDialog open onClose={vi.fn()} po={{ ...BASE, notes: 'Deliver to the side dock.\nCall on arrival.' }} />,
    );
    expect(screen.getByText(/notes to the vendor/i)).toBeInTheDocument();
    expect(screen.getByText(/Deliver to the side dock\./)).toBeInTheDocument();
    unmount();

    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={{ ...BASE, notes: '   ' }} />);
    expect(screen.queryByText(/notes to the vendor/i)).toBeNull();
  });

  it('status labels come off the registry — an ordered PO reads "Ordered", a partial one "Partial"', () => {
    const { unmount } = renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={BASE} />);
    expect(screen.getByTestId('po-status-chip')).toHaveTextContent(/^Ordered$/);
    expect(screen.queryByText(/sent to vendor/i)).toBeNull();
    unmount();

    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={{ ...BASE, status: 'partial' }} />);
    expect(screen.getByTestId('po-status-chip')).toHaveTextContent(/^Partial$/);
    expect(screen.queryByText(/partially received/i)).toBeNull();
  });

  it('keeps a blank vendor signature / date line', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={BASE} />);
    expect(screen.getByText(/vendor signature/i)).toBeInTheDocument();
  });

  it('unsigned: the capture field is shown and signing PATCHes signatureData + signatureName', async () => {
    const signedAt = '2026-08-02T15:04:00Z';
    vi.mocked(api.patch).mockImplementation((_url: string, body: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          purchaseOrder: {
            ...BASE,
            signatureData: body.signatureData,
            signatureName: body.signatureName,
            signatureAt: signedAt,
          },
        },
      }),
    );

    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={BASE} />);

    // Capture field, pre-filled with the logged-in user.
    const nameInput = screen.getByLabelText(/type your full name to sign/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Test Admin');
    fireEvent.click(screen.getByRole('button', { name: /adopt & sign|^sign$/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [url, body] = vi.mocked(api.patch).mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/inventory/purchase-orders/po-1');
    expect(body.signatureName).toBe('Test Admin');
    expect(String(body.signatureData)).toMatch(/^data:image\/svg\+xml/);
    expect(body.signatureData).toBe(signatureImageDataUrl('Test Admin'));

    // Once the server answers, the document shows the persisted signature: image + name + time.
    const block = await screen.findByTestId('po-buyer-signature');
    expect(within(block).getByRole('img', { name: /buyer signature/i })).toHaveAttribute(
      'src',
      signatureImageDataUrl('Test Admin'),
    );
    expect(within(block).getByText('Test Admin')).toBeInTheDocument();
    expect(within(block).getByText(/Aug 2, 2026/)).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('signed: reopening shows the persisted signature with name and time; "Clear" PATCHes signatureData null', async () => {
    const signed: PurchaseOrder = {
      ...BASE,
      signatureData: signatureImageDataUrl('Pat Buyer'),
      signatureName: 'Pat Buyer',
      signatureAt: '2026-08-03T10:30:00Z',
    };
    vi.mocked(api.patch).mockResolvedValue({
      data: { purchaseOrder: { ...BASE, signatureData: null, signatureName: null, signatureAt: null } },
    });

    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={signed} />);

    const block = screen.getByTestId('po-buyer-signature');
    expect(within(block).getByRole('img', { name: /buyer signature/i })).toBeInTheDocument();
    expect(within(block).getByText('Pat Buyer')).toBeInTheDocument();
    expect(within(block).getByText(/Aug 3, 2026/)).toBeInTheDocument();
    // No capture field while signed.
    expect(screen.queryByLabelText(/type your full name to sign/i)).toBeNull();

    fireEvent.click(within(block).getByRole('button', { name: /clear/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [url, body] = vi.mocked(api.patch).mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/inventory/purchase-orders/po-1');
    expect(body).toEqual({ signatureData: null });

    // Back to the capture field.
    expect(await screen.findByLabelText(/type your full name to sign/i)).toBeInTheDocument();
  });
});

describe('signatureImageDataUrl', () => {
  it('renders the typed name into an SVG data URL, XML-escaped', () => {
    const url = signatureImageDataUrl('O\'Neil & <Sons>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const svg = decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length));
    expect(svg).toContain('<svg');
    expect(svg).toContain('O&apos;Neil &amp; &lt;Sons&gt;');
    expect(svg).not.toContain('<Sons>');
  });
});
