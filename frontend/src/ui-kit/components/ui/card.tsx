import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { Heading, type HeadingLevel } from "@/ui-kit/components/ui/heading";

/**
 * Compound card. Header lays out on a grid so CardAction can sit top-right
 * without wrapping the title in extra divs at every call site.
 *
 *   <Card>
 *     <CardHeader>
 *       <CardTitle>Harborview Dental</CardTitle>
 *       <CardDescription>J00225 · Springfield</CardDescription>
 *       <CardAction><Badge variant="orange">In progress</Badge></CardAction>
 *     </CardHeader>
 *     <CardContent>…</CardContent>
 *     <CardFooter>…</CardFooter>
 *   </Card>
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "bg-kit-card text-kit-card-foreground flex flex-col rounded-lg border shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1 px-5 pt-4 pb-3",
        "has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

export interface CardTitleProps extends React.ComponentProps<"h3"> {
  /**
   * Where the title sits in the document outline. 3 by default: a card sits
   * under the page `<h1>` that `layout/pageHeader` renders, and usually under
   * a section heading between the two. Pass a level when the page's outline
   * says otherwise.
   */
  level?: HeadingLevel;
}

/**
 * A real heading, not a styled div.
 *
 * It rendered a `<div>` until now, which put every card title in the app
 * outside the document outline - recorded by Dashboard as the one
 * accessibility difference between the v2 widget shell and the legacy one, and
 * structurally true of every module with a card header. The typography is
 * unchanged, so nothing moves visually; `scale="inherit"` is what keeps
 * Heading's own ramp out of the way.
 */
function CardTitle({ className, level = 3, ...props }: CardTitleProps) {
  return (
    <Heading
      level={level}
      scale="inherit"
      data-slot="card-title"
      className={cn("text-[15px] font-bold leading-tight tracking-tight", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-[12.5px] leading-normal", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("px-5 pb-4", className)} {...props} />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2 border-t px-5 py-3.5", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter };
