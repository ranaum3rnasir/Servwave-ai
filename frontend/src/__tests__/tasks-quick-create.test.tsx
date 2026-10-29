/**
 * #446 — 'New Task' quick-create entry in the Dashboard '+ New' menu and the
 * sidebar 'Create New' menu.
 *
 * Both menus are static arrays that pre-date the Tasks module, so there was no
 * way to open the (existing, functional) blank CreateTaskModal from outside the
 * Tasks hub. The fix mirrors the estimates pattern: menu entries link to
 * /tasks?action=new-task and TasksHubPage opens the modal once and strips the
 * param (replace:true so Back does not re-open it).
 *
 * Tab views / side widgets are stubbed like tasks-hub-hydrate.test.tsx;
 * CreateTaskModal is stubbed open-aware so the handshake is observable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { useTasksStore } from '@/stores/tasksStore';

// ── Stub the heavy tab views + side widgets so only the hub shell renders ──
vi.mock('@/pages/tasks/views/DashboardView', () => ({ default: () => <div data-testid="dashboard-view" /> }));
vi.mock('@/pages/tasks/views/BoardView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/MyDayView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/ListView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/CalendarView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/HistoryView', () => ({ default: () => <div /> }));
vi.mock('@/components/tasks/AiCommandBar', () => ({ AiCommandBar: () => <div /> }));
vi.mock('@/components/tasks/TaskDetailDrawer', () => ({ TaskDetailDrawer: () => <div /> }));
// Open-aware modal stub so the query-param handshake is observable.
vi.mock('@/components/tasks/CreateTaskModal', () => ({
  CreateTaskModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-task-modal-open" /> : null,
}));

import TasksHubPage from '@/pages/tasks/TasksHubPage';
import NewMenu from '@/pages/dashboard/NewMenu';
import { quickCreateItems } from '@/components/layout/nav-config';

/** Renders the current router location so URL cleanup can be asserted. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-probe">{`${loc.pathname}${loc.search}`}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  vi.mocked(api).get.mockResolvedValue({ data: { users: [], tasks: [] } } as never);
});

describe("Tasks quick-create handshake (#446)", () => {
  it('/tasks?action=new-task opens the CreateTaskModal and strips the param', async () => {
    renderWithProviders(
      <>
        <TasksHubPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/tasks?action=new-task'] }
    );
    await waitFor(() => {
      expect(screen.getByTestId('create-task-modal-open')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent(/^\/tasks$/);
    });
  });

  it('plain /tasks leaves the modal closed', async () => {
    renderWithProviders(<TasksHubPage />, { initialEntries: ['/tasks'] });
    // Hub renders normally, modal closed.
    expect(screen.getByTestId('tasks-workspace')).toBeInTheDocument();
    expect(screen.queryByTestId('create-task-modal-open')).not.toBeInTheDocument();
  });

  it("dashboard '+ New' menu lists 'New Task' and navigates to /tasks?action=new-task", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <NewMenu />
        <LocationProbe />
      </>,
      { initialEntries: ['/dashboard'] }
    );
    await user.click(screen.getByRole('button', { name: /new/i }));
    await user.click(screen.getByRole('menuitem', { name: 'New Task' }));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/tasks?action=new-task');
  });

  it("sidebar quickCreateItems contains an ability-gated 'New Task' entry", () => {
    const entry = quickCreateItems.find((i) => i.label === 'New Task');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      href: '/tasks?action=new-task',
      action: 'create',
      subject: 'Task',
    });
    expect(entry?.icon).toBeTruthy();
  });
});
