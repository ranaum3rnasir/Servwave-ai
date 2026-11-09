import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { quickCreateItems, quickCreateItemShows } from '@/components/layout/nav-config';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useMySwitches } from '@/lib/api/shared/mySwitches';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useSidebar } from '@/ui-kit/components/layout/appShell';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import { preferV2Path } from './uiV2';

// The two create dialogs are lazy chunks (mobile slice 47). They sit in the staff layout, so
// importing them here put each one, and everything under them (the date picker, the chunked
// upload client behind the task dialog's file attachments, the customer pickers), in the first
// script every staff page downloads. They are fetched once the page has settled, long before
// anyone taps Create New, and mounted the first time they are asked for.
const loadEstimateDialog = () => import('@/pages/v2/estimates/components/newEstimateDialog');
const loadTaskDialog = () => import('@/pages/v2/tasks/components/createTaskDialog');
const NewEstimateDialog = lazy(() =>
  loadEstimateDialog().then((m) => ({ default: m.NewEstimateDialog })),
);
const CreateTaskDialog = lazy(() =>
  loadTaskDialog().then((m) => ({ default: m.CreateTaskDialog })),
);

/** True from the first time `open` is true, for good: a dialog that has been opened stays mounted. */
function useMountedOnceOpened(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  // Adjusting state while rendering (not in an effect): the flag is derived from `open`.
  if (open && !opened) setOpened(true);
  return open || opened;
}

/**
 * The global "Create New" action, pinned to the head of the sidebar.
 *
 * The list is `quickCreateItems` - imported from the shared nav module rather
 * than forked. An item shows only when its Create ability (`ability.can(action,
 * subject)`) AND its page's Show switch are both on (Roles & Permissions S02.24),
 * so a person who cannot create a Job, or whose Jobs page is not shown, never
 * sees the row. Show is display only, so it is read from the person's own
 * switches (`useMySwitches`), and nothing is drawn until they have arrived.
 * Most hrefs are the app's plain paths and are used as they are; `preferV2Path`
 * around them is a no-op
 * shim left in place, not a rewrite (see `uiV2.ts`). New Estimate and New Task
 * are the two exceptions - their hrefs are `?action=` handshakes meant for a
 * module list page (still used by deep links and the legacy sidebar), so here
 * they open the same kit dialog those pages open instead of navigating there
 * and back (SRVW-268).
 *
 * Its own component, not markup inside V2AppLayout, because it needs
 * `useSidebar()` - which only resolves for a component RENDERED inside AppShell.
 * V2AppLayout builds the sidebar element but is itself outside the provider.
 *
 * Rail mode collapses it to the same 38px square as a nav row and moves the
 * label into a tooltip, matching SidebarItem exactly; the geometry is in
 * shell.css under `.sb-create`.
 *
 * In the navigation drawer (phones and landscape phones) the list does not fly
 * out to the right: a menu anchored at x 240-448 runs off a 320 px screen. It
 * expands in place instead, as a full-width list of rows under the button.
 */
