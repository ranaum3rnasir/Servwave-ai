import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { AssignLeadPopover } from '@/components/leads/AssignLeadPopover';
import { AssignJobCrewPopover } from '@/components/jobs/AssignJobCrewPopover';
import { Button } from '@/components/ui/button';

const mockApi = vi.mocked(api);

const USERS = [
  { id: 'u1', first_name: 'Alice', last_name: 'Sales', role: 'SALES', is_active: true, has_login: true, department: { id: 'd1', name: 'HVAC' } },
  { id: 'u2', first_name: 'Bob', last_name: 'Tech', role: 'TECHNICIAN', is_active: true, has_login: true, department: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { users: USERS } });
  mockApi.post.mockResolvedValue({ data: {} });
});

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Assign lead' }));
  await waitFor(() => expect(screen.getByText('Alice Sales')).toBeInTheDocument());
}

function renderLeadPopover() {
  renderWithProviders(
    <AssignLeadPopover leadId="lead-1" currentAssignedTo={null} trigger={<Button>Assign lead</Button>} />,
  );
}

describe('AssignTeamPopover (via AssignLeadPopover, single mode)', () => {
  it('trigger click opens the anchored panel with mocked users and initials avatars', async () => {
    const user = userEvent.setup();
    renderLeadPopover();

    await openPopover(user);
    expect(screen.getByText('Bob Tech')).toBeInTheDocument();
    // Initials fallback text (jsdom never loads images, so fallbacks render).
    expect(screen.getByText('AS')).toBeInTheDocument();
    expect(screen.getByText('BT')).toBeInTheDocument();
    // No overlay/centered dialog.
    expect(screen.queryByRole('dialog', { name: /assign lead/i })).toBeNull();
  });

  it('typing in search filters the list', async () => {
    const user = userEvent.setup();
    renderLeadPopover();

    await openPopover(user);
    await user.type(screen.getByPlaceholderText(/search team members/i), 'ali');
    expect(screen.getByText('Alice Sales')).toBeInTheDocument();
    expect(screen.queryByText('Bob Tech')).toBeNull();
  });

  it('single mode: selecting a user and pressing Assign posts assigned_to + notify.in_app:true', async () => {
    const user = userEvent.setup();
    renderLeadPopover();

    await openPopover(user);
    await user.click(screen.getByRole('option', { name: /alice sales/i }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/assign', {
        assigned_to: 'u1',
        notify: { in_app: true },
      }),
    );
  });

  it('unchecking "In app" sends notify.in_app:false', async () => {
    const user = userEvent.setup();
    renderLeadPopover();

    await openPopover(user);
    await user.click(screen.getByRole('option', { name: /alice sales/i }));
    await user.click(screen.getByRole('checkbox', { name: 'In app' }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/assign', {
        assigned_to: 'u1',
        notify: { in_app: false },
      }),
    );
  });

  it('SMS row is visible but disabled', async () => {
    const user = userEvent.setup();
    renderLeadPopover();

    await openPopover(user);
    const sms = screen.getByRole('checkbox', { name: 'By SMS' });
    expect(sms).toBeDisabled();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('single mode: Assign is disabled with an empty selection', async () => {
    const user = userEvent.setup();
    renderLeadPopover();

    await openPopover(user);
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled();
  });

  it('controlled mode: open prop opens the panel with seeded state; assigning calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <AssignLeadPopover
        leadId="lead-1"
        currentAssignedTo="u2"
        open
        onOpenChange={onOpenChange}
        trigger={<span aria-hidden tabIndex={-1} />}
      />,
    );
    await waitFor(() => expect(screen.getByText('Alice Sales')).toBeInTheDocument());
    await user.click(screen.getByText('Alice Sales'));
    await user.click(screen.getByRole('button', { name: /^Assign$/ }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('AssignTeamPopover (via AssignJobCrewPopover, multi mode)', () => {
  it('toggling two users posts assignee_ids with notify defaults on', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssignJobCrewPopover jobId="job-1" currentAssigneeIds={[]} trigger={<Button>Assign crew</Button>} />,
    );

    await user.click(screen.getByRole('button', { name: 'Assign crew' }));
    await waitFor(() => expect(screen.getByText('Alice Sales')).toBeInTheDocument());

    await user.click(screen.getByRole('option', { name: /alice sales/i }));
    await user.click(screen.getByRole('option', { name: /bob tech/i }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/assignees', {
        assignee_ids: ['u1', 'u2'],
        notify: { in_app: true, email: true },
      }),
    );
  });

  it('unchecking "By email" sends notify.email:false while in_app stays true', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssignJobCrewPopover jobId="job-1" currentAssigneeIds={[]} trigger={<Button>Assign crew</Button>} />,
    );

    await user.click(screen.getByRole('button', { name: 'Assign crew' }));
    await waitFor(() => expect(screen.getByText('Alice Sales')).toBeInTheDocument());

    await user.click(screen.getByRole('option', { name: /alice sales/i }));
    await user.click(screen.getByRole('checkbox', { name: 'By email' }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/assignees', {
        assignee_ids: ['u1'],
        notify: { in_app: true, email: false },
      }),
    );
  });

  it('multi mode seeds the current crew and allows deselecting (crew REPLACE)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssignJobCrewPopover jobId="job-1" currentAssigneeIds={['u1']} trigger={<Button>Assign crew</Button>} />,
    );

    await user.click(screen.getByRole('button', { name: 'Assign crew' }));
    await waitFor(() => expect(screen.getByText('Alice Sales')).toBeInTheDocument());

    expect(screen.getByRole('option', { name: /alice sales/i })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: /alice sales/i })); // deselect
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/assignees', {
        assignee_ids: [],
        notify: { in_app: true, email: true },
      }),
    );
  });
});
