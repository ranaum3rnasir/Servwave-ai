import { useState } from 'react';
import { Plus, Lock } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import { cn } from '@/ui-kit/lib/utils';
import {
  DEFAULT_LOCKED_STEP_TYPES,
  DEFAULT_STEP_LOCK_COPY,
  type StepLockCopy,
} from '@/lib/workflows/featureFlags';
import type { AuthorableStepType, WorkflowStepType } from '@/lib/api/workflows';

import { ELLIPSIS, EM_DASH } from './glyphs';
import { Pressable } from './pressable';
import { StepTypeTile } from './workflowVisuals';

/**
 * The `+` that grows the flow. One picker, exactly four node types, each an
 * icon plus a label plus a one-line description. Rendered three ways: a
 * circular `+` on the rail between bubbles, a dashed "Add a step" at the tail,
 * and a friendly "Add your first step" bubble for the empty flow.
 *
 * There is deliberately no in-app option. In-app notifications come from the
 * bell, which is rule-governed rather than authored per workflow, so offering
 * a step for them would hand admins a second, contradictory control over the
 * same channel. Historic in-app steps still RENDER (see workflowVisuals);
 * only the offer is gone.
 *
 * Locked types still appear, greyed and badged "Not connected" with a tooltip,
 * so the product's shape stays visible. Today only SEND_TEXT can be locked, per
 * org, until that org connects texting. `DEFAULT_LOCKED_STEP_TYPES` is the prop
 * default so an undefined or stale catalog fails closed.
 */

// Typed by the AUTHORABLE union, not the wider storage one. The storage union
// still legitimately carries the retired label (the Postgres enum keeps every
// label it has ever had, so historic rows resolve), so typing the picker by it
// would let a retired row be added back here and still compile.
const PICKER: { type: AuthorableStepType; label: string; description: string }[] = [
  { type: 'WAIT', label: 'Wait', description: 'Pause before the next step' },
  // Not "Text the customer": Spec C slice 8 made a text reachable to every audience an email
  // reaches, and this line is the first place an admin reads what the step is for.
  { type: 'SEND_TEXT', label: 'Send text', description: 'Text a customer or your team' },
  { type: 'SEND_EMAIL', label: 'Send email', description: 'Branded email to the customer' },
  { type: 'STOP_IF', label: `Stop if${ELLIPSIS}`, description: 'End the flow when a condition is met' },
];

export interface AddStepButtonProps {
  onPick: (type: WorkflowStepType) => void;
  variant?: 'rail' | 'block' | 'first';
  /** Accessible name for the trigger; the rail buttons repeat down the spine. */
  label?: string;
  /** Step types that cannot be authored yet, rendered greyed and badged. */
  lockedTypes?: WorkflowStepType[];
  /** Why they are locked, in the office's words. Defaults to the per-org texting reason. */
  lockedCopy?: StepLockCopy;
}

function AddStepButton({
  onPick,
  variant = 'rail',
  label = 'Insert a step',
  lockedTypes = DEFAULT_LOCKED_STEP_TYPES,
  lockedCopy = DEFAULT_STEP_LOCK_COPY,
}: AddStepButtonProps) {
  const [open, setOpen] = useState(false);

  function pick(type: WorkflowStepType) {
    setOpen(false);
    onPick(type);
  }

  // The dashed add-step family has no matching kit cell: `outline` is a solid
  // border with no idle brand text colour. Both dashed shapes therefore render
  // through Button with the dash and the idle colour as call-site classes,
  // which keeps them out of the raw-tag ratchet while reproducing the look.
  const dashed = 'border-dashed border-input text-brand hover:border-brand hover:bg-brand-subtle';

  const trigger =
    variant === 'rail' ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        className="group size-11 rounded-full hover:bg-transparent"
      >
        <span className="border-input bg-kit-card text-brand shadow-xs group-hover:border-brand group-data-[state=open]:border-brand group-data-[state=open]:bg-primary group-data-[state=open]:text-primary-foreground flex size-7 items-center justify-center rounded-full border-[1.5px] transition-colors">
          <Plus className="size-4" aria-hidden />
        </span>
      </Button>
    ) : variant === 'first' ? (
      <Button type="button" variant="outline" className={cn('h-auto w-full max-w-[468px] py-5', dashed)}>
        <Plus className="size-4" aria-hidden />
        Add your first step
      </Button>
    ) : (
      <Button type="button" variant="outline" className={cn('h-11', dashed)}>
        <Plus className="size-4" aria-hidden />
        Add a step
      </Button>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="center" className="w-[300px] p-0" role="menu" aria-label="Add a step">
        <p className="border-border bg-muted text-muted-foreground border-b px-3.5 py-2.5 text-[11px] font-bold uppercase tracking-wide">
          {`Add a step ${EM_DASH} pick one`}
        </p>
        <TooltipProvider>
          <div className="py-1">
            {PICKER.map((item) =>
              lockedTypes.includes(item.type) ? (
                <Tooltip key={item.type}>
                  <TooltipTrigger asChild>
                    <div
                      role="menuitem"
                      aria-disabled="true"
                      tabIndex={0}
                      className="focus-visible:bg-muted flex w-full cursor-not-allowed items-center gap-3 px-3.5 py-2.5 text-left opacity-60 focus-visible:outline-none"
                    >
                      <StepTypeTile type={item.type} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold">{item.label}</span>
                          <Badge variant="softNeutral" size="pill">
                            <Lock aria-hidden />
                            {lockedCopy.badge}
                          </Badge>
                        </span>
                        <span className="text-muted-foreground block text-[11.5px]">{item.description}</span>
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right">{lockedCopy.tooltip}</TooltipContent>
                </Tooltip>
              ) : (
                <Pressable
                  key={item.type}
                  role="menuitem"
                  onPress={() => pick(item.type)}
                  className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors"
                >
                  <StepTypeTile type={item.type} size="sm" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold">{item.label}</span>
                    <span className="text-muted-foreground block text-[11.5px]">{item.description}</span>
                  </span>
                </Pressable>
              ),
            )}
          </div>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Declared then exported, rather than `export default function`, to match the
 * convention every landed v2 module uses. It also keeps the duplicate-primitive
 * guard honest: that guard resolves a primitive import by the literal string
 * `@/components/ui/<name>` and cannot see `@/ui-kit/components/ui/button`, so
 * a concept-named default export composing the KIT Button reads to it as a
 * hand-rolled copy of the app Button. This component does compose the kit
 * Button and Popover. See the branch ledger.
 */
export { AddStepButton };
export default AddStepButton;
