import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Plus } from 'lucide-react';

import { NewEstimateDialog } from '@/components/estimates/NewEstimateDialog';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

// `dialog` marks items that open a chooser instead of navigating (and so carry
// no `to`). New Estimate needs an anchor (lead/customer/job), so it opens
// NewEstimateDialog to pick one; a bare `/estimates/new` has nothing to create
// against and just bounces to the estimates list.
//
// Six items, same labels, same order, same destinations as the legacy menu -
// including `Request Payment`, which goes to the invoice LIST rather than to a
// payment form, because that is where it goes today.
const ITEMS: { label: string; to?: string; dialog?: 'estimate' }[] = [
  { label: 'New Lead', to: '/leads/new' },
  { label: 'New Estimate', dialog: 'estimate' },
  { label: 'New Job', to: '/jobs/new' },
  { label: 'New Task', to: '/tasks?action=new-task' },
  { label: 'New Invoice', to: '/invoices/new' },
  { label: 'Request Payment', to: '/invoices' },
];

/**
 * The dashboard's quick-create menu, on the kit's DropdownMenu.
 *
 * The legacy version hand-rolled the popover: a `role="menu"` div, six raw
 * buttons, and its own document `mousedown` / `Escape` listeners registered in
 * an effect. Radix owns all of that now - dismissal, focus return, typeahead
 * and roving focus - and the SELECTOR SURFACE is unchanged, which is what the
 * e2e suite reads: the trigger is still `role="button"` named `New`, and each
 * item is still `role="menuitem"` with its exact label.
 *
 * NO PERMISSION GATING, deliberately, exactly as before. Every role that can
 * reach the dashboard (ADMIN, DISPATCHER) sees all six; the gate is on the
 * destination route, not here. Adding a CASL check would change who can do
 * what, which is a behaviour change.
 *
 * Destinations are LEGACY paths, not `v2Path`-prefixed: none of these six
 * targets is a page this module owns, and `preferV2Path` is the layout's job
 * for navigation it can resolve. Sending `/jobs/new` into `/v2` before the Jobs
 * module lands would be a link to a route that does not exist.
 */
export function NewMenu() {
  const navigate = useNavigate();
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm">
            <Plus />
            New
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {ITEMS.map((it) => (
            <DropdownMenuItem
              key={it.label}
              onSelect={() => {
                if (it.dialog === 'estimate') { setEstimateDialogOpen(true); return; }
                if (it.to) navigate(it.to);
              }}
            >
              {it.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewEstimateDialog open={estimateDialogOpen} onOpenChange={setEstimateDialogOpen} />
    </>
  );
}
