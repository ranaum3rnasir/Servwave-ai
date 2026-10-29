/**
 * #517 — Tasks Dashboard: metric cards must be clickable and drill into the list.
 *
 * The four KPI cards (Open / At Risk / On-Time % / Blocked) must render as real
 * buttons; clicking one sets the shared task-list category filter and drills
 * into the list tab. "Top Closer" stays a non-interactive tile.
 *
 * recharts' ResponsiveContainer renders null under jsdom, so the KPI strip above
 * it renders cleanly on its own.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

vi.mock('@/lib/tasks/taskAI', () => ({
  taskAI: { rollup: vi.fn(() => 'This week summary') },
}));

vi.mock('@/stores/tasksStore', () => {
  // Inlined inside the hoisted factory (no top-level refs allowed).
  const base = {
    task_number: 'T00001', title: 'x', description: '',
    priority: 'MEDIUM' as const,
    assignee_ids: ['u1'], assignees: [{ id: 'u1', name: 'Uno One' }],
    watcher_ids: [] as string[],
    due_at: null, linked_entity: null, tags: [] as string[], subtasks: [],
    created_by: 'u1', created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-05T12:00:00.000Z', completed_at: null,
    activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
  };
  const state = {
    tasks: [
      { ...base, id: 'a', status: 'TODO' },
      { ...base, id: 'b', status: 'BLOCKED' },
    ],
  };
  return { useTasksStore: vi.fn((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state)) };
});

const mockSetCategory = vi.fn();
vi.mock('@/stores/taskFilterStore', () => {
  const state = {
    memberId: 'all', departmentId: 'all', categoryIds: [], category: 'all',
    setMember: vi.fn(), setDepartment: vi.fn(), setCategoryIds: vi.fn(),
    setCategory: (...args: unknown[]) => mockSetCategory(...args),
    reset: vi.fn(),
  };
  return { useTaskFilterStore: vi.fn((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state)) };
});

import DashboardView from '@/pages/tasks/views/DashboardView';

describe('Tasks Dashboard KPI cards are clickable (#517)', () => {
  it('renders the four metric cards as buttons and Top Closer as a plain tile', () => {
    renderWithProviders(<DashboardView />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(screen.getByRole('button', { name: /Open/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /At Risk/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /On-Time/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Blocked/i })).toBeInTheDocument();
    // Top Closer has no onClick → renders as a non-interactive div, not a button.
    expect(screen.queryByRole('button', { name: /Top Closer/i })).not.toBeInTheDocument();
  });

  it('clicking Blocked sets category to blocked and fires the drill-down', async () => {
    const onDrillDown = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DashboardView onDrillDown={onDrillDown} />);

    await user.click(screen.getByRole('button', { name: /Blocked/i }));

    expect(mockSetCategory).toHaveBeenCalledWith('blocked');
    expect(onDrillDown).toHaveBeenCalledTimes(1);
  });
});
