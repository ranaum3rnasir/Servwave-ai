"use client";

import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { Skeleton } from "@/ui-kit/components/ui/skeleton";

/**
 * NOT HERE: `meta` and `delta`. HERE, since #2011: `detail`.
 *
 * The card used to carry a caption line under the value and a tinted chip
 * beside it, with a sentiment model behind the chip (`direction` plus a
 * `goodDirection`, so a falling cost read green). Both are gone at the owner's
 * explicit call: a KPI tile's value has no chip and no trend caption. That
 * includes the real trend figures - "-54%", "+4pp vs last mo" - which were
 * put to them directly and ruled out with the rest.
 *
 * They are REMOVED rather than accepted-and-ignored. This component already
 * shipped one silently-dropped prop (`children`, beaten by the JSX children the
 * card supplies itself), and the fix for that was to make it a type error;
 * leaving `meta`/`delta` declared would rebuild exactly that defect on purpose.
 * A call site that still has a trend or a sentiment chip to show now fails to
 * compile, which is the only way it gets looked at.
 *
 * The owner's later, separate ruling (#2011, 2026-09-10): a tile MAY show a
 * second figure of the SAME metric under the value - a count's worth, not a
 * trend on the count - so `detail` exists for that one case. It is optional,
 * renders nothing when omitted, and is not a chip: no colour, no polarity,
 * just a smaller line under the number.
 */

// `children` is omitted rather than accepted: the component supplies its own
// JSX children, and JSX children beat a spread `children` prop, so anything a
// call site passed used to vanish without a word. It is a type error now.
export interface StatCardProps extends Omit<React.ComponentProps<"button">, "value" | "children"> {
  label: string;
  value: React.ReactNode;
  /** Renders a 3px semantic rail on the left edge. */
  tone?: "brand" | "green" | "blue" | "amber" | "red" | "purple";
  /** Pressed state - set when the card is acting as an active filter. */
  active?: boolean;
  loading?: boolean;
  /**
   * A second figure of the SAME metric, rendered under the value in a
   * smaller, muted line (e.g. a count's worth). Not a trend, not a chip - see
   * the docblock above. Omitted entirely (no node, not an empty one) when
   * `undefined`.
   */
  detail?: React.ReactNode;
}

const railTones = {
  brand: "before:bg-brand",
  green: "before:bg-status-green",
  blue: "before:bg-status-blue",
  amber: "before:bg-status-amber",
  red: "before:bg-status-red",
  purple: "before:bg-status-purple",
};

/**
 * KPI tile.
 *
 * The value leads at roughly twice the label's size - a stat card exists to be
 * read in under a second, and that only works when the number is visually
 * first. If the row is too tall, tighten the padding; never level the sizes.
 *
 * Deliberately no icon tile. A briefcase glyph beside "Open jobs" carries no
 * information and costs 36px on every card; when a metric needs colour coding,
 * the `tone` rail does the same job in 3px.
 *
 * Renders as a <button> so it can act as a filter - which is also the only
 * honest reason to give it a hover lift.
 */
function StatCard({
  className, label, value, tone, active, loading, detail, ...props
}: StatCardProps) {
  if (loading) {
    // Two bars for two lines by default. A tile that will show `detail` once
    // loaded gets a third bar here too, so the loading row and the loaded row
    // land at the same height instead of growing when the data arrives.
    return (
      <div className="bg-kit-card flex flex-col gap-2.5 rounded-lg border p-3.5 shadow-sm">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-16" />
        {detail !== undefined && <Skeleton className="h-3 w-16" />}
      </div>
    );
  }

  const interactive = Boolean(props.onClick);
  // Polymorphic host: `button` when clickable, `div` otherwise. The union of
  // both prop sets is not inferable, so the tag is widened to ElementType.
  const Comp = (interactive ? "button" : "div") as React.ElementType;

  return (
    <Comp
      data-slot="stat-card"
      type={interactive ? "button" : undefined}
      aria-pressed={interactive ? active : undefined}
      className={cn(
        "bg-kit-card relative flex flex-col gap-2.5 overflow-hidden rounded-lg border p-3.5 text-left shadow-sm",
        "transition-[transform,box-shadow,border-color,background-color] duration-200",
        tone && "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        tone && railTones[tone],
        interactive && "cursor-pointer hover:border-brand hover:-translate-y-0.5 hover:shadow-md active:translate-y-0",
        interactive && "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        active && "border-brand bg-brand-subtle",
        className,
      )}
      {...props}
    >
      <span className="text-muted-foreground text-[12.5px] font-semibold">{label}</span>
      <span className="text-2xl leading-none font-bold tracking-[-0.035em] tabular-nums">{value}</span>
      {detail !== undefined && (
        <span data-slot="stat-card-detail" className="text-muted-foreground text-[12.5px]">
          {detail}
        </span>
      )}
    </Comp>
  );
}

function StatCardGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-card-group"
      className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}
      {...props}
    />
  );
}

export { StatCard, StatCardGroup };
