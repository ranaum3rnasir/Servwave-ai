/**
 * Mobile slice 37 spot-check: money and quantity fields became text inputs with the decimal
 * keypad, and the amount saved for the same typed input is unchanged.
 *
 * Three live screens, each through its real save path:
 *   - Record payment (invoice): the POSTed `amount`.
 *   - A job line item's inline Quantity and Selling price: the `onUpdate` patch.
 *   - Settings > Payments & Lists, default deposit percentage and fixed amount: the PATCHed org.
 *
 * Each field is also asserted to be a text input with the decimal keypad (it was a number input
 * before this slice, which is what makes these tests red on the old code). Thousands commas,
 * which a number input refused, are read as thousands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import type { InvoiceLineItem } from '@/lib/api/jobs';

let registeredSave: (() => Promise<void> | void) | null = null;
vi.mock('@/pages/v2/settings/settingsBar', async (orig) => ({
  ...(await orig<typeof import('@/pages/v2/settings/settingsBar')>()),
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void }) => {
      registeredSave = fns.save;
    },
  }),
}));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div />,
}));

// Imported after the mocks above so the page picks up the captured saver.
const { default: PaymentsListsPage } = await import('@/pages/v2/settings/PaymentsListsPage');

const mockApi = vi.mocked(api);

/** A money or quantity field: text, decimal keypad, nothing a number input would carry. */
function expectDecimalField(el: HTMLElement) {
  expect(el).toHaveAttribute('type', 'text');
  expect(el).toHaveAttribute('inputmode', 'decimal');
  for (const a of ['min', 'max', 'step']) expect(el.hasAttribute(a), a).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredSave = null;
  mockApi.post.mockResolvedValue({ data: {} });
  mockApi.patch.mockResolvedValue({ data: {} });
});

describe('Record payment: the POSTed amount (mobile slice 37)', () => {
  const renderDialog = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <RecordPaymentDialog open onOpenChange={vi.fn()} invoiceId="inv-1" invoiceNumber="I00001" amountDue={5000} onSuccess={vi.fn()} />
      </QueryClientProvider>,
    );
  };

  it.each([
    ['250', 250],
    ['12.05', 12.05],
    ['0.5', 0.5],
    ['1,250.50', 1250.5],
  ])('typed %s saves %s', async (typed, saved) => {
    const user = userEvent.setup();
    renderDialog();
    const amount = await screen.findByLabelText(/amount/i);
    expectDecimalField(amount);
    await user.tripleClick(amount);
    await user.keyboard(typed);
    await user.click(screen.getByRole('button', { name: /record payment/i }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ amount: saved })));
  });
});

describe('Job line item: the inline Quantity and Selling price patch (mobile slice 37)', () => {
  const LINE: InvoiceLineItem = {
    id: 'line-s37',
    sequence: 1,
    description: 'Compressor swap',
    quantity: 2,
    unit_price: 150,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 300,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
  };

  const renderRow = (onUpdate = vi.fn()) => {
    renderWithProviders(
      <DndContext>
        <table>
          <tbody>
            <SortableContext items={[LINE.id]}>
              <LineItemRow line={LINE} canEdit canManage canSeePricing onUpdate={onUpdate} onDelete={vi.fn()} onEdit={vi.fn()} />
            </SortableContext>
          </tbody>
        </table>
      </DndContext>,
    );
    return onUpdate;
  };

  it.each([
    ['12.05', 12.05],
    ['99', 99],
    ['1,250.5', 1250.5],
  ])('Selling price typed %s saves %s', async (typed, saved) => {
    const user = userEvent.setup();
    const onUpdate = renderRow();
    const price = screen.getByLabelText('Selling price for Compressor swap');
    expectDecimalField(price);
    await user.clear(price);
    await user.type(price, `${typed}{Enter}`);
    expect(onUpdate).toHaveBeenCalledWith({ unit_price: saved });
  });

  it.each([
    ['1.5', 1.5],
    ['3', 3],
  ])('Quantity typed %s saves %s', async (typed, saved) => {
    const user = userEvent.setup();
    const onUpdate = renderRow();
    const qty = screen.getByLabelText('Quantity for Compressor swap');
    expectDecimalField(qty);
    await user.clear(qty);
    await user.type(qty, `${typed}{Enter}`);
    expect(onUpdate).toHaveBeenCalledWith({ quantity: saved });
  });
});

describe('Payments & Lists: the default deposit saved on the org (mobile slice 37)', () => {
  const ORG = {
    id: 'o1',
    stripe_connected: false,
    accepted_payment_methods: ['CASH'],
    source_options: [],
    job_type_options: [],
    deposit_default_type: 'PERCENTAGE',
    deposit_default_percentage: 40,
    deposit_default_fixed_amount: 0,
  };

  beforeEach(() => {
    mockApi.get.mockImplementation((url: string) => (url === '/api/organization' ? Promise.resolve({ data: ORG }) : Promise.resolve({ data: {} })));
  });

  it.each([
    ['37.5', 37.5],
    ['25', 25],
  ])('percentage typed %s saves %s', async (typed, saved) => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentsListsPage />);
    const pct = await screen.findByDisplayValue('40');
    expectDecimalField(pct);
    await user.tripleClick(pct);
    await user.keyboard(typed);
    await registeredSave?.();
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/organization', expect.objectContaining({ deposit_default_percentage: saved })));
  });

  it.each([
    ['150.25', 150.25],
    ['1,500', 1500],
  ])('fixed amount typed %s saves %s', async (typed, saved) => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentsListsPage />);
    await screen.findByDisplayValue('40');
    await user.click(screen.getByRole('radio', { name: 'Fixed amount' }));
    const fixed = document.querySelector<HTMLInputElement>('#deposit-fixed')!;
    expectDecimalField(fixed);
    await user.tripleClick(fixed);
    await user.keyboard(typed);
    await registeredSave?.();
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/organization', expect.objectContaining({ deposit_default_fixed_amount: saved })));
  });
});
