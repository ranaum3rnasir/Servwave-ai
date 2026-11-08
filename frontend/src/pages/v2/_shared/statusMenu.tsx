import { Fragment, type ReactElement } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Check, ChevronDown } from 'lucide-react';

import { STATUS_REGISTRY, type StatusDomain } from '@/design-system/status-registry';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { cn } from '@/ui-kit/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { useMediaQuery } from '@/ui-kit/hooks/useMediaQuery';

import { statusVariantFor } from './statusChip';

/**
 * The dot that stands in for the chip inside the menu.
 *
 * One class per variant, written out in full rather than composed from the
 * variant name, because Tailwind scans source TEXT: a class assembled at
 * runtime from a template literal never appears in the source, so no rule is
 * ever generated for it and the dot renders transparent.
 */
const DOT: Record<ReturnType<typeof statusVariantFor>, string> = {
  green: 'bg-status-green',
  amber: 'bg-status-amber',
  red: 'bg-status-red',
  blue: 'bg-status-blue',
  slate: 'bg-status-slate',
  purple: 'bg-status-purple',
  teal: 'bg-status-teal',
  indigo: 'bg-status-indigo',
};

/** The primary pointer is a finger: no hover, so nothing may hide behind one. */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * One status in the menu, with what it means and whether it can be picked right now. The server
 * decides `available` and writes `reason` (lead status_options), so the menu holds no rules.
 */
export interface StatusMenuOption {
  value: string;
  /** False = shown locked: it cannot be picked. Omitted = pickable. */
  available?: boolean;
  /** What the status means, in plain words. Shown on a computer only. */
  description?: string;
  /** Why a locked status is locked. Shown on a computer only, after the meaning. */
  reason?: string | null;
}

export interface StatusMenuProps {
  domain: StatusDomain;
  /** The record's current status. */
  value: string;
  /**
   * Everything it can be set to, in lifecycle order. A bare string is today's plain entry: always
   * pickable, nothing to say.
   */
  options: readonly (string | StatusMenuOption)[];
  onValueChange: (status: string) => void;
  disabled?: boolean;
  /** Announced on the trigger, e.g. "Lead status". */
  label: string;
  className?: string;
}

/**
 * The meaning, then (when locked) the reason, as the tooltip body.
 *
 * The panel (ui/tooltip.tsx) uses the legacy `bg-surface-light text-text-primary` pair, which stays
 * light in the dark theme. The reason line therefore takes the legacy `text-text-secondary`, not a
 * v2 token such as `text-muted-foreground`, which flips pale in dark and was 2.57:1 on the panel.
 */
function Explanation({ description, reason }: { description?: string; reason?: string | null }) {
  return (
    <div className="max-w-64 space-y-1 text-[13px]">
      {description && <p>{description}</p>}
      {reason && <p className="text-text-secondary">{reason}</p>}
    </div>
  );
}

/**
 * Wraps `trigger` in a tooltip that opens on hover AND keyboard focus (Radix opens it on both).
 * The content is portalled out: the menu panel clips its own overflow, and a tooltip drawn inside
 * it would be cut off.
 */
function explained(trigger: ReactElement, description?: string, reason?: string | null, side?: 'right' | 'bottom') {
  if (!description && !reason) return trigger;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipPrimitive.Portal>
        <TooltipContent side={side} className="z-floating">
          <Explanation description={description} reason={reason} />
        </TooltipContent>
      </TooltipPrimitive.Portal>
    </Tooltip>
  );
}

/**
 * Change a record's status, from its detail page.
 *
 * WHY THIS IS NOT A ROW OF CHIPS. The previous control put the status chip
 * inside an outline Button and then listed the other statuses as bare chips,
 * one per menu row. Every row was therefore a saturated solid fill - six loud
 * pills stacked in a panel twice their width, left-aligned in all that space,
 * with the current one indistinguishable from the rest except by reading the
 * words. The chip is a good way to show ONE status on a dense row; it is a bad
 * way to show six at once, because a chip earns its colour by being the only
 * one in view.
 *
 * So the menu drops to a dot plus a label - the colour still carries the
 * lifecycle stage, at a weight that lets six of them sit together - and the
 * CURRENT value is marked by a check, which is what a picker is supposed to do
 * and what the chip list never did.
 *
 * The trigger keeps the dot and reads as a control: a bordered, chevroned
 * button sized like every other control on the header row, rather than a badge
 * with a chevron bolted to its side.
 *
 * Disabled loses the chevron AND the border, so a status the user cannot change
 * reads as a label. The kit's Button already greys a disabled control; what it
 * cannot know is that here there is nothing to click at all.
  *
 * Options may be plain status strings or `StatusMenuOption` objects. An object carries
 * `available` (false = locked), `description` (what the status means) and `reason` (why it is
 * locked). On a computer each row explains itself on hover and keyboard focus: the meaning, then
 * the reason when locked. A locked row stays focusable (aria-disabled, not disabled), cannot be
 * picked, and leaves the menu open. On a touch screen there is no hover, so the menu shows names
 * only and a locked row is just greyed out.
 */
