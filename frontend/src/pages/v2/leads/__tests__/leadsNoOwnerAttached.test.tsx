/**
 * Roles & Permissions, PRD 4, slice S04.4 - the "No owner" card and the Owner filter's "No owner" choice
 * for a person on Leads scope Attached (the Sales preset's value).
 * Rendered through the routed page over a mocked HTTP layer: the card and the choice show for a person who
 * can open only the leads they are on, the card carries the count the server worked out for that reach
 * (non-zero when such a lead exists), and the card and the choice ask for exactly the same leads. The page
 * holds nothing of the person's scope, so the choice must not depend on the people list the filter also
 * reads (a person on Attached may not be offered the whole company's people).
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

/** What the Sales preset lets a person do with leads: open, create, edit and close them. */
const salesAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'create', subject: 'Lead' },
    { action: 'update', subject: 'Lead' },
    { action: 'mark_lost', subject: 'Lead' },
  ]);

/**
 * The server's answer for a person on Attached: one lead they are Dispatcher of, no Owner. The people
 * list is refused, as it may be for a person who sees only their own leads.
 */
function serveAttached() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/leads') {
      return {
        data: {
          leads: [LEAD_ROW],
          pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
          stats: { total: 3, new_this_week: 1, no_owner: 2, won: 1, lost: 0 },
        },
      };
    }
    if (url === '/api/users/assignable') throw new Error('Request failed with status code 403');
    return { data: {} };
  });
}

// The tile, not an applied-filter chip that carries the same words.
const tile = (label: string) =>
  screen.getAllByText(label)
    .map((el) => el.closest('button'))
    .find((button) => button?.querySelector('[data-slot="stat-card-value"]'))!;

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe('Leads page for a person on Leads scope Attached', () => {
  it('shows the No owner card with a non-zero count and never the old Unassigned tile', async () => {
    serveAttached();
    renderWithProviders(<LeadsPage />, { ability: salesAbility() });
    await screen.findByText('AC not cooling');

    expect(within(tile('No owner')).getByText('2')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/unassigned/i);
  });

  it('asks for the same leads from the card as from the Owner filter\'s No owner choice, with no people list', async () => {
    const user = userEvent.setup();
    serveAttached();
    renderWithProviders(<LeadsPage />, { ability: salesAbility() });
    await screen.findByText('AC not cooling');

    await user.click(tile('No owner'));
    await vi.waitFor(() => expect(String(lastLeadParams().assigned_to)).toBe('NO_OWNER'));
    const fromCard = { ...lastLeadParams() };

    await user.click(tile('Total Leads'));
    await vi.waitFor(() => expect(lastLeadParams().assigned_to).toBeUndefined());
    await user.click(screen.getByRole('button', { name: /^filter$/i }));
    await user.click(await screen.findByRole('tab', { name: 'Owner' }));
    await user.click(await screen.findByRole('checkbox', { name: 'No owner' }));
    await vi.waitFor(() => expect(String(lastLeadParams().assigned_to)).toBe('NO_OWNER'));

    expect(lastLeadParams()).toEqual(fromCard);
    expect(tile('No owner')).toHaveAttribute('aria-pressed', 'true');
  });
});