export function SidebarCreateMenu() {
  const ability = useAppAbility();
  const mySwitches = useMySwitches();
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const { isRail, isDrawer, closeDrawer } = useSidebar();
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const estimateDialogMounted = useMountedOnceOpened(estimateDialogOpen);
  const taskDialogMounted = useMountedOnceOpened(taskDialogOpen);

  useEffect(() => {
    const warm = () => {
      void loadEstimateDialog().catch(() => {});
      void loadTaskDialog().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(warm, { timeout: 6000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = setTimeout(warm, 2500);
    return () => clearTimeout(handle);
  }, []);

  const items = quickCreateItems.filter((item) =>
    quickCreateItemShows(item, (action, subject) => ability.can(action, subject), mySwitches?.values));
  if (items.length === 0) return null;

  // A dialog opened from the drawer lives in THIS component, which the drawer unmounts when it
  // shuts. So the drawer stays open under the dialog and goes away once the dialog is dismissed.
  const onDialogOpenChange = (set: (open: boolean) => void) => (open: boolean) => {
    set(open);
    if (!open && isDrawer) closeDrawer();
  };

  function pick(item: (typeof items)[number]) {
    // A dirty settings form gets to intercept, exactly as it does for every other navigation in
    // this shell. In the navigation drawer a pick that leaves for another page also has to get the
    // drawer out of the way; a pick that opens a dialog in place keeps it (see above).
    const opensDialog = item.subject === 'Estimate' || item.subject === 'Task';
    if (isDrawer && !opensDialog) closeDrawer();
    // Estimate and Task are modal-backed: their href is a handshake
    // for the module list page, which this menu can skip by opening
    // the same dialog directly (SRVW-268).
    //
    // Only Estimate is routed through requestLeave: its dialog
    // navigates on its SELECTION paths (new estimate, new lead,
    // existing lead/customer picks all call useNavigate), so a
    // dirty settings form still needs the chance to intercept
    // those. It does NOT navigate on its DISMISS paths - the X
    // button, Escape, outside-click all just call onOpenChange
    // (false) via Radix's own Dialog - so requestLeave still
    // wraps a no-op there and Discard on that path wipes unsaved
    // settings edits for a navigation that never happens, same
    // shape as the Task bug below, just narrower. Not fixed here;
    // tracked on SRVW-268. Task's dialog navigates nowhere at
    // all - no useNavigate, no react-router import - so opening
    // it is not a navigation and must not run requestLeave: doing
    // so made Discard wipe unsaved settings edits for a
    // navigation that never happens, and Keep editing made the
    // shortcut a silent no-op.
    if (item.subject === 'Estimate') {
      requestLeave(() => setEstimateDialogOpen(true));
      return;
    }
    if (item.subject === 'Task') {
      setTaskDialogOpen(true);
      return;
    }
    // Ported modules keep the user in v2; the rest still open their
    // legacy page, which is the only one they have.
    requestLeave(() => navigate(preferV2Path(item.href)));
  }

  const dialogs = (
    <>
      {estimateDialogMounted && (
        <Suspense fallback={null}>
          <NewEstimateDialog open={estimateDialogOpen} onOpenChange={onDialogOpenChange(setEstimateDialogOpen)} />
        </Suspense>
      )}
      {taskDialogMounted && (
        <Suspense fallback={null}>
          <CreateTaskDialog open={taskDialogOpen} onOpenChange={onDialogOpenChange(setTaskDialogOpen)} />
        </Suspense>
      )}
    </>
  );

  if (isDrawer) {
    return (
      <div className="sb-create-block">
        <Button
          size="sm"
          className="sb-create"
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
        >
          <Plus />
          <span className="sb-label">Create New</span>
          <ChevronDown aria-hidden className={listOpen ? 'sb-create-chevron is-open' : 'sb-create-chevron'} />
        </Button>
        {listOpen && (
          <ul className="sb-create-list">
            {items.map((item) => (
              <li key={item.href}>
                <button type="button" className="sb-create-row" onClick={() => pick(item)}>
                  <item.icon aria-hidden />
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        {dialogs}
      </div>
    );
  }

  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button size="sm" className="sb-create">
        <Plus />
        <span className="sb-label">Create New</span>
      </Button>
    </DropdownMenuTrigger>
  );

  return (
    <>
      <DropdownMenu>
        {isRail ? (
          <Tooltip>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side="right">Create New</TooltipContent>
          </Tooltip>
        ) : (
          trigger
        )}

        {/* To the right of the column, like legacy - a menu that dropped below
            would cover the first nav group it sits on top of. */}
        <DropdownMenuContent side="right" align="start">
          {items.map((item) => (
            <DropdownMenuItem key={item.href} onSelect={() => pick(item)}>
              <item.icon />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialogs}
    </>
  );
}
