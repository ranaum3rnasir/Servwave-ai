import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import PaymentsPage from '../PaymentsPage';
import { AttentionCard } from '../components/AttentionCard';
import { attentionCalls, makeItem, serveAttention } from './attentionFixtures';
import { TabHarness, makeRow, mockApi } from './paymentsFixtures';

const OWNER = buildAbility(catalogToggle('Manage payout account').grants.map((g) => ({ action: g.action, subject: g.subject }) as never));

function Where() {
  const { search } = useLocation();
  return <div data-testid="where">{search}</div>;
}
const where = () => screen.getByTestId('where').textContent ?? '';
const card = () => screen.findByRole('region', { name: /Needs attention/ });

beforeEach(() => mockApi.get.mockReset());

describe('the failed payout line', () => {
  it('names the payout by its own reference when the item carries one', async () => {
    serveAttention({ open: [makeItem(4, 'failed_payout', { payout_reference: 'PO-7K2M9Q' })] });
    renderWithProviders(<AttentionCard />, { initialEntries: ['/payments'] });
    expect(await within(await card()).findByText('Payout PO-7K2M9Q · $104.00 · The bank account could not be credited')).toBeInTheDocument();
  });

  it('falls back to the date only when there is no reference', async () => {
    serveAttention({ open: [makeItem(4, 'failed_payout', { payout_reference: null })] });
    renderWithProviders(<AttentionCard />, { initialEntries: ['/payments'] });
    expect(await within(await card()).findByText('Payout of Oct 12 · $104.00 · The bank account could not be credited')).toBeInTheDocument();
  });
});

describe('Respond', () => {
  it('renders only when the item has a dispute to open', async () => {
    serveAttention({ open: [makeItem(3, 'dispute', { actions: ['respond'], dispute_id: null })] });
    renderWithProviders(<AttentionCard />, { initialEntries: ['/payments'] });
    const row = within(await card()).getByRole('listitem');
    expect(within(row).queryByRole('button', { name: 'Respond' })).not.toBeInTheDocument();
  });
});

describe('the payment drawer action slot', () => {
  it('asks for the drawer payment\'s items by payment_id, not by an invoice-number search', async () => {
    const mine = makeItem(1, 'failed_payment', { actions: ['mark_resolved'] });
    const other = makeItem(2, 'failed_payment', { actions: ['mark_resolved'], title: 'Other bank payment failed' });
    serveAttention({ open: [mine, other], rows: [makeRow(1), makeRow(2)] });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?tab=payments&payment=${mine.payment_id}`] });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('button', { name: 'Mark resolved' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: 'Mark resolved' })).toHaveLength(1);
    const asked = attentionCalls().filter((c) => c.payment_id === mine.payment_id);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c.q === undefined)).toBe(true);
  });

  it('shows no item action for a payment with no open item of its own', async () => {
    serveAttention({ open: [makeItem(2, 'failed_payment', { actions: ['mark_resolved'] })], rows: [makeRow(1), makeRow(2)] });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?tab=payments&payment=${makeRow(1).id}`] });
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Refund' });
    expect(within(dialog).queryByRole('button', { name: 'Mark resolved' })).not.toBeInTheDocument();
  });

  it('every button in the drawer footer is one height', async () => {
    const mine = makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] });
    serveAttention({ open: [mine], rows: [makeRow(1)] });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?tab=payments&payment=${mine.payment_id}`] });
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Contact customer' });
    const heights = ['Contact customer', 'Mark resolved', 'Refund', 'Close'].map((name) => {
      const classes = within(dialog).getByRole('button', { name }).className.split(/\s+/);
      return classes.filter((c) => /^(max-sm:|touch:)?(min-)?h-/.test(c)).filter((c) => !c.startsWith('max-sm:') && !c.startsWith('touch:')).sort().join(' ');
    });
    expect(new Set(heights).size).toBe(1);
  });
});

describe('Show all and Resolved items', () => {
  const stale = '/payments?tab=payouts&payout=po-1&payment=p-1&dispute=dp-1&type=dispute&page=3&q=abc&attView=resolved';
  it.each([['Show all 7', 'attView=open'], ['Resolved items (1)', 'attView=resolved']])('%s lands on the full list', async (name, view) => {
    const u = userEvent.setup();
    serveAttention({ open: Array.from({ length: 7 }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: [] })), resolved: [makeItem(50, 'failed_payment', { status: 'resolved' })] });
    renderWithProviders(<><AttentionCard /><Where /></>, { initialEntries: [stale] });
    await u.click(within(await card()).getByRole('button', { name }));
    const now = where();
    expect(now).toContain('tab=payments');
    expect(now).toContain('chip=attention');
    expect(now).toContain(view);
    for (const key of ['payout=', 'payment=', 'dispute=', 'type=', 'page=', 'q=']) expect(now).not.toContain(key);
  });
});

describe('a failed load', () => {
  it('shows a small error with Retry instead of nothing, and the card comes back on Retry', async () => {
    const u = userEvent.setup();
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: [] })], failFirst: 1 });
    renderWithProviders(<AttentionCard />, { initialEntries: ['/payments'] });
    expect(await screen.findByText('Couldn’t load what needs attention.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await card()).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t load what needs attention.')).not.toBeInTheDocument();
  });
});

describe('the Needs attention chip', () => {
  function servePage(n: number) {
    serveAttention({ open: Array.from({ length: n }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: [] })) });
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string, config?: unknown) => {
      if (url === '/api/organization/stripe/status') {
        return Promise.resolve({ data: { connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true } });
      }
      return (base as (...a: unknown[]) => unknown)(url, config);
    }) as never);
  }

  it('hides the top card while the table below already lists the same items', async () => {
    servePage(3);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments?tab=payments&chip=attention'], ability: OWNER });
    expect(await screen.findByRole('button', { name: 'Needs attention 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: /Needs attention/ })).not.toBeInTheDocument();
  });

  it('shows the card again with the chip off', async () => {
    servePage(3);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments?tab=payments'], ability: OWNER });
    expect(await card()).toBeInTheDocument();
  });
});

describe('the card header', () => {
  it('sits the title and Resolved items on one baseline', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: [] })], resolved: [makeItem(50, 'failed_payment', { status: 'resolved' })] });
    renderWithProviders(<AttentionCard />, { initialEntries: ['/payments'] });
    const region = await card();
    const header = within(region).getByRole('button', { name: /Resolved items/ }).closest('[data-slot="card-header"]') as HTMLElement;
    expect(header.className).toMatch(/items-baseline|items-center/);
    expect(header.className).not.toMatch(/items-start/);
    // The buttons' own padding is pulled back, so the title, the rows and Show all share one left edge.
    expect(within(region).getByRole('button', { name: /Resolved items/ }).className).toMatch(/-mr-3/);
  });
});

void waitFor;
