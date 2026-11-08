import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/ui-kit/lib/utils";

const badgeVariants = cva(
  [
    "inline-flex items-center justify-center gap-1 whitespace-nowrap w-fit shrink-0",
    "font-semibold leading-none",
    "[&_svg]:pointer-events-none [&_svg]:size-3 [&_svg]:shrink-0",
  ],
  {
    variants: {
      // "status" = solid fill, white text: the board-label look, for the one
      // value that defines a row. "soft" = tinted, for counts and deltas that
      // sit beside other content and shouldn't shout.
      variant: {
        green: "bg-status-green text-on-fill",
        blue: "bg-status-blue text-on-fill",
        amber: "bg-status-amber text-on-fill",
        red: "bg-status-red text-on-fill",
        purple: "bg-status-purple text-on-fill",
        slate: "bg-status-slate text-on-fill",
        teal: "bg-status-teal text-on-fill",
        indigo: "bg-status-indigo text-on-fill",
        outline: "border border-input text-foreground bg-kit-card",
        softGreen: "bg-status-green-subtle text-status-green-emphasis",
        softBlue: "bg-status-blue-subtle text-status-blue-emphasis",
        softAmber: "bg-status-amber-subtle text-status-amber-emphasis",
        softRed: "bg-status-red-subtle text-status-red-emphasis",
        softPurple: "bg-status-purple-subtle text-status-purple-emphasis",
        softNeutral: "bg-muted text-muted-foreground",
      },
      size: {
        default: "px-2.5 py-1.5 text-xs rounded-[5px]",
        sm: "px-2 py-1 text-[11px] rounded-[4px]",
        pill: "px-2.5 py-1 text-[11.5px] rounded-full",
      },
    },
    defaultVariants: { variant: "slate", size: "default" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

function Badge({ className, variant, size, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
export type { VariantProps };
