/**
 * AddStepButton - the `+` that grows the flow. One picker, exactly four node
 * types (Wait / Send text / Send email / Stop if), each an icon + label +
 * one-line description, so smallness is visible. Rendered three ways: a circular
 * `+` on the rail between bubbles, a dashed "Add a step" at the tail, and a
 * friendly "Add your first step" bubble for the empty flow.
 *
 * There is deliberately no in-app option. In-app notifications come from the
 * bell, which is rule-governed rather than authored per workflow, so offering
 * a step for them would hand admins a second, contradictory control over the
 * same channel. Historic in-app steps still RENDER (see workflow-visuals);
 * only the offer is gone.
 *
 * Locked types (see lib/workflows/featureFlags): a locked row still appears —
 * so the product's shape stays visible — but greyed, badged "Not connected",
 * and un-pickable, with a tooltip on hover/focus. Today only SEND_TEXT can be
 * locked, per-org, until that org connects texting (CTM).
 */

import { useState } from 'react';
import { Plus, Lock } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { StepTypeTile } from './workflow-visuals';
import { DEFAULT_LOCKED_STEP_TYPES, DEFAULT_STEP_LOCK_COPY, type StepLockCopy } from '@/lib/workflows/featureFlags';
import type { AuthorableStepType, WorkflowStepType } from '@/lib/api/workflows';

// Typed by the AUTHORABLE union, not the wider storage one. The storage union
// still legitimately carries the retired label (the Postgres enum keeps every
// label it has ever had, so historic rows resolve), so typing the picker by it
// would let a retired row be added back here and still compile.
const PICKER: { type: AuthorableStepType; label: string; description: string }[] = [
  { type: 'WAIT', label: 'Wait', description: 'Pause before the next step' },
  { type: 'SEND_TEXT', label: 'Send text', description: 'Text the customer' },
  { type: 'SEND_EMAIL', label: 'Send email', description: 'Branded email to the customer' },
  { type: 'STOP_IF', label: 'Stop if…', description: 'End the flow when a condition is met' },
];

export interface AddStepButtonProps {
  onPick: (type: WorkflowStepType) => void;
  variant?: 'rail' | 'block' | 'first';
  /** Accessible name for the trigger (rail buttons repeat down the spine). */
  label?: string;
  /** Step types that can't be authored yet - rendered greyed + a lock badge. */
  lockedTypes?: WorkflowStepType[];
  /** Why they are locked, in the office's words. Defaults to the per-org texting reason. */
  lockedCopy?: StepLockCopy;
}

export default function AddStepButton({
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

  const trigger =
    variant === 'rail' ? (
      // Deferred: tried Button (variant={null} size="icon", the button itself
      // carries no colour of its own - every visual state lives on the inner
      // `span` via `group`/`group-data-[state=open]`), but reproducing the
      // 44px CIRCLE (and keeping the focus-visible ring circular, since a
      // ring's shape follows the element's own corner radius) needs a
      // call-site `rounded-full` override - Button's own base string always
      // ships `rounded-button` (14px, deliberately different - see
      // button.tsx's radii comment), and a call-site radius override is
      // exactly what the separate layering-guard hard-appearance ratchet
      // (ceiling 29, unrelated to this batch) forbids increasing. Left raw
      // rather than regress that ratchet.
      <button
        type="button"
        aria-label={label}
        className="group flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full border-[1.5px] border-border bg-surface-light text-primary shadow-soft transition-colors group-hover:border-primary group-data-[state=open]:border-primary group-data-[state=open]:bg-primary group-data-[state=open]:text-on-fill">
          <Plus className="h-4 w-4" aria-hidden />
        </span>
      </button>
    ) : variant === 'first' ? (
      // Deferred (not a clean variant/tone map): this "dashed add-step CTA"
      // family (dashed border, translucent bg-surface-light/60, idle
      // text-primary, hover retints the border+bg but not the text) has no
      // matching Button cell - the closest, outline/neutral, is a solid
      // border with no idle text colour and a different hover target, so
      // forcing it would change the rendered look rather than reproduce it.
      <button
        type="button"
        className="flex min-h-11 w-full max-w-[468px] items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed border-border bg-surface-light/60 px-4 py-5 text-sm font-semibold text-primary transition-colors hover:border-primary hover:bg-surface-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <Plus className="h-4 w-4" aria-hidden />
        Add your first step
      </button>
    ) : (
      // Deferred - same dashed add-step CTA family as the 'first' variant
      // above, same reason.
      <button
        type="button"
        className="inline-flex min-h-11 items-center gap-2 rounded border-[1.5px] border-dashed border-border bg-surface-light/60 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:border-primary hover:bg-surface-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <Plus className="h-4 w-4" aria-hidden />
        Add a step
      </button>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="center" className="w-[300px] p-0" role="menu" aria-label="Add a step">
        <p className="border-b border-border bg-table-header px-3.5 py-2.5 text-[11px] font-bold uppercase tracking-wide text-text-secondary">
          Add a step — pick one
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
                      className="flex w-full cursor-not-allowed items-center gap-3 px-3.5 py-2.5 text-left opacity-60 focus-visible:bg-background-light focus-visible:outline-none"
                    >
                      <StepTypeTile type={item.type} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-text-primary">{item.label}</span>
                          <span className="inline-flex items-center gap-1 rounded-pill bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                            <Lock className="h-2.5 w-2.5" aria-hidden />
                            {lockedCopy.badge}
                          </span>
                        </span>
                        <span className="block text-[11.5px] text-text-secondary">{item.description}</span>
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right">{lockedCopy.tooltip}</TooltipContent>
                </Tooltip>
              ) : (
                // Deferred: a dropdown menu item row (role="menuitem",
                // full-width, icon + two-line label) - the exact non-Button
                // shape the program calls out, not a CTA.
                <button
                  key={item.type}
                  type="button"
                  role="menuitem"
                  onClick={() => pick(item.type)}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-background-light focus-visible:bg-background-light focus-visible:outline-none"
                >
                  <StepTypeTile type={item.type} size="sm" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-text-primary">{item.label}</span>
                    <span className="block text-[11.5px] text-text-secondary">{item.description}</span>
                  </span>
                </button>
              ),
            )}
          </div>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}
