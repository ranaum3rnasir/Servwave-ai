/**
 * Phase 11.6 - TasksHubPage moves from DetailPageShell to TabStrip.
 *
 * Pins the REAL page's rendered tab-rail markup byte-exact, the same rigor
 * `components/patterns/__tests__/TabStrip.test.tsx` already applies to the
 * component in isolation - this file closes the loop by asserting the page
 * actually passes the props that reproduce its pre-migration look: the
 * underline trigger variant and no Card (this page never had one).
 *
 * TWO DISCLOSED, NON-EQUIVALENT PIECES VERSUS THE PRE-MIGRATION RENDER (see
 * TasksHubPage.tsx's own comment above its `TabStrip` call for the full
 * reasoning, and this migration's PR description for plan section 11.6):
 *   1. `data-testid="tasks-tab-rail"` now wraps the WHOLE tab strip (rail +
 *      the visible panel), not the rail alone - TabStrip has no seam a
 *      wrapper could sit between TabsList and its children. The rail's own
 *      bottom border still renders in the same place either way (it comes
 *      from `TabsList`'s own default `variant="line"`, not from a wrapper).
 *   2. The rail's own `min-w-max`/`gap-1`/`overflow-x-auto` (horizontal-
 *      scroll-on-overflow for a narrow viewport) has no home on TabStrip's
 *      prop surface and is not reproduced here - a real, accepted
 *      narrowing, not a no-op.
 * The lost outer `space-y-4` gap between the rail and the visible panel IS
 * reproduced (each panel's own margin moved from `mt-0` to `mt-4`, same 16px
 * result) - asserted below via `getComputedStyle`-free DOM adjacency, not by
 * a class string, since that margin is now owned by the panel not the root.
 *
 * The tab views are stubbed the same way tasks-hub-hydrate.test.tsx stubs
 * them, so only the hub shell + rail render.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';

vi.mock('@/pages/tasks/views/DashboardView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/BoardView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/MyDayView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/ListView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/CalendarView', () => ({ default: () => <div /> }));
vi.mock('@/pages/tasks/views/HistoryView', () => ({ default: () => <div /> }));
vi.mock('@/components/tasks/AiCommandBar', () => ({ AiCommandBar: () => <div /> }));
vi.mock('@/components/tasks/CreateTaskModal', () => ({ CreateTaskModal: () => <div /> }));
vi.mock('@/components/tasks/TaskDetailDrawer', () => ({ TaskDetailDrawer: () => <div /> }));

import TasksHubPage from '@/pages/tasks/TasksHubPage';

const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

describe('TasksHubPage tab rail - TabStrip rendered contract', () => {
  it('renders the tab-rail testid wrapper, TabsList and TabsTrigger with the underline variant, no Card', async () => {
    vi.mocked(api).get.mockResolvedValue({ data: { tasks: [], users: [] } });
    renderWithProviders(<TasksHubPage />);

    // No Card: the testid wrapper's own class is empty (no bordered/shadowed surface),
    // and it carries no appearance styling of its own - see the disclosed-deviation note above.
    const wrapper = screen.getByTestId('tasks-tab-rail');
    expect(cls(wrapper)).toBe('');
    expect(wrapper.className).not.toContain('rounded-card');
    expect(wrapper.className).not.toContain('shadow-card');

    // TabStrip's own Tabs root is the wrapper's only child, carrying no className.
    const tabsRoot = wrapper.firstElementChild as HTMLElement;
    expect(cls(tabsRoot)).toBe('');

    const list = screen.getByRole('tablist');
    expect(list.parentElement).toBe(tabsRoot);
    // No listClassName equivalent on TabStrip - the rail's `border-b border-border` still
    // renders (TabsList's own default `variant="line"` base class), min-w-max/gap-1/p-0
    // are the disclosed, unreproduced axis.
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border');

    const dashboardTab = screen.getByRole('tab', { name: 'Dashboard' });
    expect(cls(dashboardTab)).toBe(
      'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
        'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative ' +
        'border-b-[3px] border-transparent text-sm font-medium text-text-secondary ' +
        'hover:text-text-primary data-[state=active]:border-primary data-[state=active]:text-primary ' +
        'data-[state=active]:font-semibold px-4 py-3'
    );

    // The visible panel now owns its own mt-4 (replacing the lost outer space-y-4 gap) -
    // same 16px margin-top, applied directly rather than via a shared parent.
    const activePanel = tabsRoot.querySelector('[role="tabpanel"]:not([hidden])');
    expect(cls(activePanel)).toContain('mt-4');

    // src/__tests__/setup.ts's global auth mock defaults to an ADMIN user, so the
    // canSeeHistory-gated History tab is present.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Dashboard',
      'Board',
      'My Day',
      'List',
      'Calendar',
      'History',
    ]);
  });
});
