/**
 * Roles & Permissions, PRD 4, slice S04.3 - the Leads page's tiles follow each Leads scope.
 * Rendered through the routed page over a mocked HTTP layer: the five tiles show for a person who can only
 * read leads, each carries the count the server worked out for that person's reach, and the "No owner" card
 * and the Owner filter's "No owner" choice ask the server for exactly the same leads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import LeadsPage from '../LeadsPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001', first_name: 'John', last_name: 'Doe', company_name: null,
  phone: '5551234567', customer_number: 'C-1', ad_source: null,
};
const LEAD_ROW = {
  id: 'e0000000-0000-0000-0000-000000000001', lead_number: 'L00001', status: 'NEW', service_request: 'AC not cooling',
  job_type: null, service_city: 'Austin', service_state: 'TX', walkthrough_scheduled_at: null,
  walkthrough_completed_at: null, contacted_at: null, service_location_id: null,
  created_at: '2026-08-24T22:00:00.000Z', customer: CUSTOMER, commission_owner: null, lead_assignees: [], estimates: [],
};

const mockApi = vi.mocked(api);
const leadCalls = () => mockApi.get.mock.calls.filter(([url]) => url === '/api/leads');
const lastLeadParams = () => (leadCalls().at(-1)![1] as { params: Record<string, unknown> }).params;

/** A person who can open leads and nothing else: no create, no edit. */
const readerOnly = () => buildAbility([{ action: 'read', subject: 'Lead' }]);

function serveStats(stats: { total: number; new_this_week: number; no_owner: number; won: number; lost: number }) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/leads') {
      return { data: { leads: [LEAD_ROW], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 }, stats } };
    }
    if (url === '/api/users/assignable') return { data: [] };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

// The tile, not an applied-filter chip that carries the same words.
const tile = (label: string) =>
  screen.getAllByText(label)
    .map((el) => el.closest('button'))
    .find((button) => button?.querySelector('[data-slot="stat-card-value"]'))!;

describe('Leads page tiles for a person whose reach is narrower than the whole organisation', () => {
  // Each person's server answer is for their own reach; the page shows it as it is.
  const REACHES = [
    { reach: 'Location', stats: { total: 14, new_this_week: 3, no_owner: 4, won: 5, lost: 2 } },
    { reach: 'Team', stats: { total: 9, new_this_week: 1, no_owner: 2, won: 3, lost: 1 } },
    { reach: 'Attached', stats: { total: 6, new_this_week: 2, no_owner: 1, won: 2, lost: 0 } },
  ];

  for (const { reach, stats } of REACHES) {
    it(`shows Total, Won, Lost, New This Week and No owner with that reach's counts (${reach})`, async () => {
      serveStats(stats);
      renderWithProviders(<LeadsPage />, { ability: readerOnly() });
      await screen.findByText('AC not cooling');

      expect(within(tile('Total Leads')).getByText(String(stats.total))).toBeInTheDocument();
      expect(within(tile('Won')).getByText(String(stats.won))).toBeInTheDocument();
      expect(within(tile('Lost')).getByText(String(stats.lost))).toBeInTheDocument();
      expect(within(tile('New This Week')).getByText(String(stats.new_this_week))).toBeInTheDocument();
      expect(within(tile('No owner')).getByText(String(stats.no_owner))).toBeInTheDocument();
      // Nothing about this person's reach hides a tile or brings back the old name.
      expect(document.body.textContent ?? '').not.toMatch(/unassigned/i);
    });
  }
});

describe('Leads page - the No owner card and the Owner filter ask for the same leads', () => {
  it('sends the same request whether the card is clicked or the filter choice is ticked', async () => {
    const user = userEvent.setup();
    serveStats({ total: 3, new_this_week: 0, no_owner: 2, won: 0, lost: 0 });
    renderWithProviders(<LeadsPage />, { ability: readerOnly() });
    await screen.findByText('AC not cooling');

    await user.click(tile('No owner'));
    await vi.waitFor(() => expect(String(lastLeadParams().assigned_to)).toBe('NO_OWNER'));
    const fromCard = { ...lastLeadParams() };

    // Back to the whole list, then the same question through the filter.
    await user.click(tile('Total Leads'));
    await vi.waitFor(() => expect(lastLeadParams().assigned_to).toBeUndefined());
    await user.click(screen.getByRole('button', { name: /^filter$/i }));
    await user.click(await screen.findByRole('tab', { name: 'Owner' }));
    await user.click(await screen.findByRole('checkbox', { name: 'No owner' }));
    await vi.waitFor(() => expect(String(lastLeadParams().assigned_to)).toBe('NO_OWNER'));

    expect(lastLeadParams()).toEqual(fromCard);
    // Neither asks for a status: the server's No owner already leaves out the closed leads.
    expect(fromCard.status).toBeUndefined();
    // And the card lights up for the filter, as it does for its own click.
    expect(tile('No owner')).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens the Won and Lost tiles as the status filter alone', async () => {
    const user = userEvent.setup();
    serveStats({ total: 3, new_this_week: 0, no_owner: 2, won: 1, lost: 1 });
    renderWithProviders(<LeadsPage />, { ability: readerOnly() });
    await screen.findByText('AC not cooling');

    await user.click(tile('Lost'));
    await vi.waitFor(() => expect(String(lastLeadParams().status)).toBe('LOST'));
    expect(lastLeadParams().assigned_to).toBeUndefined();
    await user.click(tile('Won'));
    await vi.waitFor(() => expect(String(lastLeadParams().status)).toBe('WON'));
    expect(lastLeadParams().assigned_to).toBeUndefined();
  });
});
