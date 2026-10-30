import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

import { ACTION_LABEL, ActionDialogs, ActionLabel, PHONE_TAP, actionVariant, useActionPress, visibleActions } from './attentionActions';
import type { AttentionItem } from '@/lib/api/paymentsPage';

/** Buttons shown beside the title; any more go behind "More". */
const SHOWN = 2;

/**
 * An item's actions in the card and the table: the first two as buttons (the first filled, the second outlined) and,
 * when there are more, a third outline "More" that opens the rest as a menu. Every button comes from the server's own
 * list for this caller, so one the viewer cannot use is absent, never disabled. A press on any of them stays on its
 * own: it never opens the row it sits in.
 */
export function AttentionRowActions({ item }: { item: AttentionItem }) {
  const { active, press, close } = useActionPress(item);
  const moreRef = useRef<HTMLButtonElement>(null);
  const actions = visibleActions(item);
  if (!actions.length) return null;
  const buttons = actions.slice(0, SHOWN);
  const more = actions.slice(SHOWN);
  return (
    <div className="flex flex-wrap gap-2 max-sm:w-full" onClick={(event) => event.stopPropagation()}>
      {buttons.map((id, i) => (
        <Button key={id} type="button" size="sm" variant={actionVariant(id, i)} className={PHONE_TAP} onClick={(event) => press(id, event.currentTarget)}>
          <ActionLabel id={id} />
        </Button>
      ))}
      {more.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={moreRef} type="button" size="sm" variant="outline" className={PHONE_TAP} aria-haspopup="menu">
              More
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {more.map((id) => (
              <DropdownMenuItem key={id} className="max-sm:min-h-11 min-h-9" onSelect={() => press(id, moreRef.current)}>
                {ACTION_LABEL[id]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ActionDialogs item={item} active={active} onClose={close} />
    </div>
  );
}
