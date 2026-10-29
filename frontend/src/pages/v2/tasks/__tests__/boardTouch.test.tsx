/**
 * Mobile slice 32 (TOUCH-07, TOUCH-08, TOUCH-10 for the task board): the task board and the
 * shared kanban board work by touch.
 *
 * What jsdom can pin, and what it cannot:
 *  - CAN: no card carries `touch-none` (a whole-card `touch-action: none` is what stopped a swipe
 *    on a card from scrolling its lane), every card has a "move to column" control a tap can use,
 *    and choosing a column from it moves the card through the same store action a drop uses.
 *  - CAN: the task drawer is never wider than the screen it opens on.
 *  - CANNOT: that a swipe scrolls and a long-press drags. jsdom lays nothing out and has no
 *    gesture pipeline; e2e/mobile/task-board.spec.ts drives both with real touch input on the
 *    six device projects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import type { Task } from '@/lib/tasks/types';
import { KanbanBoard, type KanbanItem } from '@/ui-kit/components/crm/kanbanBoard/kanbanBoard';

import BoardView from '../views/boardView';
import { TaskDetailDrawer } from '../components/taskDetailDrawer';

const VIEWER = '00000000-0000-0000-0000-000000000001';

const TASK: Task = {
  id: 'srv-1',
  task_number: 'T00050',
  title: 'Schedule Approval',
  description: '',
  status: 'TODO',
  priority: 'HIGH',
  // The global auth mock's signed-in admin (src/__tests__/setup.ts): the Board shows tasks the
  // viewer is on.
  assignee_ids: [VIEWER],
  assignees: [{ id: VIEWER, name: 'Test Admin' }],
  watcher_ids: [],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [],
  created_by: VIEWER,
  created_at: '2026-06-20T00:00:00Z',
  updated_at: '2026-06-20T00:00:00Z',
  completed_at: null,
  activity: [],
  comments: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
} as unknown as Task;

beforeEach(() => {
  useTaskFilterStore.getState().reset();
  useTaskViewStore.getState().reset();
  useTasksStore.setState({ loaded: true, loading: false, tasks: [TASK] });
});

describe('task board by touch (mobile slice 32)', () => {
  it('puts touch-action none on no card, so a swipe that starts on a card scrolls its lane', () => {
    const { container } = renderWithProviders(<BoardView />);
    const card = container.querySelector<HTMLElement>('[aria-roledescription="sortable"]');
    expect(card).not.toBeNull();
    for (let el: HTMLElement | null = card; el && el !== container; el = el.parentElement) {
      expect(el.className, 'a card or its lane carries touch-none').not.toMatch(/(^|\s)touch-none(\s|$)/);
    }
    // The press-and-hold must not select the card's text or raise the iOS callout instead.
    expect(card!.className).toMatch(/(^|\s)select-none(\s|$)/);
  });

  it('moves a card to another column by tap, through the same store action a drop uses', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    useTasksStore.setState({ updateStatus });
    const user = userEvent.setup();
    renderWithProviders(<BoardView />);

    await user.click(screen.getByRole('button', { name: 'Move "Schedule Approval" to another column' }));
    const menu = await screen.findByRole('menu');
    // The card's own column is not offered, and neither is the derived At Risk lane.
    expect(within(menu).queryByRole('menuitem', { name: 'To Do' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /At Risk/ })).toBeNull();
    await user.click(within(menu).getByRole('menuitem', { name: 'In Progress' }));

    expect(updateStatus).toHaveBeenCalledWith('srv-1', 'IN_PROGRESS');
  });

  it('opening the move menu does not open the task drawer', async () => {
    useTaskDetailStore.setState({ openTaskId: null });
    const user = userEvent.setup();
    renderWithProviders(<BoardView />);
    await user.click(screen.getByRole('button', { name: 'Move "Schedule Approval" to another column' }));
    expect(useTaskDetailStore.getState().openTaskId).toBeNull();
  });

  it('keeps the move control outside the card, so it is not a button inside a button', () => {
    const { container } = renderWithProviders(<BoardView />);
    const card = container.querySelector<HTMLElement>('[aria-roledescription="sortable"]')!;
    expect(within(card).queryByRole('button', { name: /to another column/ })).toBeNull();
  });
});

describe('task drawer width (mobile slice 32)', () => {
  it('is never wider than the screen it opens on', async () => {
    useTasksStore.setState({ fetchTaskDetail: vi.fn().mockResolvedValue(undefined) } as never);
    useTaskDetailStore.getState().open('srv-1');
    renderWithProviders(<TaskDetailDrawer />);
    const dialog = await screen.findByRole('dialog');
    // A bare fixed width (w-[440px]) is 120 px wider than a 320 phone.
    expect(dialog.className).not.toMatch(/(^|\s)w-\[440px\](\s|$)/);
    expect(dialog.className).toMatch(/w-\[min\(440px,100vw\)\]/);
  });
});

describe('shared kanban board by touch (mobile slice 32)', () => {
  const columns = [
    { id: 'new', title: 'New' },
    { id: 'quoted', title: 'Quoted' },
    { id: 'won', title: 'Won' },
  ];
  const items: KanbanItem[] = [
    { id: 'k1', columnId: 'new', summary: 'Replace the gate opener', key: 'JOB-1', type: 'maintenance', priority: 'medium' },
  ];

  it('puts touch-action none on no card', () => {
    const { container } = renderWithProviders(<KanbanBoard columns={columns} items={items} onItemsChange={() => {}} />);
    const card = container.querySelector<HTMLElement>('[aria-roledescription="sortable"]')!;
    expect(card).not.toBeNull();
    expect(card.className).not.toMatch(/(^|\s)touch-none(\s|$)/);
  });

  it('moves a card to another column by tap and reports the move', async () => {
    const onItemsChange = vi.fn();
    const onItemMoved = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <KanbanBoard columns={columns} items={items} onItemsChange={onItemsChange} onItemMoved={onItemMoved} />,
    );
    await user.click(screen.getByRole('button', { name: 'Move "Replace the gate opener" to another column' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'New' })).toBeNull();
    await user.click(within(menu).getByRole('menuitem', { name: 'Won' }));

    expect(onItemsChange).toHaveBeenCalledWith([{ ...items[0], columnId: 'won' }]);
    expect(onItemMoved).toHaveBeenCalledWith('k1', 'new', 'won');
  });
});
