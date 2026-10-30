// V7-11b: small fixes found by the phone and desktop passes: one alert sentence once, the "Meant for" link kept on its
// line, the toolbar's three controls at one height, the customer ID in the link colour, the Next payout value in line,
// the Attach list's amount kept clear of a long name.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { NewTabLink } from '@/components/ui/new-tab-link';
import type { PaymentsSummary } from '@/lib/api/paymentsPage';
import { RadioRow } from '@/pages/v2/_shared/radioRow';

import { KpiRow } from '../components/KpiRow';
import { PaymentsToolbar } from '../components/PaymentsToolbar';
import { TabHarness, mockApi } from './paymentsFixtures';
import { PAYMENT_KEY, makeUnapplied, serveUnapplied } from './unappliedFixtures';

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.post.mockReset();
});

describe('the unapplied alert', () => {
  it('says a reason once when the short and the long text are the same sentence', async () => {
    serveUnapplied({
      unapplied: makeUnapplied({
        meant_for: { invoice: null }, reason_short: 'Payment is not tied to an invoice', reason_long: 'Payment is not tied to an invoice.',
      }),
    });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=item:${PAYMENT_KEY}`] });
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const lead = await within(dialog).findByText('Payment is not tied to an invoice.', { selector: 'b' });
    expect(lead.parentElement!.textContent!.trim()).toBe('Payment is not tied to an invoice.');
  });

  it('keeps the "Meant for" link on one line with its new-tab icon', async () => {
    serveUnapplied();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=item:${PAYMENT_KEY}`] });
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const link = await within(dialog).findByRole('link', { name: /INV-1301/ });
    expect(link).toHaveClass('inline-flex', 'whitespace-nowrap', 'shrink-0');
  });
});

describe('the Payments toolbar', () => {
  it('draws Filter and Export at the search box height (40px), 44px on a phone', () => {
    renderWithProviders(
      <PaymentsToolbar
        chip="all" onChip={vi.fn()} disputedCount={0} attentionCount={0} searchValue="" onSearchValue={vi.fn()}
        onSearchSettled={vi.fn()} filters={{}} onFilters={vi.fn()} onExport={vi.fn()} exporting={false}
      />,
    );
    for (const name of [/^Filter/, 'Export']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveClass('h-10');
      expect(button).toHaveClass('max-sm:h-11');
    }
  });
});

describe('the customer ID link', () => {
  it('is in the brand link colour, like the invoice link beside it', () => {
    render(<NewTabLink variant="customer-id" href="/customers/c1">C-1001</NewTabLink>);
    expect(screen.getByRole('link', { name: /C-1001/ })).toHaveClass('text-brand-emphasis');
  });
});

describe('the Next payout tile', () => {
  it('holds its label row to the height of the other tiles on desktop so the four values line up', () => {
    const summary: PaymentsSummary = {
      collected: 1, fees: 0, net: 1, refunds: 0, count: 1, fees_pending: 0,
      next_payout: { amount: 5, in_transit: 0, date: null, schedule_text: null, bank_label: null },
    };
    render(<KpiRow summary={summary} loading={false} error={false} refreshing={false} onRetry={vi.fn()} />);
    expect(screen.getByTestId('next-payout-label')).toHaveClass('min-[641px]:h-[18.75px]');
  });
});

describe('a radio row with a long name and an amount', () => {
  it('lets the name and the description shrink inside the row so the amount stays clear', () => {
    render(<RadioRow checked={false} onClick={vi.fn()} label="INV-1301 · A very long customer name" description="Door repair" trailing="$120.00" />);
    expect(screen.getByText('INV-1301 · A very long customer name')).toHaveClass('max-w-full', 'truncate');
    expect(screen.getByText('Door repair')).toHaveClass('max-w-full', 'truncate');
    expect(screen.getByText('$120.00')).toHaveClass('shrink-0');
  });
});
