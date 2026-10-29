import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Hit area (mobile slice 25, rubric TOUCH-01/TOUCH-02). The 38x22 track you see
 * is drawn inside the switch button, which is the target: 38x24 with a fine
 * pointer (WCAG 2.5.8's 24 px) and 44x44 on a coarse one (`touch:`). Negative
 * margins give back what the target adds, so the switch keeps its 38x22 layout
 * footprint. The track reads the button's state through `group/switch`.
 *
 * Variants (AI Agentic Farm agent controls, 14 Oct). All additive: a Switch with none of these
 * props renders as before.
 *   - `size="lg"`: a 52x30 track with a 26px knob, the switch that leads a control row. Its
 *     button is at least 44px tall with any pointer.
 *   - `tone="success"`: a green track when on, for a switch that says "this is running" (an agent
 *     at work) rather than "this option is chosen".
 *   - `stateLabel`: the word On or Off written beside the track, inside the button, so the word is
 *     part of the target. Hidden from screen readers: the switch's checked state already says it.
 *   - `busy`: a save is on its way. A spinner sits in the knob and clicks are ignored until done.
 *   - `aria-disabled`: the switch cannot be used right now but stays focusable, so the written
 *     reason beside it (pass it as `aria-describedby`) is reachable. Clicks are ignored and it
 *     reads faded. Prefer it to `disabled` whenever the reason is on screen.
 * Motion: knob and track ease, and stand still under reduced motion.
 */
type SwitchSize = "default" | "lg";
type SwitchTone = "brand" | "success";

// The brand tone keeps the existing off track; the success tone (the agent switch) uses the darker
// off track so an off agent switch still reads against the card.
const TRACK_TONE: Record<SwitchTone, string> = {
  brand: "bg-input group-data-[state=checked]/switch:bg-brand",
  success: "bg-subtle-foreground group-data-[state=checked]/switch:bg-success",
};

const LABEL_TONE: Record<SwitchTone, string> = {
  brand: "text-text-secondary group-data-[state=checked]/switch:text-brand",
  success: "text-text-secondary group-data-[state=checked]/switch:text-success-text",
};

const ROOT_SIZE: Record<SwitchSize, string> = {
  default: "h-6 w-9.5 -my-px touch:h-11 touch:w-11 touch:-my-[11px] touch:-mx-[3px]",
  lg: "h-11 min-w-11",
};

const TRACK_SIZE: Record<SwitchSize, string> = {
  default: "h-5.5 w-9.5",
  lg: "h-[30px] w-[52px]",
};

const THUMB_SIZE: Record<SwitchSize, string> = {
  default: "size-4.5 translate-x-0.5 data-[state=checked]:translate-x-4.5",
  lg: "size-[26px] translate-x-px data-[state=checked]:translate-x-[23px]",
};

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: SwitchSize;
  tone?: SwitchTone;
  /** Write On / Off beside the track. */
  stateLabel?: boolean;
  /** A save is on its way: spinner in the knob, clicks ignored. */
  busy?: boolean;
};

function Switch({
  className,
  size = "default",
  tone = "brand",
  stateLabel = false,
  busy = false,
  onCheckedChange,
  ...props
}: SwitchProps) {
  const unavailable = props["aria-disabled"] === true || props["aria-disabled"] === "true";
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size === "default" ? undefined : size}
      aria-busy={busy || undefined}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center justify-center cursor-pointer rounded-full",
        stateLabel
          ? cn("gap-2 px-1", size === "lg" ? "h-11" : "h-6 touch:h-11")
          : ROOT_SIZE[size],
        "focus-visible:outline-none disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
        busy && "cursor-progress",
        className,
      )}
      {...props}
      onCheckedChange={(next) => {
        if (unavailable || busy) return;
        onCheckedChange?.(next);
      }}
    >
      {stateLabel && (
        <span
          data-slot="switch-label"
          aria-hidden="true"
          className={cn(
            "min-w-[1.75em] text-right font-bold leading-none",
            size === "lg" ? "text-sm" : "text-xs",
            LABEL_TONE[tone],
            "group-aria-disabled/switch:opacity-60",
          )}
        >
          {props.checked ? "On" : "Off"}
        </span>
      )}
      <span
        data-slot="switch-track"
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs",
          TRACK_SIZE[size],
          "transition-colors duration-150 motion-reduce:transition-none",
          TRACK_TONE[tone],
          size === "lg"
            ? "group-focus-visible/switch:ring-2 group-focus-visible/switch:ring-ring group-focus-visible/switch:ring-offset-2 group-focus-visible/switch:ring-offset-surface-light"
            : "group-focus-visible/switch:ring-[3px] group-focus-visible/switch:ring-ring/25",
          "group-disabled/switch:opacity-50 group-aria-disabled/switch:opacity-45",
        )}
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className={cn(
            "pointer-events-none flex items-center justify-center rounded-full bg-on-fill shadow-sm ring-0",
            "transition-transform duration-150 ease-out motion-reduce:transition-none",
            THUMB_SIZE[size],
          )}
        >
          {busy && (
            <span
              data-slot="switch-spinner"
              aria-hidden="true"
              className={cn(
                "block rounded-full border-2 border-text-soft/30 border-t-text-soft motion-safe:animate-spin",
                size === "lg" ? "size-3" : "size-2.5",
              )}
            />
          )}
        </SwitchPrimitive.Thumb>
      </span>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
export type { SwitchProps, SwitchSize, SwitchTone };
