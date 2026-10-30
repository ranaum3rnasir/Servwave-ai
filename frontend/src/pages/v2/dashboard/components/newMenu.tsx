import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Plus } from 'lucide-react';

import { NewEstimateDialog } from '@/components/estimates/NewEstimateDialog';
import { quickCreateItems, quickCreateItemShows, type QuickCreateItem } from '@/components/layout/nav-config';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useMySwitches } from '@/lib/api/mySwitches';
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
//
// Each item follows the same Create + View pair as its Create New item (Roles &
// Permissions S02.25): the pair is READ from `quickCreateItems` by label, never
// copied, so the two menus cannot drift apart. Request Payment creates nothing,
// so it follows View invoices alone.
type Gate = Pick<QuickCreateItem, 'view'> & Partial<Pick<QuickCreateItem, 'action' | 'subject'>>;

function sameAsCreateNew(label: string): Gate {
  const item = quickCreateItems.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`No Create New item labelled "${label}"`);
  return { action: item.action, subject: item.subject, view: item.view };
}

const ITEMS: { label: string; to?: string; dialog?: 'estimate'; gate: Gate }[] = [
  { label: 'New Lead', to: '/leads/new', gate: sameAsCreateNew('New Lead') },
  { label: 'New Estimate', dialog: 'estimate', gate: sameAsCreateNew('New Estimate') },
  { label: 'New Job', to: '/jobs/new', gate: sameAsCreateNew('New Job') },
  { label: 'New Task', to: '/tasks?action=new-task', gate: sameAsCreateNew('New Task') },
  { label: 'New Invoice', to: '/invoices/new', gate: sameAsCreateNew('New Invoice') },
  { label: 'Request Payment', to: '/invoices', gate: { view: sameAsCreateNew('New Invoice').view } },
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
 * Each item shows only when its Create ability and its page's View switch are
 * both on (Roles & Permissions S02.25), and the "New" button is not drawn when
 * no item is left. It is read from the person's own switches
 * (`useMySwitches`), and nothing is drawn until they have arrived.
 *
 * Destinations are LEGACY paths, not `v2Path`-prefixed: none of these six
 * targets is a page this module owns, and `preferV2Path` is the layout's job
 * for navigation it can resolve. Sending `/jobs/new` into `/v2` before the Jobs
 * module lands would be a link to a route that does not exist.
 */
export function NewMenu() {
  const navigate = useNavigate();
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);
  const ability = useAppAbility();
  const mySwitches = useMySwitches();

  const items = ITEMS.filter((it) =>
    quickCreateItemShows(it.gate, (action, subject) => ability.can(action, subject), mySwitches?.values));
  if (items.length === 0) return null;

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
          {items.map((it) => (
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
