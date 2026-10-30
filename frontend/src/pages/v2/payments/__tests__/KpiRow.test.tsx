import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PaymentsSummary } from '@/lib/api/paymentsPage';

import { KpiRow } from '../components/KpiRow';

const BASE: PaymentsSummary = {
  collected: 12480, fees: 374.4, net: 12105.6, refunds: 250, count: 18, fees_pending: 0,
  next_payout: { amount: 3210.5, in_transit: 1800, date: '2026-10-19', schedule_text: 'Weekly on Mondays', bank_label: 'Chase ending 4242' },
};

const WEEKLY_NOTE =
  'Estimated. This is money you collected online that is not in a payout yet, after fees and refunds. The date is the next weekly payout; bank holidays can move it. In transit is money already sent to your bank that has not arrived yet, usually 1 to 2 business days.';
const NO_DATE_NOTE =
  'Estimated. This is money you collected online that is not in a payout yet, after fees and refunds. In transit is money already sent to your bank that has not arrived yet, usually 1 to 2 business days.';

function show(next: Partial<PaymentsSummary['next_payout']> = {}, props: Partial<Parameters<typeof KpiRow>[0]> = {}) {
  return render(
    <KpiRow
      summary={{ ...BASE, next_payout: { ...BASE.next_payout, ...next } }}
      loading={false} error={false} refreshing={false} onRetry={vi.fn()}
      {...props}
    />,
  );
}

const tile = (label: string) => screen.getByText(label).closest('[data-slot="stat-card"]') as HTMLElement;

describe('Next payout tile', () => {
  it('shows the label, an Estimated pill, then the "?" in that order', () => {
    show();
    const card = tile('Next payout');
    const pill = within(card).getByText('Estimated');
    const help = within(card).getByRole('button', { name: 'More about Next payout' });
    expect(pill.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^More about/ })).toHaveLength(1);
  });

  it('keeps the "?" in the label row, not floating in a corner of the tile', () => {
    show();
    const help = screen.getByRole('button', { name: 'More about Next payout' });
    expect(help.closest('.absolute')).toBeNull();
    expect(screen.getByText('Next payout').parentElement).toContainElement(help);
  });

  it('keeps the "?" inside the label row without growing it: its tap area overlaps instead of adding width', () => {
    show();
    const label = screen.getByTestId('next-payout-label');
    const help = screen.getByRole('button', { name: 'More about Next payout' });
    expect(label).toContainElement(help);
    const holder = help.parentElement as HTMLElement;
    expect(holder.classList.contains('max-sm:-mx-3')).toBe(true);
    expect(holder.classList.contains('shrink-0')).toBe(true);
    expect(label.classList.contains('flex-wrap')).toBe(false);
  });

  it('reads the date as "Oct 19, Monday" and the last line as In transit', () => {
    show();
    expect(screen.getByText('Oct 19, Monday')).toBeInTheDocument();
    expect(screen.getByText('In transit $1,800.00')).toBeInTheDocument();
    expect(screen.getByText('$3,210.50')).toBeInTheDocument();
  });

  it('leaves the date line out when there is no date', () => {
    show({ date: null });
    expect(screen.queryByText(/Monday|Sunday|Tuesday|Wednesday|Thursday|Friday|Saturday/)).not.toBeInTheDocument();
    expect(screen.getByText('In transit $1,800.00')).toBeInTheDocument();
  });

  it.each([
    ['Weekly on Mondays', WEEKLY_NOTE],
    ['Weekly', WEEKLY_NOTE],
    ['Daily', WEEKLY_NOTE.replace('next weekly payout', 'next daily payout')],
    ['Monthly', WEEKLY_NOTE.replace('next weekly payout', 'next monthly payout')],
    ['Manual', NO_DATE_NOTE],
    [null, NO_DATE_NOTE],
  ])('opens the note for schedule %s with its own wording', async (schedule, note) => {
    show({ schedule_text: schedule });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More about Next payout' }));
    expect(await screen.findByText(note)).toBeInTheDocument();
  });

  it('drops the date sentence when the date is null', async () => {
    show({ date: null });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More about Next payout' }));
    expect(await screen.findByText(NO_DATE_NOTE)).toBeInTheDocument();
  });

  it('names no bank or processor in the note', async () => {
    show();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More about Next payout' }));
    expect(await screen.findByText(WEEKLY_NOTE)).not.toHaveTextContent(/Chase|stripe/i);
  });
});

describe('the other tiles', () => {
  it('keep their figures and notes, including both "still being confirmed" lines', () => {
    show({}, { summary: { ...BASE, fees_pending: 2 } });
    expect(screen.getByText('18 payments')).toBeInTheDocument();
    expect(screen.getByText('3.0% of collected')).toBeInTheDocument();
    expect(screen.getByText('Some fees are still being confirmed.')).toBeInTheDocument();
    expect(screen.getByText('Refunds $250.00')).toBeInTheDocument();
    expect(screen.getByText('2 payments not counted until fees are confirmed')).toBeInTheDocument();
  });
});

describe('loading and error', () => {
  it('draws four skeleton tiles while loading', () => {
    show({}, { summary: undefined, loading: true });
    expect(document.querySelectorAll('[data-slot="stat-card-group"] > div')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /More about/ })).not.toBeInTheDocument();
  });

  it('shows the totals error when there is nothing to show', () => {
    show({}, { summary: undefined, error: true });
    expect(screen.getByText('Couldn’t load these totals.')).toBeInTheDocument();
  });
});

describe('the tile row', () => {
  it('is a grid that fits as many 190px columns as there are, two on a phone, with a 16px gap above 640px', () => {
    show();
    const group = document.querySelector('[data-slot="stat-card-group"]') as HTMLElement;
    const classes = group.className.split(/\s+/);
    expect(classes).toContain('grid-cols-2');
    expect(classes).toContain('min-[641px]:grid-cols-[repeat(auto-fit,minmax(190px,1fr))]');
    expect(classes).toContain('min-[641px]:gap-4');
    expect(classes).not.toContain('xl:grid-cols-4');
  });
});
