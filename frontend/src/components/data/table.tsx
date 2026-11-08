import * as React from "react"

import { cn } from "@/lib/utils"
import { padClasses, type PadProps } from "@/design-system/spacing"

/* =============================================================================
   Table - phase 7 axes.

   WHAT THIS FILE IS FOR NOW. Raw table elements are the single largest
   appearance population in the tree: 2,647 appearance tokens across 46 files
   (td 1,188, th 884, tr 334, thead 108, table 67, tbody 46, tfoot 20), measured
   2026-07-27 with the guard's own exports. Shipped primitive usage against that
   is tiny - TableCell 36 tags / 6 files, TableHead 32 / 6, TableRow 18 / 6,
   Table 6 / 5. This edit converts NO call site. It only adds the axes the two
   tracer pages need so they CAN adopt the cluster with nothing rendering
   differently. Everything below is additive; every existing default emits a
   byte-identical class string.

   THE HEADER PROBLEM, STATED PLAINLY. The two tracer tables carry three
   different header treatments and neither matches the shipped primitive:

     shipped TableHead   40px tall, 10.5px, 700, uppercase, tracked, muted
     InvoicesPage dialog 14px, 500, no letter casing change, no tracking,
                         no height, vertical padding at step 2
     InvoiceDetail ledger 12px, normal weight, uppercase, tracked, muted,
                         bottom padding at step 2 only

   Giving TableHead an independent axis per difference would hand it an axis for
   every class in its own default string, which is not extending a primitive, it
   is dissolving one. So the three MEASURED signatures are named instead, the
   way this codebase already handles this shape (TabsTriggerVariant,
   TableCellTone): variant default / plain / compact.

   THE tr-TO-th MIGRATION. Both pages hang the header's typography on the tr
   (letter casing, tracking, size, colour, alignment) and let it inherit into
   the th cells. Those are all inherited or text properties whose only children
   are the th cells, so moving them onto each TableHead renders the same thing.
   The row border is NOT one of those - it stays on the row, drawn by
   TableHeader. This claim is proven by the visual gate, not by this paragraph.

   WHY THE WRAPPER IS AN AXIS. It is not taste. Today's wrapper sets overflow on
   BOTH axes; the ledger's wrapper sets it on the horizontal axis only, and the
   dialog table has no wrapper at all. Those are three different layouts, and
   picking the wrong one adds or removes a scrollbar that no unit test can see.
   ============================================================================= */

/* -----------------------------------------------------------------------------
   Table
   -------------------------------------------------------------------------- */

/**
 * Which scroll container the table sits in.
 *
 * `auto` is today's: positioned, full width, overflow on both axes.
 * `x` scrolls horizontally only, leaving vertical overflow visible. NOT a
 *   synonym for `auto` - the shipped wrapper also clips and scrolls vertically.
 * `none` renders the bare table with no wrapper element at all, for a table
 *   whose own parent already owns the scroll or the width.
 */
export type TableWrapper = "auto" | "x" | "none"

const TABLE_WRAPPER: Record<Exclude<TableWrapper, "none">, string> = {
  auto: "relative w-full overflow-auto",
  x: "overflow-x-auto",
}

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & {
    /** Scroll container around the table. Defaults to today's both-axis wrapper. */
    wrapper?: TableWrapper
  }
>(({ className, wrapper = "auto", ...props }, ref) => {
  // `caption-bottom` is inert with no caption element, which is why a table
  // that ships without one can adopt this base unchanged.
  const table = (
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-sm", className)}
      {...props}
    />
  )
  if (wrapper === "none") return table
  return <div className={TABLE_WRAPPER[wrapper]}>{table}</div>
})
Table.displayName = "Table"

/* -----------------------------------------------------------------------------
   TableHeader - unchanged.

   Its row rule draws the same hairline the two pages draw by hand on the header
   row itself. Preflight's inherited border colour and the `border` colour token
   both resolve to the same custom property, so a bare bottom-border utility on
   the page and this token-named one are the same pixels.
   -------------------------------------------------------------------------- */

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    // Hairline bottom border under the header row; no fill.
    className={cn("[&_tr]:border-b [&_tr]:border-border", className)}
    {...props}
  />
))
TableHeader.displayName = "TableHeader"

/* -----------------------------------------------------------------------------
   TableBody
   -------------------------------------------------------------------------- */

/**
 * Where the horizontal rules between body rows come from.
 *
 * `none` is today's: the rows draw their own, TableRow supplying it.
 * `hairline` draws them on the section instead, at half strength, which is the
 *   ledger's treatment. A row inside such a body should set `divider="none"`
 *   so the two do not both paint.
 */
export type TableBodyDivider = "none" | "hairline"

