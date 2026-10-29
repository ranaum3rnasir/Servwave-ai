import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

// The popover stack loads on the first tap, not with every page that has a Button.
const DisabledReasonBubble = React.lazy(() => import("./disabledReasonBubble"));

/**
 * Why an action is disabled, readable on a touch screen (mobile slice 40, rubric TOUCH-05).
 *
 * A disabled button swallows pointer events and a `title` never opens on touch, so a reason that
 * lives only in a title or a hover tooltip does not exist for a phone user. Both Button
 * components wrap a disabled button that carries a `disabledReason` in this shell:
 *
 * - the shell, not the dead button, takes the tap (the button keeps its native `disabled`, which
 *   gives it `pointer-events-none` in both kits, so the tap lands on the shell) and opens a small
 *   bubble with the reason, so one tap explains it. The bubble is its own chunk
 *   (disabledReasonBubble.tsx), loaded by that first tap, so no page pays for the popover stack
 *   just because it renders a Button (mobile slice 47);
 * - Enter / Space do the same for keyboard users (the shell is focusable);
 * - `title` stays on the shell, so a mouse still gets the reason on hover;
 * - the reason is also an sr-only description of the button, so a screen reader reads it with the
 *   button's name without needing to open anything.
 */
export function DisabledReasonShell({
  reason,
  descriptionId,
  block = false,
  children,
}: {
  reason: string;
  descriptionId: string;
  /** True when the wrapped button is full width: the shell then fills its row too. */
  block?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  // Set on the first tap and never cleared, so the bubble (once loaded) stays mounted and can
  // animate closed instead of vanishing.
  const [wanted, setWanted] = React.useState(false);
  const shellRef = React.useRef<HTMLSpanElement>(null);
  const toggle = () => {
    setWanted(true);
    setOpen((o) => !o);
  };

  return (
    <>
      <span
        ref={shellRef}
        tabIndex={0}
        data-disabled-reason-shell=""
        title={reason}
        className={cn("rounded-md", block ? "flex w-full" : "inline-flex")}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {children}
        <span id={descriptionId} className="sr-only">
          {reason}
        </span>
      </span>
      {wanted ? (
        <React.Suspense fallback={null}>
          <DisabledReasonBubble reason={reason} anchor={shellRef} open={open} onOpenChange={setOpen} />
        </React.Suspense>
      ) : null}
    </>
  );
}

/** A reason is shown only while the control is actually disabled. */
export function activeReason(
  disabled: boolean | undefined,
  reason: string | undefined | null,
): string | null {
  return disabled && reason && reason.trim() ? reason : null;
}
