import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The kit's type ramp for headings. These are the sizes the kit already
 * renders, not new ones: `2xl` is byte-for-byte the `<h1>` inside
 * `layout/pageHeader`, and the rest are the rungs `pages/v2/reports/
 * components/heading.tsx` settled on while hand-rolling this component.
 */
const scaleClasses = {
  sm: "text-[13px] font-semibold tracking-[-0.01em]",
  base: "text-[14.5px] font-semibold tracking-[-0.015em]",
  lg: "text-[16px] font-bold tracking-[-0.02em]",
  xl: "text-[19px] font-bold tracking-[-0.026em]",
  "2xl": "text-[23px] font-bold tracking-[-0.032em]",
  /** No type classes at all - the container decides. See CardTitle. */
  inherit: "",
} as const;

export type HeadingScale = keyof typeof scaleClasses;

/**
 * What a level looks like when the call site does not say. Descending, because
 * a kit heading is authored fresh rather than measured off existing markup -
 * a caller that needs the outline and the size to disagree passes `scale`.
 */
const defaultScale: Record<HeadingLevel, HeadingScale> = {
  1: "2xl",
  2: "xl",
  3: "lg",
  4: "base",
  5: "sm",
  6: "sm",
};

export interface HeadingProps extends React.ComponentProps<"h2"> {
  /**
   * Document-outline position - which `<hN>` element renders, and what a
   * screen reader announces. Defaults to 2: `layout/pageHeader` owns the page
   * `<h1>`, so a heading authored inside a page is a section under it.
   */
  level?: HeadingLevel;
  /**
   * Visual size, independent of `level`. Omit it to take the level's rung;
   * pass `inherit` when the surrounding component already sets the type, which
   * is how `CardTitle` keeps its own signature while gaining a real element.
   */
  scale?: HeadingScale;
}

/**
 * A heading that is actually in the document outline.
 *
 * This exists because nothing else could produce one. The design-system
 * raw-tag ratchet counts `<h1>`-`<h6>` occurrences everywhere outside
 * `src/ui-kit` and may only ever go down, so an app page cannot author a
 * heading tag; and until now the only heading the kit rendered was
 * `layout/pageHeader`'s page title. Thirteen of the fifteen migrated modules
 * hit that wall, and ten of them landed on the same workaround - `role=
 * "heading"` with an explicit `aria-level` on a `p`/`span`/`div`, which
 * announces correctly but leaves the DOM outline flat.
 *
 * Level and scale are separate props on purpose: how deep a heading sits and
 * how big it looks are independent facts, and forcing one prop to carry both
 * is what pushes call sites back to a div.
 */
function Heading({ className, level = 2, scale, ...props }: HeadingProps) {
  const Tag = `h${level}` as const;

  return (
    <Tag
      data-slot="heading"
      className={cn(scaleClasses[scale ?? defaultScale[level]], className)}
      {...props}
    />
  );
}

export { Heading, scaleClasses, defaultScale };
