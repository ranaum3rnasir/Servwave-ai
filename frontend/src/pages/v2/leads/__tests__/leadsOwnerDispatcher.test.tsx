/**
 * Roles & Permissions, PRD 3, slice S03.5 - the Leads list says Owner, offers a Dispatcher filter and
 * shows a "No owner" card. Rendered through the routed page over a mocked HTTP layer: what the person
 * sees, and what the page asks the server for when they click or filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadsPage from '../LeadsPage';

const hoisted = vi.hoisted(() => ({
  toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
  downloadCSV: vi.fn(),
}));
vi.mock('@/lib/inventory/csv', () => ({ toCSV: hoisted.toCSV, downloadCSV: hoisted.downloadCSV }));

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
const OWNED_ROW = {
  ...LEAD_ROW, id: 'e0000000-0000-0000-0000-000000000002', lead_number: 'L00002', service_request: 'Door will not lock',
  commission_owner: { id: 'u-owner', first_name: 'Olive', last_name: 'Owner' },
};

const DISPATCHERS = [
  { id: 'u-dispatch-1', first_name: 'Dana', last_name: 'Dispatch', role: 'DISPATCHER', department: null },
  { id: 'u-dispatch-2', first_name: 'Tom', last_name: 'Tech', role: 'TECHNICIAN', department: null },
];
const OWNERS = [{ id: 'u-owner', first_name: 'Olive', last_name: 'Owner', role: 'SALES', department: null }];

const mockApi = vi.mocked(api);
const leadCalls = () => mockApi.get.mock.calls.filter(([url]) => url === '/api/leads');
const lastLeadParams = () => (leadCalls().at(-1)![1] as { params: Record<string, unknown> }).params;

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === '/api/leads') {
      return {
        data: {
          leads: [LEAD_ROW, OWNED_ROW],
          pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
          stats: { total: 2, new_this_week: 0, no_owner: 7, won: 0, lost: 0 },
        },
      };
    }
    if (url === '/api/users/assignable') {
      return { data: (config?.params as Record<string, unknown> | undefined)?.eligible_for === 'dispatcher' ? DISPATCHERS : OWNERS };
    }
    return { data: {} };
  });
});

describe('Leads list - the "No owner" card', () => {
  it('is named No owner, shows the server count, and never says Unassigned', async () => {
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    const card = screen.getByText('No owner').closest('button')!;
    expect(within(card).getByText('7')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/unassigned/i);
  });

  it("applies the Owner filter's No owner option when clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    const card = screen.getByText('No owner').closest('button')!;
    await user.click(card);

    await vi.waitFor(() => expect(String(lastLeadParams().assigned_to)).toBe('NO_OWNER'));
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Leads list - the Owner column and filter', () => {
  it('heads the column Owner, shows a dash for an empty Owner and never says Assignee', async () => {
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    const table = screen.getByRole('table');
    expect(within(table).getByText('Owner')).toBeInTheDocument();
    expect(within(table).queryByText(/assignee/i)).toBeNull();
    const emptyRow = within(table).getByText('AC not cooling').closest('tr')!;
    expect(within(emptyRow).getByText('—')).toBeInTheDocument();
    expect(within(emptyRow).queryByText(/unassigned/i)).toBeNull();
    const ownedRow = within(table).getByText('Door will not lock').closest('tr')!;
    expect(within(ownedRow).getByText('Olive Owner')).toBeInTheDocument();
  });

  it('is the Owner filter, offering No owner first and then the people', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^filter$/i }));
    await user.click(await screen.findByRole('tab', { name: 'Owner' }));

    expect(screen.queryByRole('tab', { name: /assigned to/i })).toBeNull();
    expect(await screen.findByRole('checkbox', { name: 'No owner' })).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'Olive Owner' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /unassigned/i })).toBeNull();
  });

  it('exports the column as Owner, with a dash when there is none', async () => {
    const user = userEvent.setup();
    // Export leads needs View leads.
    renderWithProviders(<LeadsPage />, {
      ability: buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'export', subject: 'Lead' }]),
    });
    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^export$/i }));
    await user.click(await screen.findByRole('menuitem', { name: /current page/i }));

    const [rows] = hoisted.toCSV.mock.calls.at(-1)!;
    const [empty, owned] = rows as Record<string, unknown>[];
    expect(empty).not.toHaveProperty('Assigned To');
    expect(empty!.Owner).toBe('—');
    expect(owned!.Owner).toBe('Olive Owner');
  });
});

describe('Leads list - the Dispatcher filter', () => {
  it('lists No dispatcher and only the people the server calls eligible dispatchers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^filter$/i }));
    await user.click(await screen.findByRole('tab', { name: 'Dispatcher' }));

    expect(await screen.findByRole('checkbox', { name: 'No dispatcher' })).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'Dana Dispatch' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Tom Tech' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Olive Owner' })).toBeNull();

    const asked = mockApi.get.mock.calls.filter(
      ([url, cfg]) => url === '/api/users/assignable' && (cfg as { params: Record<string, unknown> }).params.eligible_for === 'dispatcher',
    );
    expect(asked.length).toBeGreaterThan(0);
  });

  it('asks the server for leads with no Dispatcher when that option is picked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^filter$/i }));
    await user.click(await screen.findByRole('tab', { name: 'Dispatcher' }));
    await user.click(await screen.findByRole('checkbox', { name: 'No dispatcher' }));

    await vi.waitFor(() => expect(String(lastLeadParams().dispatcher)).toBe('NO_DISPATCHER'));
  });

  it('does not light up the No owner card for a Dispatcher filter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    const card = screen.getByText('No owner').closest('button')!;
    await user.click(screen.getByRole('button', { name: /^filter$/i }));
    await user.click(await screen.findByRole('tab', { name: 'Dispatcher' }));
    await user.click(await screen.findByRole('checkbox', { name: 'No dispatcher' }));

    await vi.waitFor(() => expect(String(lastLeadParams().dispatcher)).toBe('NO_DISPATCHER'));
    expect(card).not.toHaveAttribute('aria-pressed', 'true');
  });
});
