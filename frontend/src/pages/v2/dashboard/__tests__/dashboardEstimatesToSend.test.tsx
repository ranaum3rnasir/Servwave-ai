/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.18 - the Estimates still to send tile on the routed home page: a count and the draft estimates
 * that have waited longest, each row showing the estimate's number, its customer and its total and opening the estimate at
 * the address the server sent, "View all" only when the server sent the Estimates list's address, and one plain line when
 * nothing is waiting.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends. The
 * addresses in these answers are invented ones, so a page that sent anyone somewhere it knew would fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const ID = 'estimates_to_send';

const meta = (link: string | null): DashboardTileMeta => ({ id: ID, category: 'estimates', mode: 'scope', label: null, link });
const estimate = (n: number, total: number, title = `Customer ${n}`) => ({
  id: `est-${n}`, estimate_number: `E-${n}`, title, total, link: `/sent-estimate/${n}`,
});
const answer = (link: string | null, data: unknown): DashboardResponse => ({
  tiles: [meta(link)],
  categories: [{ id: 'estimates', label: 'Estimates' }],
  data: { [ID]: data } as DashboardResponse['data'],
  generated_at: '2026-10-12T10:00:00.000Z',
});

/** Shows where the page has been sent. */
function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
}
const where = () => screen.getByTestId('where').textContent;

/** The page of a person whose saved layout holds the tile (as a Technician's or a Sales person's default does). */
function open(body: DashboardResponse) {
  serveDashboard(body, [{ id: ID, visible: true }]);
  renderWithProviders(<><DashboardPage /><Where /></>, { ability: ADMIN });
}
const tileOf = async () => (await screen.findByRole('heading', { name: /Estimates still to send/ })).closest('[data-slot="card"]') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Estimates still to send tile', () => {
  it('shows how many drafts are waiting and one row per estimate the server sent, each with its number, customer and total', async () => {
    open(answer('/sent-estimates', { count: 7, estimates: [estimate(1, 1250), estimate(2, 80.5), estimate(3, 12)] }));
    const tile = await tileOf();
    expect(within(tile).getByText('7')).toBeInTheDocument();
    expect(within(tile).getByText('E-1')).toBeInTheDocument();
    expect(within(tile).getByText('Customer 1')).toBeInTheDocument();
    expect(within(tile).getByText('$1,250.00')).toBeInTheDocument();
    expect(within(tile).getByText('$80.50')).toBeInTheDocument();
    // The tile draws the rows it was sent and no wall: three rows, not seven.
    expect(within(tile).getAllByText(/^E-\d$/)).toHaveLength(3);
  });

  it('adds up nothing: a total is shown per estimate, never a sum across the rows', async () => {
    open(answer('/sent-estimates', { count: 2, estimates: [estimate(1, 100), estimate(2, 250)] }));
    const tile = await tileOf();
    expect(within(tile).queryByText('$350.00')).not.toBeInTheDocument();
  });

  it('opens a row on the estimate at the address the server sent', async () => {
    open(answer('/sent-estimates', { count: 2, estimates: [estimate(1, 10), estimate(2, 20)] }));
    fireEvent.click((await screen.findByText('Customer 2')).closest('button')!);
    expect(where()).toBe('/sent-estimate/2');
  });

  it('sends "View all" to the address the server sent for the tile', async () => {
    open(answer('/sent-estimates?status=sent', { count: 1, estimates: [estimate(1, 10)] }));
    fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
    expect(where()).toBe('/sent-estimates?status=sent');
  });

  it('offers no "View all" when the server sent no address for the tile, and the rows still open their estimates', async () => {
    open(answer(null, { count: 1, estimates: [estimate(1, 10)] }));
    const row = await screen.findByText('Customer 1');
    expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    fireEvent.click(row.closest('button')!);
    expect(where()).toBe('/sent-estimate/1');
  });

  it('says so in one plain line when no estimate is waiting, with no count and no rows', async () => {
    open(answer('/sent-estimates', { count: 0, estimates: [] }));
    expect(await screen.findByText('No estimates to send')).toBeInTheDocument();
    expect(within(await tileOf()).queryByText('0')).not.toBeInTheDocument();
  });

  it('keeps a long list to the rows it was sent, with the full count and "View all" for the rest', async () => {
    open(answer('/sent-estimates', { count: 23, estimates: [1, 2, 3, 4, 5].map((n) => estimate(n, n * 10)) }));
    const tile = await tileOf();
    expect(within(tile).getByText('23')).toBeInTheDocument();
    expect(within(tile).getAllByText(/^E-\d+$/)).toHaveLength(5);
    expect(within(tile).getByRole('button', { name: 'View all' })).toBeInTheDocument();
  });

  it('lets a long customer name shrink on a 360 px screen while the number and the total keep their room', async () => {
    const original = window.innerWidth;
    window.innerWidth = 360;
    try {
      open(answer('/sent-estimates', { count: 1, estimates: [estimate(1, 1234567.89, 'A Very Long Customer Name Incorporated Holdings Of The Region')] }));
      const row = (await screen.findByText('E-1')).closest('button') as HTMLElement;
      const name = within(row).getByText(/A Very Long Customer Name/);
      // The name is the one part that gives way: it truncates inside a shrinkable box, never pushing the row wider than the card.
      expect(name).toHaveClass('truncate');
      expect(name.parentElement).toHaveClass('min-w-0', 'flex-1');
      expect(within(row).getByText('E-1')).toHaveClass('shrink-0');
      expect(within(row).getByText('$1,234,567.89')).toHaveClass('shrink-0');
      expect(row).toHaveClass('w-full');
    } finally {
      window.innerWidth = original;
    }
  });

  it('claims nothing before the first answer lands', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByRole('button', { name: /Customize home page/ });
    expect(screen.queryByText('No estimates to send')).not.toBeInTheDocument();
  });

  it('is offered by the picker under the Estimates category the server named, and added from there', async () => {
    serveDashboard(answer('/sent-estimates', { count: 0, estimates: [] }), []);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    const group = (await screen.findByText('Estimates', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Add Estimates still to send' }));
    expect(await screen.findByText('No estimates to send')).toBeInTheDocument();
  });
});
