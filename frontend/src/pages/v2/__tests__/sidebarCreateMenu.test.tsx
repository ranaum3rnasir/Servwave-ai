/// <reference types="@testing-library/jest-dom/vitest" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { AppShell } from '@/ui-kit/components/layout/appShell';

import { SidebarCreateMenu } from '../SidebarCreateMenu';

/**
 * SRVW-268 - New Estimate and New Task are modal-backed quick-create picks.
 *
 * `nav-config.ts` gives both a `?action=` href meant for a module list page
 * to read and turn into a dialog open. Before the fix, SidebarCreateMenu
 * navigated there for every item, so picking either yanked the user away to
 * the list page instead of opening the dialog in place. The other four
 * shortcuts point at real pages and must keep navigating.
 *
 * The two dialogs are stubbed open-aware, the same way
 * `tasks-quick-create.test.tsx` stubs `CreateTaskModal` - this suite is
 * about SidebarCreateMenu's own wiring, not the dialogs' internals.
 */
vi.mock('@/pages/v2/estimates/components/newEstimateDialog', () => ({
  NewEstimateDialog: ({ open }: { open: boolean }) =>
    (open ? <div data-testid="new-estimate-dialog-open" /> : null),
}));
vi.mock('@/pages/v2/tasks/components/createTaskDialog', () => ({
  CreateTaskDialog: ({ open }: { open: boolean }) =>
    (open ? <div data-testid="create-task-dialog-open" /> : null),
}));

/** Reports the current pathname so a test can assert whether a pick navigated. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderMenu(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>
        <MemoryRouter initialEntries={[entry]}>
          <AppShell sidebar={<SidebarCreateMenu />} topbar={<div />}>
            <LocationProbe />
          </AppShell>
        </MemoryRouter>
      </AbilityProvider>
    </QueryClientProvider>,
  );
}

async function openMenuAndPick(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Create New' }));
  await user.click(screen.getByRole('menuitem', { name: label }));
}

describe('SidebarCreateMenu (SRVW-268)', () => {
  it('opens the New Estimate dialog in place, without navigating', async () => {
    renderMenu();

    await openMenuAndPick('New Estimate');

    expect(screen.getByTestId('new-estimate-dialog-open')).toBeInTheDocument();
    // Anchored: toHaveTextContent('/') substring-matches every path, so it would
    // also pass if the dialog opened AND the user was navigated away - which is
    // the exact defect SRVW-268 reports.
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/$/);
  });

  it('opens the New Task dialog in place, without navigating', async () => {
    renderMenu();

    await openMenuAndPick('New Task');

    expect(screen.getByTestId('create-task-dialog-open')).toBeInTheDocument();
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/$/);
  });

  it('still navigates for New Lead, a real page', async () => {
    renderMenu();

    await openMenuAndPick('New Lead');

    expect(screen.getByTestId('pathname')).toHaveTextContent('/leads/new');
    expect(screen.queryByTestId('new-estimate-dialog-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-task-dialog-open')).not.toBeInTheDocument();
  });

  describe('the settings guard, and Task not needing it', () => {
    beforeEach(() => {
      useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
    });

    it('opens New Task immediately with a dirty settings form - opening a dialog is not leaving', async () => {
      // Regression: the Task branch used to run through requestLeave on the
      // reasoning that "both dialogs navigate internally after a pick" - true
      // for Estimate, false for Task (no useNavigate, no react-router import at
      // all). Routing it through the guard meant Create New > New Task >
      // Discard wiped unsaved settings edits for a navigation that never
      // happens, and Keep editing made the shortcut a silent no-op.
      useSettingsGuard.setState({ isDirty: true });
      renderMenu();

      await openMenuAndPick('New Task');

      expect(screen.getByTestId('create-task-dialog-open')).toBeInTheDocument();
      expect(useSettingsGuard.getState().pendingLeave).toBeNull();
    });

    it('still defers New Estimate to the guard with a dirty settings form', async () => {
      // Estimate's dialog does navigate internally on every terminal pick, so
      // it keeps requestLeave: the dialog must NOT open until the guard's
      // confirm dialog resolves the stashed leave.
      useSettingsGuard.setState({ isDirty: true });
      renderMenu();

      await openMenuAndPick('New Estimate');

      expect(screen.queryByTestId('new-estimate-dialog-open')).not.toBeInTheDocument();
      expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
    });
  });
});
