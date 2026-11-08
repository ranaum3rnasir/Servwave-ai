// #401 — SendInvoiceDialog is a right-side sheet showing full invoice details
// (line items + totals) while keeping the editable To/CC email flow.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { SendInvoiceDialog } from '@/components/invoices/SendInvoiceDialog';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { buildAbility } from '@/lib/ability';
import type { Organization } from '@/lib/api/organization';

const mockApi = vi.mocked(api);

// Task 2.5 — the JIT accept-cards banner (StripePaymentsBanner) is mounted right after
// SheetHeader. Default org to undefined (banner's `!org` guard renders null) so every
// pre-existing test above stays unaffected; the banner-specific describe block below
// sets hoisted.org explicitly per test.
const ADMIN_ABILITY = buildAbility([{ action: 'update', subject: 'Organization' }]);
const ORG = { id: 'org-1', name: 'Acme HVAC', stripe_charges_enabled: false, platform_fee_bps: 50 } as Organization;

const hoisted = vi.hoisted(() => ({
  org: undefined as unknown as Organization,
  toast: vi.fn(),
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org }) };
});

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const LINE_ITEMS: InvoiceLineItem[] = [
  {
    id: 'li-2',
    sequence: 2,
    description: 'Condenser coil cleaning',
    quantity: 1,
    unit_price: '150.00',
    is_taxable: true,
    line_total: '150.00',
    discount_type: null,
    discount_value: null,
    discount_amount: '0',
    item_type: 'SERVICE',
    price_book_item_id: null,
  },
  {
    id: 'li-1',
    sequence: 1,
    description: 'AC compressor replacement',
    quantity: 2,
    unit_price: '425.00',
    is_taxable: true,
    line_total: '850.00',
    discount_type: null,
    discount_value: null,
    discount_amount: '0',
    item_type: 'MATERIAL',
    price_book_item_id: null,
  },
];

function baseProps(overrides: Partial<React.ComponentProps<typeof SendInvoiceDialog>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    invoiceId: 'inv-1',
    invoiceNumber: 'I00042',
    customerEmail: 'jane@customer.com',
    dueDate: '2026-07-15T00:00:00.000Z',
    totalAmount: 1000,
    amountDue: 600,
    lineItems: LINE_ITEMS,
    onSuccess: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { invoice: {} } });
  hoisted.org = undefined as unknown as Organization;
});