const BODY_DIVIDER: Record<TableBodyDivider, string> = {
  none: "",
  hairline: "divide-y divide-border/50",
}

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement> & {
    /** Section-drawn rules between rows. Defaults to none, as today. */
    divider?: TableBodyDivider
  }
>(({ className, divider = "none", ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", BODY_DIVIDER[divider], className)}
    {...props}
  />
))
TableBody.displayName = "TableBody"

/* -----------------------------------------------------------------------------
   TableFooter
   -------------------------------------------------------------------------- */

/**
 * `default` is today's filled, top-ruled, medium-weight footer.
 * `bare` paints nothing, for a footer that is a summary line rather than a
 *   band - the ledger's, which ships with no classes on the section at all.
 */
export type TableFooterVariant = "default" | "bare"

const FOOTER_VARIANT: Record<TableFooterVariant, string> = {
  default: "border-t border-border bg-background-light font-medium [&>tr]:last:border-b-0",
  bare: "",
}

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement> & {
    variant?: TableFooterVariant
  }
>(({ className, variant = "default", ...props }, ref) => (
  <tfoot ref={ref} className={cn(FOOTER_VARIANT[variant], className)} {...props} />
))
TableFooter.displayName = "TableFooter"

/* -----------------------------------------------------------------------------
   TableRow
   -------------------------------------------------------------------------- */

/** What the row's fill means, not which classes paint it. */
export type TableRowTone = "default" | "danger"

const ROW_TONE: Record<TableRowTone, string> = {
  default: "",
  // A row that reverses the table's usual direction, e.g. a refund inside a
  // ledger of collections. Tinted, not outlined, so it reads as a band.
  danger: "bg-danger-surface/40",
}

/**
 * Who draws the rule under this row.
 *
 * `hairline` is today's: the row draws it, at full strength, in the border
 *   token. The last row in a body drops it, via TableBody.
 * `none` draws nothing, for a row inside a body whose own divider prop is
 *   drawing the rules. Without this, adopting TableRow inside such a body
 *   paints a second hairline at a different strength - a rendered change.
 */
export type TableRowDivider = "hairline" | "none"

const ROW_DIVIDER: Record<TableRowDivider, string> = {
  // 1px hairline divider between rows; last row drops it via TableBody.
  hairline: "border-b border-border",
  none: "",
}

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & {
    tone?: TableRowTone
    /** Who draws the rule under the row. Defaults to the row itself, as today. */
    divider?: TableRowDivider
    /** Dims the whole row - a record that is still listed but no longer counts. */
    muted?: boolean
    /** Lights the row up under the pointer. Set it only where the row is clickable. */
    interactive?: boolean
  }
>(
  (
    { className, tone = "default", divider = "hairline", muted, interactive, ...props },
    ref
  ) => (
    <tr
      ref={ref}
      className={cn(
        ROW_DIVIDER[divider],
        "transition-colors data-[state=selected]:bg-background-light",
        interactive && "hover:bg-background-light/30",
        ROW_TONE[tone],
        muted && "opacity-60",
        className
      )}
      {...props}
    />
  )
)
TableRow.displayName = "TableRow"

/* -----------------------------------------------------------------------------
   Shared cell axes
   -------------------------------------------------------------------------- */

const CELL_ALIGN = {
  left: "",
  center: "text-center",
  right: "text-right",
} as const

/**
 * PADDING PRECEDENCE, and why it is replace rather than merge.
 *
 * Each variant below names its own default padding as a set of step props. A
 * caller that passes ANY padding prop replaces that default outright; it is not
 * merged. Merging would silently keep a side the caller did not ask for - the
 * ledger's body cells pad top, bottom and right and deliberately leave the left
 * side at the user-agent value, and a merge with the shipped uniform default
 * would re-add a left pad they never wrote.
 *
 * spacing.ts already refuses to synthesise a step-0 class for an unnamed side,
 * for the same reason: padding is not zeroed by the preflight reset, so a zero
 * on a table cell removes the 1px the user agent gives it. Replace, then, means
 * the caller's set is the whole truth.
 */
function resolvePad(caller: PadProps, fallback: PadProps): string {
  const set =
    caller.pad !== undefined ||
    caller.padX !== undefined ||
    caller.padY !== undefined ||
    caller.padTop !== undefined ||
    caller.padRight !== undefined ||
    caller.padBottom !== undefined ||
    caller.padLeft !== undefined
  return padClasses(set ? caller : fallback)
}

/* -----------------------------------------------------------------------------
   TableHead
   -------------------------------------------------------------------------- */

/**
 * The three MEASURED header signatures in this tree, named.
 *
 * `default` is the shipped ServWave header: 40px tall, 10.5px, 700, uppercase,
 *   tracked, muted, no fill.
 * `plain`   is a header that is simply a heavier body row: inherits the table's
 *   14px, 500, no letter casing change, no tracking, muted.
 * `compact` is a small tracked uppercase header with no height floor, sitting
 *   directly above its rows.
 *
 * These are bundles on purpose. Seven orthogonal axes would give TableHead one
 * axis per class in its own default string.
 */
export type TableHeadVariant = "default" | "plain" | "compact"

/** The box half of a variant - kept separate so padding can slot in between. */
const HEAD_BOX: Record<TableHeadVariant, string> = {
  default: "h-10",
  plain: "",
  compact: "",
}

/** The paint half of a variant. No padding here; see HEAD_PAD. */
const HEAD_LOOK: Record<TableHeadVariant, string> = {
  // Money columns: pass `align="right"` per-column (not forced globally).
  default:
    "text-left align-middle text-[10.5px] font-bold uppercase tracking-wide text-text-secondary [&:has([role=checkbox])]:pr-0",
  plain: "font-medium text-left text-text-secondary",
  compact: "text-left text-xs uppercase tracking-wide text-text-secondary",
}

/** Each variant's default padding, as step props. Replaced, not merged. */
const HEAD_PAD: Record<TableHeadVariant, PadProps> = {
  default: { padX: 4 },
  plain: { padY: 2 },
  compact: { padBottom: 2 },
}

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> &
    PadProps & {
      variant?: TableHeadVariant
      align?: keyof typeof CELL_ALIGN
    }
>(
  (
    {
      className,
      variant = "default",
      align = "left",
      pad,
      padX,
      padY,
      padTop,
      padRight,
      padBottom,
      padLeft,
      ...props
    },
    ref
  ) => (
    <th
      ref={ref}
      className={cn(
        HEAD_BOX[variant],
        resolvePad(
          { pad, padX, padY, padTop, padRight, padBottom, padLeft },
          HEAD_PAD[variant]
        ),
        HEAD_LOOK[variant],
        CELL_ALIGN[align],
        className
      )}
      {...props}
    />
  )
)
TableHead.displayName = "TableHead"

/* -----------------------------------------------------------------------------
   TableCell

   RATCHETED at 3 appearance-override tokens across the tree, and at its floor.
   Every adoption goes through a prop. Never widen a call site with className.
   -------------------------------------------------------------------------- */

/** What the cell's text means, not which classes paint it. */
export type TableCellTone = "default" | "muted" | "highlight"

const CELL_TONE: Record<TableCellTone, string> = {
  default: "",
  muted: "text-text-secondary",
  // Draws the eye to a value that needs attention, e.g. an overdue date.
  // The call site's `text-rose-600` converged onto the existing `danger`
  // token rather than a bespoke rose one - same meaning, one fewer colour.
  highlight: "text-danger font-medium",
}

/** Body-copy size. `sm` is the table's own 14px; `xs` is a 12px summary line. */
export type TableCellScale = "sm" | "xs"

const CELL_SCALE: Record<TableCellScale, string> = {
  sm: "text-sm",
  xs: "text-xs",
}

const CELL_WEIGHT = {
  normal: "",
  medium: "font-medium",
  semibold: "font-semibold",
} as const

/** The shipped uniform cell padding, one step-props object so it is written once. */
const CELL_PAD: PadProps = { pad: 4 }

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> &
    PadProps & {
      tone?: TableCellTone
      align?: keyof typeof CELL_ALIGN
      /** Body-copy size. Defaults to the table's own 14px. */
      scale?: TableCellScale
      /** Bumps the font weight - a value that should read heavier than its row, short of `tone="highlight"`'s color change. */
      weight?: keyof typeof CELL_WEIGHT
      /** Hairline right border, the last column in a row excepted. DataTable's own column-divider pattern, drawn by hand at 3 call sites before this existed. */
      divider?: boolean
    }
>(
  (
    {
      className,
      tone = "default",
      align = "left",
      scale = "sm",
      weight = "normal",
      divider,
      pad,
      padX,
      padY,
      padTop,
      padRight,
      padBottom,
      padLeft,
      ...props
    },
    ref
  ) => (
    <td
      ref={ref}
      // 14px body cells.
      className={cn(
        resolvePad({ pad, padX, padY, padTop, padRight, padBottom, padLeft }, CELL_PAD),
        CELL_SCALE[scale],
        "align-middle [&:has([role=checkbox])]:pr-0",
        CELL_TONE[tone],
        CELL_ALIGN[align],
        CELL_WEIGHT[weight],
        divider && "border-r border-r-border last:border-r-0",
        className
      )}
      {...props}
    />
  )
)
TableCell.displayName = "TableCell"

/* -----------------------------------------------------------------------------
   TableCaption - unchanged.
   -------------------------------------------------------------------------- */

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-text-secondary", className)}
    {...props}
  />
))
TableCaption.displayName = "TableCaption"

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
