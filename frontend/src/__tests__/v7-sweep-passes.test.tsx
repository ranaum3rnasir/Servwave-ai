/**
 * V7-11b: fixes found by the phone and keyboard passes. Phone sizes are asserted as the classes that produce them (jsdom
 * has no layout); the behaviours (focus, Escape, a refused price) are asserted as they happen.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
import { useLineItemFields } from '@/components/jobs/items/useLineItemFields';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { buildAbility } from '@/lib/ability';
import ListsPage from '@/pages/v2/settings/ListsPage';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { installListsServer, row } from './listsFake';

vi.mock('@/lib/axios', () => ({ default: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('Lists row actions are 44px on a phone whatever the pointer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installListsServer(
      mockApi,
      { '/api/job-types': { rows: [row('a', 'Alpha', { sort_order: 0 }), row('b', 'Bravo', { sort_order: 1 })] }, '/api/lead-sources': { rows: [row('s1', 'Zed')] } },
      (_m, url) => (url === '/api/organization' ? { id: 'o1' } : {}),
    );
  });

  it('Rename, Move up, Move down and More carry the phone size; the menu items are 44px too', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: buildAbility([{ action: 'update', subject: 'Organization' }]) });
    const card = (await screen.findByRole('heading', { name: 'Job types' })).closest('[data-slot="card"]') as HTMLElement;
    await within(card).findByText('Alpha');
    for (const name of ['Rename Alpha', 'Move Alpha up', 'Move Alpha down', 'More actions for Alpha']) {
      expect(within(card).getByRole('button', { name }), name).toHaveClass('size-8', 'max-[640px]:size-11');
    }
    await user.click(within(card).getByRole('button', { name: 'More actions for Alpha' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toHaveClass('max-[640px]:min-h-11');
  });

  it('the end-of-list Move buttons are aria-disabled, not natively disabled (they stay in the Tab order)', async () => {
    renderWithProviders(<ListsPage />, { ability: buildAbility([{ action: 'update', subject: 'Organization' }]) });
    const card = (await screen.findByRole('heading', { name: 'Job types' })).closest('[data-slot="card"]') as HTMLElement;
    await within(card).findByText('Alpha');
    const up = within(card).getByRole('button', { name: 'Move Alpha up' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    expect(up).not.toBeDisabled();
  });

  it('the search box and the sort select are 44px on a phone', () => {
    expect(read('pages/v2/settings/lists/lists.css')).toMatch(/@media \(max-width: 640px\)\s*\{[\s\S]*?\.lc-tools-search input,\s*\.lc-tools-sort \[role='combobox'\]\s*\{\s*min-height:\s*44px/);
  });
});

describe('Record payment dialog', () => {
  const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <QueryClientProvider client={qc()}>
        <button type="button" onClick={() => setOpen(true)}>Record a payment</button>
        <RecordPaymentDialog open={open} onOpenChange={setOpen} invoiceId="inv-1" invoiceNumber="I00001" amountDue={900} onSuccess={vi.fn()} />
      </QueryClientProvider>
    );
  }

  it('gives focus back to the control that opened it after Escape', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Record a payment' });
    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('its footer buttons are 44px on a phone', async () => {
    render(<QueryClientProvider client={qc()}><RecordPaymentDialog open onOpenChange={vi.fn()} invoiceId="inv-1" invoiceNumber="I00001" amountDue={900} onSuccess={vi.fn()} /></QueryClientProvider>);
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('max-sm:h-11');
    expect(screen.getByRole('button', { name: 'Record Payment' })).toHaveClass('max-sm:h-11');
  });
});

describe('a refused line edit', () => {
  const line = { quantity: '1', unit_price: '100', unit_cost: null, discount_type: null, discount_value: null } as unknown as InvoiceLineItem;

  it('puts the price input back to the saved value when the server refuses the change', async () => {
    const refuse = vi.fn(() => Promise.reject(new Error('TOTAL_BELOW_PAID')));
    const { result } = renderHook(() => useLineItemFields(line, refuse));
    act(() => result.current.setPrice('5'));
    expect(result.current.price).toBe('5');
    act(() => result.current.commitPrice());
    expect(refuse).toHaveBeenCalledWith({ unit_price: 5 });
    await waitFor(() => expect(result.current.price).toBe('100'));
  });

  it('keeps the typed price while a change is accepted (the saved line arrives and re-syncs it)', async () => {
    const accept = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useLineItemFields(line, accept));
    act(() => result.current.setPrice('120'));
    act(() => result.current.commitPrice());
    await Promise.resolve();
    expect(result.current.price).toBe('120');
  });

  it('a caller that returns nothing behaves as before', () => {
    const plain = vi.fn();
    const { result } = renderHook(() => useLineItemFields(line, plain));
    act(() => result.current.setPrice('7'));
    act(() => result.current.commitPrice());
    expect(plain).toHaveBeenCalledWith({ unit_price: 7 });
    expect(result.current.price).toBe('7');
  });
});

describe('/invoices/new buttons', () => {
  it('Cancel and Save are 44px on a phone', () => {
    const src = read('pages/v2/invoices/StandaloneInvoiceFormPage.tsx');
    expect(src).toMatch(/variant="outline" className="max-sm:h-11" onClick=\{\(\) => navigate\(-1\)\}/);
    expect(src).toMatch(/<Button type="submit" className="max-sm:h-11" form="standalone-invoice-form"/);
  });
});