export function StatusMenu({
  domain, value, options, onValueChange, disabled = false, label, className,
}: StatusMenuProps) {
  const entry = STATUS_REGISTRY[domain][value] ?? { label: value, intent: 'neutral' as const };
  const variant = statusVariantFor(domain, value);
  // No hover on a touch screen, so nothing is hidden behind one: names only, locked ones greyed.
  const touch = useMediaQuery(COARSE_POINTER_QUERY);
  const detailOf = (option: string | StatusMenuOption): StatusMenuOption =>
    typeof option === 'string' ? { value: option } : option;
  const currentDescription = options.map(detailOf).find((o) => o.value === value)?.description;

  if (disabled) {
    return (
      <span
        className={cn(
          'border-input text-foreground inline-flex h-8.5 items-center gap-2 rounded-md border border-dashed px-3 text-[13px] font-semibold',
          className,
        )}
      >
        <span className={cn('size-2 shrink-0 rounded-full', DOT[variant])} aria-hidden />
        <span className="sr-only">{label}: </span>
        {entry.label}
      </span>
    );
  }

  const triggerButton = (
    <Button variant="outline" size="sm" aria-label={`${label}: ${entry.label}`} className={className}>
      <span className={cn('size-2 shrink-0 rounded-full', DOT[variant])} aria-hidden />
      {entry.label}
      <ChevronDown className="text-subtle-foreground" />
    </Button>
  );

  // The button's own tooltip needs its trigger INSIDE the menu's trigger slot, so the tooltip root
  // wraps the whole menu and only the button is handed over as its trigger.
  const explainTrigger = !touch && Boolean(currentDescription);

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {explainTrigger ? <TooltipTrigger asChild>{triggerButton}</TooltipTrigger> : triggerButton}
      </DropdownMenuTrigger>

      {/* Width matched to the longest label ('Walkthrough Completed', semibold, plus its dot and
          check mark) rather than left at the menu's default, so no row wraps, the check column lines
          up and the panel is not three times the width of its contents. */}
      <DropdownMenuContent align="start" className="w-64">
        {options.map((raw) => {
          const option = detailOf(raw);
          const optionEntry = STATUS_REGISTRY[domain][option.value] ?? { label: option.value, intent: 'neutral' as const };
          const isCurrent = option.value === value;
          // The lead's own status is shown as the selected item, never as locked.
          const locked = option.available === false && !isCurrent;
          const item = (
            <DropdownMenuItem
              key={option.value}
              // A locked row stays focusable (aria-disabled, not disabled) so its tooltip can open.
              {...(locked ? { 'aria-disabled': 'true' as const } : {})}
              // A locked row swallows its own selection: preventDefault keeps the menu open.
              onSelect={locked ? (event) => event.preventDefault() : undefined}
              onClick={locked ? undefined : () => onValueChange(option.value)}
              className={cn('gap-2.5', isCurrent && 'font-semibold', locked && 'cursor-not-allowed opacity-50')}
            >
              <span
                className={cn('size-2 shrink-0 rounded-full', DOT[statusVariantFor(domain, option.value)])}
                aria-hidden
              />
              <span className="flex-1">{optionEntry.label}</span>
              {isCurrent && <Check className="text-brand size-4 shrink-0" aria-label="current" />}
            </DropdownMenuItem>
          );
          // A computer row explains itself; a touch screen has no hover, so it gets the bare name.
          if (touch) return item;
          return <Fragment key={option.value}>{explained(item, option.description, locked ? option.reason : null, 'right')}</Fragment>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <TooltipProvider delayDuration={200}>
      {explainTrigger ? (
        <Tooltip>
          {menu}
          <TooltipPrimitive.Portal>
            <TooltipContent side="bottom" className="z-floating">
              <Explanation description={currentDescription} />
            </TooltipContent>
          </TooltipPrimitive.Portal>
        </Tooltip>
      ) : (
        menu
      )}
    </TooltipProvider>
  );
}
