import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

export interface EmptyStateProps extends React.ComponentProps<"div"> {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

/**
 * Two empty states are not the same state, and conflating them is the usual
 * mistake:
 *
 *   "No jobs yet"          - nothing exists. Offer the action that creates one.
 *   "No jobs match"        - things exist but are filtered out. Offer a way back.
 *
 * The second must never show a "Create" button: the user isn't missing data,
 * they're one click from finding it.
 */
function EmptyState({ className, icon, title, description, action, ...props }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn("flex flex-col items-center justify-center px-5 py-11 text-center", className)}
      {...props}
    >
      {icon && (
        <div className="bg-muted text-subtle-foreground mb-3 grid size-11 place-items-center rounded-xl [&_svg]:size-5">
          {icon}
        </div>
      )}
      <h3 className="text-[14.5px] font-bold tracking-tight">{title}</h3>
      {description && (
        <p className="text-muted-foreground mt-1 max-w-[42ch] text-[13px] leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-3.5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export { EmptyState };
