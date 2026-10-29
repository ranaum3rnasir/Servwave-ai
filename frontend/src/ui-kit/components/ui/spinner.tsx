import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/ui-kit/lib/utils";

const spinnerVariants = cva("animate-spin text-current", {
  variants: {
    size: { sm: "size-3.5", default: "size-4", lg: "size-6", xl: "size-8" },
  },
  defaultVariants: { size: "default" },
});

export interface SpinnerProps
  extends React.ComponentProps<"svg">,
    VariantProps<typeof spinnerVariants> {
  /** Announced to screen readers; pass null for decorative spinners. */
  label?: string | null;
  /** Stroke width in the 24-unit viewBox. */
  weight?: number;
}

/**
 * A ring riding a visible track.
 *
 * The usual arc-only spinner is a fragment of a circle floating in space -
 * at 16px it reads unfinished. Drawing the full rail underneath gives the arc
 * something to travel along, so the motion reads deliberate.
 *
 * Reach for this only for short, local waits (a button, an inline row). For
 * content that is about to fill a known layout, use <Skeleton> instead: it
 * previews the structure and measurably lowers perceived wait. Never run both
 * at once.
 */
function Spinner({
  className,
  size,
  label = "Loading",
  weight = 2.5,
  ...props
}: SpinnerProps) {
  const radius = (24 - weight) / 2 - 1;
  const circumference = 2 * Math.PI * radius;

  return (
    <>
      <svg
        data-slot="spinner"
        className={cn(spinnerVariants({ size }), className)}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        {...props}
      >
        <circle
          cx="12" cy="12" r={radius}
          stroke="currentColor" strokeWidth={weight} opacity={0.18}
        />
        <circle
          cx="12" cy="12" r={radius}
          stroke="currentColor" strokeWidth={weight} strokeLinecap="round"
          strokeDasharray={`${circumference * 0.28} ${circumference}`}
        />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  );
}

export { Spinner, spinnerVariants };
