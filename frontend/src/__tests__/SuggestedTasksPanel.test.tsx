/**
 * FE-5: SuggestedTasksPanel
 *
 * Tests:
 * 1. Renders 3 seed suggestions on mount (no MOCK_ENTITIES dependency).
 * 2. Accept calls addTask with a CreateTaskInput shape (title + linked_entity only),
 *    NOT a full Task object (no id / task_number / created_at / activity).
 * 3. Accept with a pageEntity pre-wires the entity onto the CreateTaskInput.
 * 4. Dismiss removes the item without calling addTask.
 * 5. After all accepted/dismissed, "No more suggestions." is shown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { SuggestedTasksPanel } from '@/components/tasks/SuggestedTasksPanel';
import type { CreateTaskInput } from '@/lib/api/tasks';

// ── Mock tasksStore ───────────────────────────────────────────────────────────

const mockAddTask = vi.fn().mockResolvedValue({});

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ addTask: mockAddTask })
  ),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SuggestedTasksPanel (FE-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddTask.mockResolvedValue({});
  });

  it('renders 3 seed suggestions on mount', () => {
    renderWithProviders(<SuggestedTasksPanel />);
    const panel = screen.getByTestId('suggested-tasks-panel');
    const buttons = panel.querySelectorAll('button');
    // Each item has Accept + Dismiss = 6 buttons total for 3 items
    const acceptBtns = Array.from(buttons).filter((b) => b.textContent === 'Accept');
    expect(acceptBtns.length).toBe(3);
  });

  it('does NOT render [JOB]/[LEAD] entity chips (suggestions start with no linked entity)', () => {
    renderWithProviders(<SuggestedTasksPanel />);
    // LinkedEntityChip only renders when entity is non-null.
    // Seed items have entity:null so no chips should appear.
    expect(screen.queryByText(/\[JOB\]/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[LEAD\]/)).not.toBeInTheDocument();
  });

  it('calls addTask with a CreateTaskInput shape (title + linked_entity) when Accept is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuggestedTasksPanel />);

    const acceptBtns = screen.getAllByRole('button', { name: 'Accept' });
    await user.click(acceptBtns[0]);

    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledOnce();
    });

    const arg: CreateTaskInput = mockAddTask.mock.calls[0][0];

    // Must be a CreateTaskInput: has title
    expect(typeof arg.title).toBe('string');
    expect(arg.title.length).toBeGreaterThan(0);

    // Must NOT have Task-only fields (id, task_number, created_at, activity, etc.)
    expect(arg).not.toHaveProperty('id');
    expect(arg).not.toHaveProperty('task_number');
    expect(arg).not.toHaveProperty('created_at');
    expect(arg).not.toHaveProperty('activity');
    expect(arg).not.toHaveProperty('created_by');
  });

  it('passes linked_entity=null when no pageEntity is provided', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuggestedTasksPanel />);

    await user.click(screen.getAllByRole('button', { name: 'Accept' })[0]);

    await waitFor(() => { expect(mockAddTask).toHaveBeenCalledOnce(); });

    const arg: CreateTaskInput = mockAddTask.mock.calls[0][0];
    expect(arg.linked_entity).toBeNull();
  });

  it('wires pageEntity onto the CreateTaskInput when provided', async () => {
    const user = userEvent.setup();
    const pageEntity = { type: 'JOB' as const, id: 'job-uuid-99', label: 'J00099 · HVAC' };

    renderWithProviders(<SuggestedTasksPanel pageEntity={pageEntity} />);

    await user.click(screen.getAllByRole('button', { name: 'Accept' })[0]);

    await waitFor(() => { expect(mockAddTask).toHaveBeenCalledOnce(); });

    const arg: CreateTaskInput = mockAddTask.mock.calls[0][0];
    expect(arg.linked_entity).toEqual({ type: 'JOB', id: 'job-uuid-99' });
  });

  it('removes the accepted item from the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuggestedTasksPanel />);

    const firstText = screen.getAllByRole('button', { name: 'Accept' })[0]
      .closest('li')
      ?.querySelector('p')?.textContent;

    await user.click(screen.getAllByRole('button', { name: 'Accept' })[0]);

    // The item should be removed
    await waitFor(() => {
      if (firstText) {
        expect(screen.queryByText(firstText)).not.toBeInTheDocument();
      }
    });
  });

  it('dismisses the item without calling addTask', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuggestedTasksPanel />);

    const firstText = screen.getAllByRole('button', { name: 'Dismiss' })[0]
      .closest('li')
      ?.querySelector('p')?.textContent;

    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);

    expect(mockAddTask).not.toHaveBeenCalled();

    if (firstText) {
      await waitFor(() => {
        expect(screen.queryByText(firstText)).not.toBeInTheDocument();
      });
    }
  });

  it('shows "No more suggestions." when all items are dismissed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuggestedTasksPanel />);

    const dismissBtns = screen.getAllByRole('button', { name: 'Dismiss' });
    for (const btn of dismissBtns) {
      await user.click(btn);
    }

    await waitFor(() => {
      expect(screen.getByText('No more suggestions.')).toBeInTheDocument();
    });
  });
});
