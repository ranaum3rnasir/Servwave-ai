import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
    "rounded-md font-semibold cursor-pointer",
    "transition-[background-color,border-color,box-shadow,transform,color] duration-150",
    "active:translate-y-px",
    // A DISABLED BUTTON GOES GREY, it does not go faded.
    //
    // The old rule was `opacity-50`, which keeps the variant's own colour and
    // simply washes it out - a half-strength ink-teal Save button still reads as
    // the page's primary action, so people kept clicking it and concluding the
    // app had hung. Grey is the one fill nothing else in the kit uses for a live
    // control, so it cannot be mistaken for one.
    //
    // Each variant states its own disabled fill below (a ghost or link button
    // has no surface to grey, so those grey the TEXT instead). The shared rules
    // here are the ones every variant wants: no shadow, no hover, no pointer.
    "disabled:pointer-events-none disabled:shadow-none disabled:active:translate-y-0",
    // icons inherit size and never swallow the click
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        // Solid ink-teal. Hover uses an explicit token, not opacity: fading a
        // dark fill toward a white page reads as disabled, not pressed.
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover hover:shadow-md"
          + " disabled:bg-disabled disabled:text-disabled-foreground",
        secondary:
          "bg-tonal text-tonal-foreground shadow-xs hover:bg-tonal-hover"
          + " disabled:bg-disabled disabled:text-disabled-foreground",
        outline:
          "border border-input bg-kit-card text-foreground shadow-xs hover:bg-muted hover:border-subtle-foreground"
          + " disabled:bg-disabled disabled:text-disabled-foreground disabled:border-disabled-border",
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground"
          + " disabled:text-disabled-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive-hover hover:shadow-md"
          + " disabled:bg-disabled disabled:text-disabled-foreground",
        link:
          "text-brand underline-offset-4 hover:underline active:translate-y-0"
          + " disabled:text-disabled-foreground disabled:no-underline",
      },
      size: {
        sm: "h-8.5 px-3 text-[13px]",
        default: "h-10 px-4 text-[13.5px]",
        lg: "h-11.5 px-5 text-[15px]",
        icon: "size-10",
        "icon-sm": "size-8.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element (e.g. a Next.js <Link>) instead of a <button>. */
  asChild?: boolean;
  /** Swaps the leading icon for a spinner and disables the button. */
  isLoading?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  isLoading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || isLoading}
      // Tells assistive tech the control is working rather than broken.
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {/* Slottable, not a bare {children}. Under asChild the wrapper is Radix
          Slot, which merges its props into a SINGLE element child - and this
          component always passes two, the spinner slot and the children, even
          when isLoading is false and the first is null. Slot then threw
          "Expected a single React element child" and took the page with it, so
          asChild was unusable on every kit Button.

          Slottable marks which child is the merge target; the spinner renders
          alongside it inside the caller's element. With asChild off the wrapper
          is a plain button and Slottable is transparent. */}
      <Slottable>{children}</Slottable>
    </Comp>
  );
}

export { Button, buttonVariants };
