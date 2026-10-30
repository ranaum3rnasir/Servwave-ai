/**
 * Scenario pass 1 fix - the lead page's Owner and Dispatcher Change pickers while the roster is on the way. The
 * roster answered after many seconds and the popover read "No team members found" (Assign disabled) for the whole
 * wait. Now a roster still loading shows a loading placeholder, a failed one an error with Retry, and "No team
 * members found" only for a roster that arrived empty. The people who already hold the slot stay listed throughout.
 *
 * Only the network edge is stubbed; the block and its pickers are rendered whole.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { LeadPeopleBlock } from '../LeadPeopleBlock';

const mockApi = vi.mocked(api);

const ROSTER = [{ id: 'u1', first_name: 'Alice', last_name: 'Eligible', role: 'SALES', department: null }];
const OWNER = { id: 'o1', first_name: 'Olive', last_name: 'Owner' };

const section = (name: string) => screen.getByRole('region', { name });
const openChange = async (name: 'Owner' | 'Dispatcher', props: Partial<React.ComponentProps<typeof LeadPeopleBlock>> = {}) => {
  const user = userEvent.setup();
  renderWithProviders(<LeadPeopleBlock leadId="lead-1" owner={null} dispatcher={null} canAssign {...props} />);
  await user.click(within(section(name)).getByRole('button', { name: 'Change' }));
  return user;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(['Owner', 'Dispatcher'] as const)('the %s Change picker', (name) => {
  it('shows a loading placeholder while the roster loads, not "No team members found"', async () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    await openChange(name);

    expect(await screen.findByRole('status', { name: 'Loading team members' })).toBeInTheDocument();
    expect(screen.queryByText('No team members found')).toBeNull();
  });

  it('keeps the person who holds the slot in the list while the rest of the roster loads', async () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    await openChange(name, name === 'Owner' ? { owner: OWNER } : { dispatcher: OWNER });

    expect(await screen.findByRole('option', { name: /olive owner/i })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading team members' })).toBeInTheDocument();
    expect(screen.queryByText('No team members found')).toBeNull();
  });

  it('lists the people once the roster arrives', async () => {
    mockApi.get.mockResolvedValue({ data: ROSTER });
    await openChange(name);

    expect(await screen.findByRole('option', { name: /alice eligible/i })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading team members' })).toBeNull();
  });

  it('says "No team members found" only for a roster that arrived empty', async () => {
    mockApi.get.mockResolvedValue({ data: [] });
    await openChange(name);

    expect(await screen.findByText('No team members found')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading team members' })).toBeNull();
  });

  it('shows an error with Retry for a roster that failed, and the people after Retry succeeds', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('Request failed with status code 500'));
    mockApi.get.mockResolvedValue({ data: ROSTER });
    const user = await openChange(name);

    expect(await screen.findByText('Could not load the list of people.')).toBeInTheDocument();
    expect(screen.queryByText('No team members found')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /alice eligible/i })).toBeInTheDocument();
  });
});
