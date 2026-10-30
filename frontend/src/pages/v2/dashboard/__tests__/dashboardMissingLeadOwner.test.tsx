/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.11 - Missing lead owner on the routed home page: the tile (a count and the lead that has been
 * open longest with no Owner), the Needs Attention item "N leads with no owner" that replaced the unassigned-leads item,
 * and the "N with no owner" line under Open Leads.
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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const ID = 'missing_lead_owner';

const meta = (id: string, category: DashboardTileMeta['category'], link: string | null): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link });
const oldest = (age_days: number) => ({ id: 'lead-1', lead_number: 'L-100', title: 'Customer One', age_days, link: '/sent-lead/1' });
const answer = (link: string | null, data: Record<string, unknown>, tiles: DashboardTileMeta[] = [meta(ID, 'leads', link)]): DashboardResponse => ({
  tiles,
  categories: [{ id: 'leads', label: 'Leads' }, { id: 'each_record', label: 'Across your records' }],
  data: data as DashboardResponse['data'],
  generated_at: '2026-10-12T10:00:00.000Z',
});

/** Shows where the page has been sent. */
function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
}
const where = () => screen.getByTestId('where').textContent;

/** The page of a person whose saved layout holds these tiles (as a Dispatcher's default holds Missing lead owner). */
function open(body: DashboardResponse, shown: string[] = [ID]) {
  serveDashboard(body, shown.map((id) => ({ id, visible: true })));
  renderWithProviders(<><DashboardPage /><Where /></>, { ability: ADMIN });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Missing lead owner tile', () => {
  it('shows how many open leads have no owner and the oldest one with its number, customer and days open', async () => {
    open(answer('/sent-leads', { [ID]: { count: 4, oldest: oldest(9) } }));
    const tile = (await screen.findByRole('heading', { name: /Missing lead owner/ })).closest('[data-slot="card"]') as HTMLElement;
    expect(within(tile).getByText('4')).toBeInTheDocument();
    expect(within(tile).getByText('L-100')).toBeInTheDocument();
    expect(within(tile).getByText('Customer One')).toBeInTheDocument();
    expect(within(tile).getByText('9 days')).toBeInTheDocument();
  });

  it('opens the oldest lead at the address the server sent', async () => {
    open(answer('/sent-leads', { [ID]: { count: 1, oldest: oldest(1) } }));
    expect(await screen.findByText('1 day')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Customer One').closest('button')!);
    expect(where()).toBe('/sent-lead/1');
  });

  it('sends "View all" to the address the server sent for the tile', async () => {
    open(answer('/sent-leads?filter=sent', { [ID]: { count: 2, oldest: oldest(3) } }));
    fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
    expect(where()).toBe('/sent-leads?filter=sent');
  });

  it('offers no "View all" when the server sent no address for the tile, and the oldest lead still opens', async () => {
    open(answer(null, { [ID]: { count: 1, oldest: oldest(0) } }));
    const row = await screen.findByText('Customer One');
    expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    fireEvent.click(row.closest('button')!);
    expect(where()).toBe('/sent-lead/1');
  });

  it('says so in one plain line when every open lead has an owner', async () => {
    open(answer('/sent-leads', { [ID]: { count: 0, oldest: null } }));
    expect(await screen.findByText('No leads without an owner')).toBeInTheDocument();
  });

  it('claims nothing before the first answer lands', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByRole('button', { name: /Customize home page/ });
    expect(screen.queryByText('No leads without an owner')).not.toBeInTheDocument();
  });

  it('is offered by the picker under the Leads category the server named, and added from there', async () => {
    serveDashboard(answer('/sent-leads', { [ID]: { count: 0, oldest: null } }), []);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    const group = (await screen.findByText('Leads', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Add Missing lead owner' }));
    expect(await screen.findByText('No leads without an owner')).toBeInTheDocument();
  });
});

describe('the line under Open Leads', () => {
  it('reads "N with no owner", and never says unassigned', async () => {
    const OPEN = 'kpi.open_leads';
    open(answer('/sent-leads', { [OPEN]: { count: 12, no_owner: 3 } }, [meta(OPEN, 'leads', '/sent-leads')]), [OPEN]);
    expect(await screen.findByText('3 with no owner')).toBeInTheDocument();
    expect(screen.queryByText(/unassigned/i)).not.toBeInTheDocument();
  });
});

describe('the Needs Attention item for leads with no owner', () => {
  const item = { id: 'missing-lead-owner', type: 'missing_lead_owner', severity: 'info', title: '3 leads with no owner', meta: 'Oldest: Customer One · 9 days open', badge: '3', link: '/sent-leads?filter=sent' };

  it('shows its title and its oldest-lead line, and opens the address the server sent', async () => {
    const NEEDS = 'needs_attention';
    open(answer(null, { [NEEDS]: [item] }, [meta(NEEDS, 'each_record', null)]), [NEEDS]);
    expect(await screen.findByText('3 leads with no owner')).toBeInTheDocument();
    expect(screen.getByText('Oldest: Customer One · 9 days open')).toBeInTheDocument();
    fireEvent.click(screen.getByText('3 leads with no owner').closest('button')!);
    expect(where()).toBe('/sent-leads?filter=sent');
  });
});
