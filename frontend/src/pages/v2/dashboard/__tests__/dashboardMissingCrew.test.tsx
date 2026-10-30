/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.13 - Missing crew on the routed home page: the tile (a count and the booked visit that starts
 * soonest with nobody on it) and the Needs Attention item "N visits with no crew" that replaced the line per visit.
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
const ID = 'missing_crew';

const meta = (id: string, category: DashboardTileMeta['category'], link: string | null): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link });
const soonest = (over: Record<string, unknown> = {}) => ({
  id: 'job-1', kind: 'job', number: 'J-100', title: 'Customer One', starts_at: '2026-10-15T13:00:00.000Z', starts_label: 'Thu 9:00 AM', until: '3d', link: '/sent-job/1', ...over,
});
const answer = (link: string | null, data: Record<string, unknown>, tiles: DashboardTileMeta[] = [meta(ID, 'jobs', link)]): DashboardResponse => ({
  tiles,
  categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'each_record', label: 'Across your records' }],
  data: data as DashboardResponse['data'],
  generated_at: '2026-10-12T10:00:00.000Z',
});

/** Shows where the page has been sent. */
function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
}
const where = () => screen.getByTestId('where').textContent;

/** The page of a person whose saved layout holds these tiles (as a Dispatcher's default holds Missing crew). */
function open(body: DashboardResponse, shown: string[] = [ID]) {
  serveDashboard(body, shown.map((id) => ({ id, visible: true })));
  renderWithProviders(<><DashboardPage /><Where /></>, { ability: ADMIN });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Missing crew tile', () => {
  it('shows how many booked visits have no crew and the soonest one with its number, customer, start and time until it', async () => {
    open(answer('/sent-schedule', { [ID]: { count: 4, soonest: soonest() } }));
    const tile = (await screen.findByRole('heading', { name: /Missing crew/ })).closest('[data-slot="card"]') as HTMLElement;
    expect(within(tile).getByText('4')).toBeInTheDocument();
    expect(within(tile).getByText('J-100')).toBeInTheDocument();
    expect(within(tile).getByText('Customer One')).toBeInTheDocument();
    expect(within(tile).getByText('Thu 9:00 AM')).toBeInTheDocument();
    expect(within(tile).getByText('in 3d')).toBeInTheDocument();
  });

  it('names a walkthrough as one, by its lead number', async () => {
    open(answer('/sent-schedule', { [ID]: { count: 1, soonest: soonest({ kind: 'lead', number: 'L-200', link: '/sent-lead/2', until: '5h' }) } }));
    expect(await screen.findByText('L-200')).toBeInTheDocument();
    expect(screen.getByText('Walkthrough · Thu 9:00 AM')).toBeInTheDocument();
    expect(screen.getByText('in 5h')).toBeInTheDocument();
  });

  it('opens the soonest record at the address the server sent', async () => {
    open(answer('/sent-schedule', { [ID]: { count: 1, soonest: soonest() } }));
    fireEvent.click((await screen.findByText('Customer One')).closest('button')!);
    expect(where()).toBe('/sent-job/1');
  });

  it('sends "View all" to the address the server sent for the tile (the Schedule\'s filter, for a person with Access Schedule)', async () => {
    open(answer('/sent-schedule?filter=sent', { [ID]: { count: 2, soonest: soonest() } }));
    fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
    expect(where()).toBe('/sent-schedule?filter=sent');
  });

  it('offers no "View all" when the server sent no address for the tile (no Access Schedule), and the soonest record still opens', async () => {
    open(answer(null, { [ID]: { count: 1, soonest: soonest() } }));
    const row = await screen.findByText('Customer One');
    expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    fireEvent.click(row.closest('button')!);
    expect(where()).toBe('/sent-job/1');
  });

  it('says so in one plain line when every booked visit has a crew', async () => {
    open(answer('/sent-schedule', { [ID]: { count: 0, soonest: null } }));
    expect(await screen.findByText('Every booked visit has a crew')).toBeInTheDocument();
  });

  it('claims nothing before the first answer lands', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByRole('button', { name: /Customize home page/ });
    expect(screen.queryByText('Every booked visit has a crew')).not.toBeInTheDocument();
  });

  it('is offered by the picker under the Jobs category the server named, and added from there', async () => {
    serveDashboard(answer('/sent-schedule', { [ID]: { count: 0, soonest: null } }), []);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    const group = (await screen.findByText('Jobs', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Add Missing crew' }));
    expect(await screen.findByText('Every booked visit has a crew')).toBeInTheDocument();
  });
});

describe('the Needs Attention item for visits with no crew', () => {
  const item = { id: 'missing-crew', type: 'missing_crew', severity: 'warning', title: '3 visits with no crew', meta: 'J-100 starts Thu 9:00 AM', badge: '3d', link: '/sent-schedule?filter=sent' };
  const NEEDS = 'needs_attention';

  it('shows its title and its soonest-visit line, and opens the address the server sent', async () => {
    open(answer(null, { [NEEDS]: [item] }, [meta(NEEDS, 'each_record', null)]), [NEEDS]);
    expect(await screen.findByText('3 visits with no crew')).toBeInTheDocument();
    expect(screen.getByText('J-100 starts Thu 9:00 AM')).toBeInTheDocument();
    fireEvent.click(screen.getByText('3 visits with no crew').closest('button')!);
    expect(where()).toBe('/sent-schedule?filter=sent');
  });

  it('opens the soonest record when the server sent that instead (no Access Schedule)', async () => {
    open(answer(null, { [NEEDS]: [{ ...item, link: '/sent-job/1' }] }, [meta(NEEDS, 'each_record', null)]), [NEEDS]);
    fireEvent.click((await screen.findByText('3 visits with no crew')).closest('button')!);
    expect(where()).toBe('/sent-job/1');
  });
});
