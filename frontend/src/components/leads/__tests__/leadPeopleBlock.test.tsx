/**
 * Roles & Permissions, PRD 3, slice S03.4 - the lead page's people block.
 *
 * The block shows the lead's Owner and Dispatcher. Each reads "No owner" / "No dispatcher" when empty,
 * and a viewer with Assign people to leads sees Change and (when someone holds the slot) Clear on each.
 * The word "Assigned To" is gone. The roster a Dispatcher picker asks is the Dispatcher slot's.
 *
 * Only the network edge is stubbed; the block and its pickers are rendered whole.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { LeadPeopleBlock } from '../LeadPeopleBlock';

const mockApi = vi.mocked(api);

const ROSTER = [
  { id: 'u1', first_name: 'Alice', last_name: 'Eligible', role: 'SALES', department: null },
  { id: 'u2', first_name: 'Bob', last_name: 'Eligible', role: 'TECHNICIAN', department: null },
];
const OWNER = { id: 'o1', first_name: 'Olive', last_name: 'Owner' };
const DISPATCHER = { id: 'd1', first_name: 'Dana', last_name: 'Dispatch' };

const rosterParams = () =>
  mockApi.get.mock.calls
    .filter(([url]) => url === '/api/users/assignable')
    .map(([, config]) => (config as { params: Record<string, string> }).params);

const renderBlock = (props: Partial<React.ComponentProps<typeof LeadPeopleBlock>> = {}) =>
  renderWithProviders(<LeadPeopleBlock leadId="lead-1" owner={OWNER} dispatcher={DISPATCHER} canAssign {...props} />);

/** The section for one slot, found by its heading. */
const section = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: ROSTER });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('what the block shows', () => {
  it('names the Owner and the Dispatcher under those headings, never "Assigned To"', () => {
    renderBlock();
    expect(within(section('Owner')).getByText('Olive Owner')).toBeInTheDocument();
    expect(within(section('Dispatcher')).getByText('Dana Dispatch')).toBeInTheDocument();
    expect(screen.queryByText(/assigned to/i)).toBeNull();
    expect(screen.queryByText(/unassigned/i)).toBeNull();
  });

  it('reads "No owner" and "No dispatcher" for an empty slot', () => {
    renderBlock({ owner: null, dispatcher: null });
    expect(within(section('Owner')).getByText('No owner')).toBeInTheDocument();
    expect(within(section('Dispatcher')).getByText('No dispatcher')).toBeInTheDocument();
  });

  it('offers Change on both slots and Clear on each filled one to a viewer with Assign people to leads', () => {
    renderBlock();
    for (const name of ['Owner', 'Dispatcher']) {
      expect(within(section(name)).getByRole('button', { name: 'Change' })).toBeInTheDocument();
      expect(within(section(name)).getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    }
  });

  it('offers no Clear on an empty slot', () => {
    renderBlock({ owner: null, dispatcher: DISPATCHER });
    expect(within(section('Owner')).getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(within(section('Owner')).queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(within(section('Dispatcher')).getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('hides Change and Clear from a viewer without Assign people to leads, and still shows the people', () => {
    renderBlock({ canAssign: false });
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(screen.getByText('Olive Owner')).toBeInTheDocument();
    expect(screen.getByText('Dana Dispatch')).toBeInTheDocument();
  });
});

describe('changing and clearing', () => {
  it('asks the roster for the Dispatcher slot and posts the pick to the lead Dispatcher route', async () => {
    const user = userEvent.setup();
    renderBlock({ dispatcher: null });
    await user.click(within(section('Dispatcher')).getByRole('button', { name: 'Change' }));
    await user.click(await screen.findByRole('option', { name: /bob eligible/i }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/dispatcher', { dispatcher_id: 'u2' }));
    expect(rosterParams()[0]).toMatchObject({ eligible_for: 'dispatcher' });
  });

  it('asks the roster for the Owner slot and posts the pick to the lead assign route', async () => {
    const user = userEvent.setup();
    renderBlock({ owner: null });
    await user.click(within(section('Owner')).getByRole('button', { name: 'Change' }));
    await user.click(await screen.findByRole('option', { name: /alice eligible/i }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/assign', expect.objectContaining({ assigned_to: 'u1' })));
    expect(rosterParams()[0]).toMatchObject({ eligible_for: 'owner' });
  });

  it('offers notify toggles for the Owner pick and none for the Dispatcher pick, which tells nobody', async () => {
    const user = userEvent.setup();
    renderBlock();
    await user.click(within(section('Owner')).getByRole('button', { name: 'Change' }));
    expect(await screen.findByText('Notify')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Notify')).toBeNull());

    await user.click(within(section('Dispatcher')).getByRole('button', { name: 'Change' }));
    await screen.findByRole('option', { name: /bob eligible/i });
    expect(screen.queryByText('Notify')).toBeNull();
  });

  it('clears the Dispatcher with a null on the lead Dispatcher route', async () => {
    const user = userEvent.setup();
    renderBlock();
    await user.click(within(section('Dispatcher')).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/dispatcher', { dispatcher_id: null }));
  });

  it('clears the Owner with a null on the lead assign route', async () => {
    const user = userEvent.setup();
    renderBlock();
    await user.click(within(section('Owner')).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/assign', { assigned_to: null }));
  });

  it('says why when the server refuses the Dispatcher pick', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { error: "This person can't be a dispatcher." } } });
    renderBlock({ dispatcher: null });
    await user.click(within(section('Dispatcher')).getByRole('button', { name: 'Change' }));
    await user.click(await screen.findByRole('option', { name: /bob eligible/i }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    expect(await screen.findByText("This person can't be a dispatcher.")).toBeInTheDocument();
  });
});
