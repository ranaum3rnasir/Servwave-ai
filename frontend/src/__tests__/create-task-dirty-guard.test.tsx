/**
 * Mobile slice 43: the New Task form (the v2 dialog and the legacy modal share one form hook) does
 * not discard a half-filled task without asking. Cancel, Escape and the scrim all used to reset the
 * form and close it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { CreateTaskDialog } from '@/pages/v2/tasks/components/createTaskDialog';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));
vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ tasks: [], addTask: vi.fn() }),
  ),
}));

beforeEach(() => vi.clearAllMocks());

describe.each([
  ['v2 dialog', (onOpenChange: () => void) => <CreateTaskDialog open onOpenChange={onOpenChange} />],
  ['legacy modal', (onOpenChange: () => void) => <CreateTaskModal open onOpenChange={onOpenChange} />],
])('New Task - %s', (_name, make) => {
  it('Cancel after typing a title asks first; Keep editing keeps it', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(make(onOpenChange));
    await user.type(screen.getByPlaceholderText('Task title'), 'Order the hinges');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByPlaceholderText('Task title')).toHaveValue('Order the hinges');
  });

  it('Escape after typing asks; Discard closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(make(onOpenChange));
    await user.type(screen.getByPlaceholderText('Task title'), 'Order the hinges');

    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('an untouched form closes without a question', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(make(onOpenChange));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
  });
});
