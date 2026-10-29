import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from '@/lib/utils';

/**
 * Loading placeholder. Call sites say what SHAPE is loading, never which
 * radius: 34 of them used to hand-roll `rounded-card` / `rounded-md` /
 * `rounded-full`, which is 34 places to edit when the radius scale moves.
 *
 * No `size` prop here (W2 vocabulary repair - VOCAB_V3 rule 2: "size is an
 * ABSOLUTE ladder... size='sm' is ALWAYS 36px, on every primitive that has
 * the prop", six rungs, 24-44px only). The 108 measured call sites hand-roll
 * a height utility across four values - `h-3` (12px) x14, `h-4` (16px) x33,
 * `h-8` (32px) x8, `h-16` (64px) x7 - and three of those four fall
 * completely outside the vocabulary's 24-44px range; only 32px coincides
 * with a real rung (`xs`), and even that is a coincidence of one measured
 * value, not "measured demand" for the ladder as a control-height concept
 * (Skeleton has no control to size - it is a passive placeholder). Rather
 * than mint a size scale that mislabels non-conforming pixel values onto
 * vocabulary rung names, or carve out an undocumented exemption, height
 * stays exactly what it was before this pass: fully caller-owned via
 * `className`, same as every one of the 108 call sites already does.
 *
 * `shape` is NOT part of the closed variant/tone/size/gap/pad vocabulary -
 * block-vs-circle is a geometry choice with no colour or spacing content, so
 * it stays its own axis, unchanged by this pass.
 */
export type SkeletonShape = 'block' | 'circle';

const skeletonVariants = cva('animate-pulse bg-background-light', {
  variants: {
    /** `block` is any rectangular placeholder; `circle` is an avatar or dot. */
    shape: {
      block: 'rounded-card',
      circle: 'rounded-full',
    },
  },
  defaultVariants: {
    shape: 'block',
  },
});

export interface SkeletonProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof skeletonVariants> {}

export function Skeleton({ className, shape, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(skeletonVariants({ shape }), className)}
      {...props}
    />
  );
}
