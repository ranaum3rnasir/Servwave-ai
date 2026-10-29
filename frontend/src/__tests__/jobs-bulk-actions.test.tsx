import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobsPage from '@/pages/JobsPage';
import { buildAbility } from '@/lib/ability';

// Bulk-status toast assertions (mirrors estimates-page.test.tsx's minimal shape).
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
import { toast } from '@/components/ui/use-toast';

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const JOB_LIST_FIXTURE = {
  jobs: [
    {
      id: 'j0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scheduled_start: '2026-07-20T09:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'John',
        last_name: 'Doe',
        company_name: null,
        customer_number: 'C00001',
      },
      assignees: [],
      service_location: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    unassigned: 2,
    scheduled: 5,
    in_progress: 1,
    completed: 3,
    cancelled: 1,
    need_invoices: 4,
  },
  users: [],
  departments: [],
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: JOB_LIST_FIXTURE });
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

async function selectFirstRow() {
  await screen.findByText('John Doe');
  const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
  fireEvent.click(rowCheckboxes[0]);
  await screen.findByText('1 selected');
}

async function openStatusMenu() {
  await userEvent.click(screen.getByRole('button', { name: /change status/i }));
}

describe('JobsPage - bulk actions (SRVW-104)', () => {
  it('renders a selection checkbox column and shows the bulk toolbar only once a row is checked', async () => {
    renderWithProviders(<JobsPage />, { ability: adminAbility });
    await screen.findByText('John Doe');

    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();

    await selectFirstRow();
    await openStatusMenu();

    expect(await screen.findByRole('menuitem', { name: 'On site' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'In progress' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Completed' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Cancelled' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /on the way/i })).not.toBeInTheDocument();
  });

  it('choosing a status posts the selected ids to /api/jobs/bulk-status and clears the selection', async () => {
    mockApi.post.mockResolvedValueOnce({ data: { updated: ['j0000000-0000-0000-0000-000000000001'], failed: [] } });

    renderWithProviders(<JobsPage />, { ability: adminAbility });
    await selectFirstRow();
    await openStatusMenu();

    await userEvent.click(await screen.findByRole('menuitem', { name: 'In progress' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/bulk-status', {
        ids: ['j0000000-0000-0000-0000-000000000001'],
        action: 'start',
      });
    });

    await waitFor(() => {
      expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    });
  });

  it('the Completed confirm names the automation consequence before anything is sent', async () => {
    renderWithProviders(<JobsPage />, { ability: adminAbility });
    await selectFirstRow();
    await openStatusMenu();

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Completed' }));

    // The consequence is now rendered copy in the app's dialog rather than a string handed to
    // window.confirm, so it is asserted on screen - and declining still sends nothing.
    expect(
      await screen.findByText(/customer follow-ups configured in Automations/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('per-row failures surface their real reason and are not swallowed into a success toast', async () => {
    mockApi.post.mockResolvedValueOnce({
      data: { updated: [], failed: [{ id: 'j0000000-0000-0000-0000-000000000001', error: 'Insufficient permissions' }] },
    });

    renderWithProviders(<JobsPage />, { ability: adminAbility });
    await selectFirstRow();
    await openStatusMenu();

    await userEvent.click(await screen.findByRole('menuitem', { name: 'On site' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('Insufficient permissions'),
        }),
      );
    });
  });

  it('selection is dropped when the jobs query params change', async () => {
    renderWithProviders(<JobsPage />, { ability: adminAbility });
    await selectFirstRow();
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    const searchBox = screen.getByPlaceholderText('Search jobs...');
    fireEvent.change(searchBox, { target: { value: 'foo' } });

    await waitFor(() => {
      expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    });
  });

  it('cancel goes through the reason dialog, sends one cancelled_reason, and reports the voided invoices back', async () => {
    mockApi.post.mockResolvedValueOnce({
      data: { updated: ['j0000000-0000-0000-0000-000000000001'], voided_invoice_ids: ['i1', 'i2', 'i3'], failed: [] },
    });

    renderWithProviders(<JobsPage />, { ability: adminAbility });
    await selectFirstRow();
    await openStatusMenu();

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Cancelled' }));

    const confirmButton = await screen.findByRole('button', { name: /cancel job/i });
    expect(confirmButton).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/why/i);
    fireEvent.change(textarea, { target: { value: 'customer no longer needs it' } });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/bulk-status', {
        ids: ['j0000000-0000-0000-0000-000000000001'],
        action: 'cancel',
        cancelled_reason: 'customer no longer needs it',
      });
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('3 invoice'),
        }),
      );
    });
  });
});
