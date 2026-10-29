import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { DisabledReasonShell, activeReason } from "@/ui-kit/components/ui/disabledReason";

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
          "bg-destructive-solid text-destructive-foreground shadow-xs hover:bg-destructive-solid-hover hover:shadow-md"
          + " disabled:bg-disabled disabled:text-disabled-foreground",
        link:
          "text-brand underline-offset-4 hover:underline active:translate-y-0"
          + " disabled:text-disabled-foreground disabled:no-underline",
      },
      // `touch:` = a coarse primary pointer (phones, tablets). The small sizes reach 44 px
      // there (mobile slice 25, rubric TOUCH-02) and keep their size with a mouse. A call
      // site's own `size-6` / `h-7` still loses to them on touch: plugin variants are
      // emitted after plain utilities.
      size: {
        sm: "h-8.5 px-3 text-[0.8125rem] touch:h-11 touch:min-w-11",
        default: "h-10 px-4 text-[0.84375rem]",
        lg: "h-11.5 px-5 text-[0.9375rem]",
        icon: "size-10 touch:size-11",
        "icon-sm": "size-8.5 touch:size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/** The sizes that render an icon and no text. */
export type IconButtonSize = Extract<ButtonSize, "icon" | "icon-sm">;

/**
 * An icon-only button has no visible text, so its name must come from `aria-label` or
 * `aria-labelledby` (mobile slice 25, rubric A11Y-03). Required at the type level: an unnamed
 * `size="icon"` / `size="icon-sm"` button does not type-check (see src/components/ui/__tests__/iconButtonName.test.tsx).
 */
export type IconButtonName =
  | { "aria-label": string; "aria-labelledby"?: string }
  | { "aria-labelledby": string; "aria-label"?: string };

interface ButtonBaseProps
  extends Omit<React.ComponentProps<"button">, "aria-label" | "aria-labelledby">,
    Omit<VariantProps<typeof buttonVariants>, "size"> {
  /** Render as the child element (e.g. a Next.js <Link>) instead of a <button>. */
  asChild?: boolean;
  /** Swaps the leading icon for a spinner and disables the button. */
  isLoading?: boolean;
  /**
   * Why this button is disabled. While it is disabled, tapping it (or pressing Enter) opens the
   * reason as helper text; a mouse still gets it on hover. Use this instead of a bare `title`,
   * which a touch screen never shows (mobile slice 40, rubric TOUCH-05).
   */
  disabledReason?: string;
}

/** A button that shows text (any non-icon size); its text is its name. */
export type TextButtonProps = ButtonBaseProps & {
  size?: Exclude<ButtonSize, IconButtonSize> | null;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

export type ButtonProps = TextButtonProps | (ButtonBaseProps & { size: IconButtonSize } & IconButtonName);

function Button({
  className,
  variant,
  size,
  asChild = false,
  isLoading = false,
  disabled,
  disabledReason,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  const descriptionId = React.useId();
  const reason = activeReason(disabled || isLoading, disabledReason);

  const button = (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || isLoading}
      // Tells assistive tech the control is working rather than broken.
      aria-busy={isLoading || undefined}
      {...props}
      aria-describedby={reason ? descriptionId : props["aria-describedby"]}
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

  return reason ? (
    <DisabledReasonShell
      reason={reason}
      descriptionId={descriptionId}
      block={/(^|\s)w-full(\s|$)/.test(className ?? "")}
    >
      {button}
    </DisabledReasonShell>
  ) : (
    button
  );
}

export { Button, buttonVariants };
