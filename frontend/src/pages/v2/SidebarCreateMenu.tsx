import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { quickCreateItems } from '@/components/layout/nav-config';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useSidebar } from '@/ui-kit/components/layout/appShell';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import { NewEstimateDialog } from '@/pages/v2/estimates/components/newEstimateDialog';
import { CreateTaskDialog } from '@/pages/v2/tasks/components/createTaskDialog';

import { preferV2Path } from './uiV2';

/**
 * The global "Create New" action, pinned to the head of the sidebar.
 *
 * The list is `quickCreateItems` - imported from the shared nav module rather
 * than forked, filtered by the same `ability.can(action, subject)` check, so a
 * role that cannot create a Job never sees the row. Most hrefs are the app's
 * plain paths and are used as they are; `preferV2Path` around them is a no-op
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
 */
export function SidebarCreateMenu() {
  const ability = useAppAbility();
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const { isRail, isMobile, closeDrawer } = useSidebar();
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);

  const items = quickCreateItems.filter((item) => ability.can(item.action, item.subject));
  if (items.length === 0) return null;

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
            <DropdownMenuItem
              key={item.href}
              onSelect={() => {
                // A dirty settings form gets to intercept, exactly as it does for
                // every other navigation in this shell. On mobile the sidebar is
                // an overlay drawer, so it also has to get out of the way whether
                // the pick opens a dialog in place or leaves for another page.
                if (isMobile) closeDrawer();
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
              }}
            >
              <item.icon />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <NewEstimateDialog open={estimateDialogOpen} onOpenChange={setEstimateDialogOpen} />
      <CreateTaskDialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen} />
    </>
  );
}
