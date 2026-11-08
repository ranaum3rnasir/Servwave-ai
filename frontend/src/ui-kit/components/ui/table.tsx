import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Semantic table primitives. Real <table> elements, not divs with grid - a
 * screen reader announces "row 4 of 203, column Status" only if the markup
 * says so, and that navigation is most of how a data table is used non-visually.
 *
 * The horizontal scroll lives on a wrapper so the header row can stay sticky
 * while the body scrolls under it.
 *
 * SEPARATE BORDERS, AND EVERY RULE IS DRAWN BY A CELL.
 *
 * Under `border-collapse: collapse` a border belongs to the table's grid, not
 * to the element that declared it - the browser resolves the conflict between
 * the cell, its row and its neighbour, then paints the winner in the TABLE's
 * layer. A `position: sticky` pinned cell is a positioned box that paints in a
 * later layer, and it is opaque (see `pinned` below), so it covers whichever
 * grid line runs under it. The visible result on every list that pins its
 * identity columns - leads, jobs, estimates, customers, invoices, inventory -
 * was that the header's bottom rule vanished for exactly the width of the
 * sticky run and resumed at the first scrolling column.
 *
 * Moving the rule onto the cells is necessary but NOT sufficient - measured, a
 * bottom border on a sticky `<th>` under `collapse` is still hoisted to the
 * grid and still covered. `separate` is the part that fixes it: each cell then
 * paints its own border with its own background, in its own layer, so a pinned
 * cell carries its rule wherever it sticks to and pinned and unpinned cells
 * draw the identical line.
 *
 * `border-spacing-0` keeps the geometry unchanged, and only `border-b` is ever
 * set (never `border-t`), so two vertically adjacent cells still produce
 * exactly one rule between them rather than the doubled line the separated
 * model is usually caught out by.
 */
const Table = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"table"> & { containerClassName?: string }
>(function Table({ className, containerClassName, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom border-separate border-spacing-0 text-[13px]",
          className,
        )}
        {...props}
      />
    </div>
  );
});

// Row groups and rows cannot paint a border in the separated model at all, so
// every rule below targets cells. A `[&_tr]:border-b` here would be a silent
// no-op, which is the trap this file now exists to stay out of.
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn(className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child>td]:border-b-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 font-medium [&>tr>td]:border-t [&>tr:last-child>td]:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * THE ROW OWNS THE BACKGROUND, and every cell in it inherits.
 *
 * The resting surface used to live on the table container, which left the
 * `<tr>` transparent and made `bg-kit-card` on a pinned cell the only opaque
 * thing in the row. An opaque cell background beats the row's, so `hover:` and
 * `data-[state=selected]:` tinted the scrolling columns and left the sticky run
 * at the resting colour - the highlight visibly covered part of a row. Painting
 * the resting surface here gives `bg-inherit` on a pinned cell something real to
 * resolve against, and all three states then travel across the whole row.
 */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // The row still owns the SURFACE (see above) but no longer the RULE:
        // its cells draw that, so the sticky ones draw it too.
        "transition-colors",
        "bg-kit-card hover:bg-muted data-[state=selected]:bg-selected",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `pinned` is the sticky-column surface, not a position.
 *
 * A cell that stays put while the rest of the row scrolls under it has to be
 * opaque, or the scrolling content shows through - but it must not pick its own
 * colour, or it stops following the row through hover and selection (see
 * TableRow). `bg-inherit` is both at once: opaque, and always exactly whatever
 * the `<tr>` is painting right now.
 *
 * The offset itself is a measurement the caller computes and passes as
 * `style.left`; the surface is an appearance decision and belongs here.
 */
export interface TablePinnableProps {
  pinned?: boolean;
}

function TableHead({ className, pinned, ...props }: React.ComponentProps<"th"> & TablePinnableProps) {
  return (
    <th
      data-slot="table-head"
      data-pinned={pinned ? "" : undefined}
      className={cn(
        "text-muted-foreground h-10 px-4 text-left align-middle text-[11.5px] font-semibold whitespace-nowrap",
        // The header's rule. On the cell, not the row - a pinned <th> is sticky
        // and opaque, and only a border it draws itself survives underneath it.
        "border-b",
        // A header never wraps, so under `table-layout: fixed` a long one would
        // run out past its column and sit on top of the next. The clipping
        // happens here; WHERE the ellipsis falls is decided inside
        // DataTableColumnHeader, which truncates the title and keeps the sort
        // arrow whole.
        "overflow-hidden",
        "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        pinned && "bg-inherit",
        className,
      )}
      {...props}
    />
  );
}

export interface TableCellProps extends React.ComponentProps<"td">, TablePinnableProps {
  /**
   * `none` drops the cell's inset so a full-bleed child - an empty state, a
   * nested grid - can reach the row edges. A prop rather than a `p-0` at the
   * call site: padding is appearance, and appearance belongs to the component.
   */
  padding?: "default" | "none";
}

function TableCell({ className, padding = "default", pinned, ...props }: TableCellProps) {
  return (
    <td
      data-slot="table-cell"
      data-pinned={pinned ? "" : undefined}
      className={cn(
        padding === "none" ? "p-0" : "px-4 py-2.5",
        // Same rule as the header, and for the same reason - see TableHead.
        "border-b",
        // `break-words`, not `overflow-hidden`: under fixed layout an unbroken
        // token (an email, a URL, a long SKU) is the one thing wide enough to
        // escape its column, and it should fold rather than be clipped. Hiding
        // the overflow instead would also clip anything a cell deliberately
        // draws outside its box - focus rings, avatar borders.
        "align-middle break-words",
        "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        pinned && "bg-inherit",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-[12.5px]", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
