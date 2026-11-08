import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Breadcrumb trail.
 *
 * A <nav> with an ordered list, because the sequence is the meaning. The last
 * crumb is the current page: it is not a link, and it carries aria-current so
 * assistive tech announces where you are rather than offering a link to here.
 */
function Breadcrumbs({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav data-slot="breadcrumbs" aria-label="Breadcrumb" className={className} {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn("text-muted-foreground -ms-1.5 flex flex-wrap items-center gap-0.5 text-[12.5px]", className)}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="breadcrumb-item" className={cn("inline-flex items-center gap-0.5", className)} {...props} />;
}

function BreadcrumbLink({
  className, asChild, ...props
}: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn(
        "hover:text-brand hover:bg-brand-subtle rounded-[5px] px-1.5 py-0.5 transition-colors",
        "focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("text-foreground px-1.5 py-0.5 font-semibold", className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ className, children, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden
      className={cn("text-subtle-foreground [&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  );
}

/** Collapses a deep trail. Pair with a dropdown holding the hidden crumbs. */
function BreadcrumbEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      className={cn("grid size-5 place-items-center", className)}
      {...props}
    >
      <MoreHorizontal className="size-3.5" />
      <span className="sr-only">More</span>
    </span>
  );
}

export {
  Breadcrumbs, BreadcrumbList, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbPage, BreadcrumbSeparator, BreadcrumbEllipsis,
};
