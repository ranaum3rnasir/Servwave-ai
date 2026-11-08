import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

// `title` is omitted from the div props: the intrinsic one is a tooltip string,
// while the header's is renderable content.
export interface PageHeaderProps extends Omit<React.ComponentProps<"div">, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Breadcrumb trail, rendered above the title. */
  breadcrumbs?: React.ReactNode;
  /**
   * "Back to wherever I came from", rendered above the title on the LEFT.
   *
   * Its own slot rather than an entry in `actions`, because leaving and acting
   * are different jobs. `actions` is the right-hand column of things this page
   * can DO - save, send, add - and a back link parked among them reads as one
   * of them, sits furthest from the reading edge, and lands under a thumb
   * aiming for the primary button. Up-and-out belongs at the top left, where
   * every browser, OS and breadcrumb trail has always put it.
   */
  back?: React.ReactNode;
  /** Primary and secondary actions, right-aligned on desktop. */
  actions?: React.ReactNode;
}

/**
 * Page title block.
 *
 * Actions align to the *baseline* of the title rather than the top of the
 * block, so the row reads as one line even when a description pushes the
 * heading taller. On mobile they drop below and stretch full width - a
 * right-aligned action in a 360px column is a thumb-hostile target.
 */
function PageHeader({
  className, title, description, breadcrumbs, back, actions, children, ...props
}: PageHeaderProps) {
  return (
    <div data-slot="page-header" className={cn("mb-5", className)} {...props}>
      {/* -ml-3 pulls the link's own ghost padding back to the page's text
          edge, so the arrow lines up with the title beneath it rather than
          sitting three pixels proud of it. */}
      {back && <div data-slot="page-header-back" className="-ml-3 mb-1">{back}</div>}
      {breadcrumbs}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-[23px] font-bold tracking-[-0.032em]">{title}</h1>
          {description && (
            <p className="text-muted-foreground mt-1 text-[13.5px]">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}

export { PageHeader };