describe('SendInvoiceDialog (#401 right-side sheet with invoice details)', () => {
  it('shows every line item plus Total, Amount Due and Due Date', () => {
    renderWithProviders(<SendInvoiceDialog {...baseProps()} />);

    // Both line items with description, qty × unit price, and line total.
    expect(screen.getByText('AC compressor replacement')).toBeInTheDocument();
    expect(screen.getByText('2 × $425.00')).toBeInTheDocument();
    expect(screen.getByText('$850.00')).toBeInTheDocument();
    expect(screen.getByText('Condenser coil cleaning')).toBeInTheDocument();
    expect(screen.getByText('1 × $150.00')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();

    // Totals block.
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
    expect(screen.getByText('Amount Due')).toBeInTheDocument();
    expect(screen.getByText('$600.00')).toBeInTheDocument();
    expect(screen.getByText('Due Date')).toBeInTheDocument();
    // Rendered via toLocaleDateString — the exact day depends on the machine TZ.
    expect(screen.getByText(/Jul 1[45], 2026/)).toBeInTheDocument();
  });

  it('shows a "No line items" empty state when there are no items', () => {
    renderWithProviders(<SendInvoiceDialog {...baseProps({ lineItems: [] })} />);

    expect(screen.getByText('No line items')).toBeInTheDocument();
    // Totals still render.
    expect(screen.getByText('Amount Due')).toBeInTheDocument();
  });

  it('renders as a right-side sheet, not a centered max-w-md modal', () => {
    renderWithProviders(<SendInvoiceDialog {...baseProps()} />);

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('slide-in-from-right');
    expect(content.className).toContain('right-0');
    expect(content.className).not.toContain('max-w-md');
  });

  it('keeps the To field empty + Send disabled with no email on file, and enables Send after typing a valid email', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendInvoiceDialog {...baseProps({ customerEmail: '' })} />);

    const toInput = screen.getByLabelText('To');
    expect(toInput).toHaveValue('');
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send Invoice/ })).toBeDisabled();

    await user.type(toInput, 'a@b.com');
    expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send Invoice/ })).toBeEnabled();
  });

  it('POSTs /send with the typed recipient and closes on success', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <SendInvoiceDialog {...baseProps({ customerEmail: '', onOpenChange })} />
    );

    await user.type(screen.getByLabelText('To'), 'a@b.com');
    await user.click(screen.getByRole('button', { name: /Send Invoice/ }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/invoices/inv-1/send',
        expect.objectContaining({ to: 'a@b.com' })
      );
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('SendInvoiceDialog — customer contact redaction (#1997)', () => {
  it('customerEmail undefined (redacted): "To" is read-only with the neutral placeholder, no address, Send enabled', () => {
    renderWithProviders(<SendInvoiceDialog {...baseProps({ customerEmail: undefined })} />);

    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(to).toHaveValue('');
    expect(to).toHaveAttribute('readonly');
    expect(to).toHaveAttribute('placeholder', "Sent to the customer's saved email address");
    expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send Invoice/ })).toBeEnabled();
  });

  it('customerEmail undefined (redacted): posts with no `to` key, and the success toast names no address', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendInvoiceDialog {...baseProps({ customerEmail: undefined })} />);

    await user.click(screen.getByRole('button', { name: /Send Invoice/ }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect('to' in body).toBe(false);
    expect('cc_emails' in body).toBe(false);
    await waitFor(() => {
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'I00042 has been emailed to the customer.' }),
      );
    });
  });

  it('customerEmail undefined (redacted): CC input is disabled with a neutral hint instead of accepting an address', () => {
    renderWithProviders(<SendInvoiceDialog {...baseProps({ customerEmail: undefined })} />);

    const cc = screen.getByLabelText(/CC/) as HTMLInputElement;
    expect(cc).toBeDisabled();
    expect(cc).toHaveAttribute('placeholder', 'Not available for this customer');
  });

  it('customerEmail undefined (redacted) on the RESEND instance: same read-only placeholder, Send enabled, no `to` posted', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendInvoiceDialog {...baseProps({ customerEmail: undefined, isResend: true })} />);

    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(to).toHaveValue('');
    expect(to).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: /Resend Invoice/ })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Resend Invoice/ }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/invoices/inv-1/resend', expect.any(Object)));
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect('to' in body).toBe(false);
  });

  it('customerEmail null (genuinely no email on file): unchanged pre-existing behaviour — editable, empty, Send disabled', () => {
    renderWithProviders(<SendInvoiceDialog {...baseProps({ customerEmail: null })} />);

    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(to).toHaveValue('');
    expect(to).not.toHaveAttribute('readonly');
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send Invoice/ })).toBeDisabled();
  });
});

describe('SendInvoiceDialog — JIT accept-cards banner (Task 2.5)', () => {
  it('admin: shows the banner when card payments are not yet enabled, and Set up navigates to /settings/payments', async () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: false };
    const user = userEvent.setup();
    renderWithProviders(<SendInvoiceDialog {...baseProps()} />, { ability: ADMIN_ABILITY });

    expect(screen.getByText('Get paid faster — accept card payments.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    expect(mockNavigate).toHaveBeenCalledWith('/settings/payments');
  });

  it('non-admin: shows informational copy instead of a CTA the user can\'t act on', () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: false };
    renderWithProviders(<SendInvoiceDialog {...baseProps()} />);

    expect(screen.getByText('Card payments aren’t set up — ask your admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument();
  });

  it('renders no banner once card payments are already enabled', () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: true };
    renderWithProviders(<SendInvoiceDialog {...baseProps()} />, { ability: ADMIN_ABILITY });

    expect(screen.queryByText(/Get paid faster/)).not.toBeInTheDocument();
  });
});
