/**
 * Roles & Permissions, PRD 3, slice S03.1 - every people picker asks the roster for ONE slot.
 *
 * The roster (GET /api/users/assignable) answers `eligible_for=owner|dispatcher|crew` from each person's
 * own switch, and lists active people only. A picker therefore names the slot it fills, and still shows the
 * person who already holds the slot when the roster no longer lists them (they were deactivated, or their
 * switch was turned off), so the field never looks empty when it isn't.
 *
 * Only the network edge is stubbed; the components under test are rendered whole.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { AssignLeadPopover } from '@/components/leads/AssignLeadPopover';
import { AssignJobCrewPopover } from '@/components/jobs/AssignJobCrewPopover';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { Button } from '@/components/ui/button';

const mockApi = vi.mocked(api);

const ROSTER = [
  { id: 'u1', first_name: 'Alice', last_name: 'Eligible', role: 'SALES', department: null },
  { id: 'u2', first_name: 'Bob', last_name: 'Eligible', role: 'TECHNICIAN', department: null },
];

/** The params of every roster request made so far. */
const rosterParams = () =>
  mockApi.get.mock.calls
    .filter(([url]) => url === '/api/users/assignable')
    .map(([, config]) => (config as { params: Record<string, string> }).params);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: ROSTER });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('the roster is asked for the slot the picker fills', () => {
  it.each([
    ['jobCrew', 'crew'],
    ['walkthroughPerformer', 'crew'],
  ] as const)('a %s picker asks for the %s slot', async (purpose, slot) => {
    renderWithProviders(<MultiAssigneeSelect value={[]} onChange={vi.fn()} purpose={purpose} />);
    await waitFor(() => expect(rosterParams()).not.toHaveLength(0));
    expect(rosterParams()[0]).toMatchObject({ purpose, eligible_for: slot });
  });

  it('a crew picker that names another slot keeps it', async () => {
    renderWithProviders(<MultiAssigneeSelect value={[]} onChange={vi.fn()} purpose="directory" eligibleFor="owner" />);
    await waitFor(() => expect(rosterParams()).not.toHaveLength(0));
    expect(rosterParams()[0]).toMatchObject({ purpose: 'directory', eligible_for: 'owner' });
  });

  it('a picker that is not a slot asks for none', async () => {
    renderWithProviders(<MultiAssigneeSelect value={[]} onChange={vi.fn()} purpose="taskWatcher" />);
    await waitFor(() => expect(rosterParams()).not.toHaveLength(0));
    expect(rosterParams()[0]).not.toHaveProperty('eligible_for');
  });

  it('the lead Owner popover asks for the owner slot', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssignLeadPopover leadId="lead-1" currentAssignedTo={null} trigger={<Button>Assign lead</Button>} />);
    await user.click(screen.getByRole('button', { name: 'Assign lead' }));
    await waitFor(() => expect(rosterParams()).not.toHaveLength(0));
    expect(rosterParams()[0]).toMatchObject({ purpose: 'directory', eligible_for: 'owner' });
  });

  it('the job crew popover asks for the crew slot', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssignJobCrewPopover jobId="job-1" currentAssigneeIds={[]} trigger={<Button>Assign crew</Button>} />);
    await user.click(screen.getByRole('button', { name: 'Assign crew' }));
    await waitFor(() => expect(rosterParams()).not.toHaveLength(0));
    expect(rosterParams()[0]).toMatchObject({ purpose: 'jobCrew', eligible_for: 'crew' });
  });
});

describe('a popover keeps showing the person who already holds the slot', () => {
  it('shows the lead Owner the roster no longer lists, selected, beside the people who may be chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssignLeadPopover
        leadId="lead-1"
        currentAssignedTo="gone"
        currentAssignedPerson={{ id: 'gone', first_name: 'Gale', last_name: 'Gone' }}
        trigger={<Button>Assign lead</Button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Assign lead' }));
    const holder = await screen.findByRole('option', { name: /gale gone/i });
    expect(holder).toHaveAttribute('aria-selected', 'true');
    // The people who may be chosen are still there beside them.
    expect(screen.getByRole('option', { name: /alice eligible/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('shows crew members the roster no longer lists as already selected, and re-saves them with the new pick', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssignJobCrewPopover
        jobId="job-1"
        currentAssigneeIds={['gone']}
        currentAssignees={[{ id: 'gone', first_name: 'Gale', last_name: 'Gone' }]}
        trigger={<Button>Assign crew</Button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Assign crew' }));
    expect(await screen.findByRole('option', { name: /gale gone/i })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: /alice eligible/i }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/assignees', expect.objectContaining({ assignee_ids: ['gone', 'u1'] })),
    );
  });

  it('does not list the holder twice when the roster still has them', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssignLeadPopover
        leadId="lead-1"
        currentAssignedTo="u1"
        currentAssignedPerson={{ id: 'u1', first_name: 'Alice', last_name: 'Eligible' }}
        trigger={<Button>Assign lead</Button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Assign lead' }));
    await screen.findByRole('option', { name: /alice eligible/i });
    expect(screen.getAllByRole('option', { name: /alice eligible/i })).toHaveLength(1);
  });
});
