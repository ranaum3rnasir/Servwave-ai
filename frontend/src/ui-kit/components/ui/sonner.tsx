"use client";

import { Toaster as Sonner, toast, type ToasterProps } from "sonner";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";

/**
 * Toasts. sonner rather than a hand-rolled stack: it handles stacking order,
 * hover-to-pause, swipe dismissal, promise states, and an aria-live region
 * that announces once instead of on every re-render.
 *
 * Mount once at the app root, then call `toast` from anywhere:
 *
 *   toast.success("Job deleted", { description: "J00225 was removed." });
 *   toast.promise(save(), { loading: "Saving…", success: "Saved", error: "Failed" });
 *
 * Styling is driven by our tokens rather than sonner's theme prop, so light
 * and dark follow the `.dark` class like everything else.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      // 4s: long enough to read two lines, short enough not to stack up
      // during a burst of bulk actions.
      duration={4000}
      gap={9}
      offset={18}
      icons={{
        success: <CheckCircle2 className="size-[19px]" />,
        error: <XCircle className="size-[19px]" />,
        warning: <TriangleAlert className="size-[19px]" />,
        info: <Info className="size-[19px]" />,
      }}
      toastOptions={{
        classNames: {
          // ONE accent, three places. `--toast-accent` is declared on the toast
          // box and read by the rail, the wash and the icon chip, so the type
          // only has to say which hue it is - and it says it through
          // `data-[type=...]`, which sonner writes onto this same element.
          //
          // Deliberately NOT sonner's per-type `classNames.success` etc: those
          // land on the SAME element as `classNames.toast` and are joined, not
          // merged, so `before:bg-brand` and `before:bg-status-green` would both
          // survive and the winner would be whichever Tailwind happened to emit
          // last. A `data-[type=…]` variant is a second selector on the same
          // class, so it wins on specificity and cannot be reordered out.
          //
          // `default` is a real sonner type, so a bare `toast()` gets the brand
          // accent rather than the colourless slab it used to be.
          toast:
            "group toast !bg-kit-card !border-border !text-foreground !rounded-xl !shadow-popover " +
            "!border !gap-3 !p-3.5 relative overflow-hidden " +
            "[--toast-accent:var(--brand)] " +
            "data-[type=success]:[--toast-accent:var(--status-green)] " +
            "data-[type=error]:[--toast-accent:var(--destructive)] " +
            "data-[type=warning]:[--toast-accent:var(--status-amber)] " +
            "data-[type=info]:[--toast-accent:var(--status-blue)] " +
            // The rail, full-bleed on the leading edge.
            "before:absolute before:inset-y-0 before:left-0 before:w-[3.5px] " +
            "before:bg-[rgb(var(--toast-accent))] " +
            // A 7% wash of the same hue across the card, so the toast carries
            // its status rather than showing a hairline of it. Inset past the
            // rail so it does not tint the rail's own colour.
            "after:absolute after:inset-y-0 after:right-0 after:left-[3.5px] " +
            "after:pointer-events-none after:bg-[rgb(var(--toast-accent)/0.07)] " +
            // Both are pseudo-elements on this box, so the real children are
            // lifted over them.
            "[&>*]:relative [&>*]:z-[1]",
          title: "!text-[13px] !font-bold !tracking-[-0.01em]",
          description: "!text-muted-foreground !text-[12px] !leading-normal !mt-0.5",
          actionButton: "!bg-primary !text-primary-foreground !rounded-md !text-[12px] !font-semibold",
          cancelButton: "!bg-muted !text-muted-foreground !rounded-md !text-[12px] !font-semibold",
          closeButton: "!bg-kit-card !border-border !text-muted-foreground hover:!text-foreground",
          // The icon rides in a tinted chip rather than floating loose against
          // the card - it is the one element that has to read as a status from
          // the corner of the eye. `!` on the box properties: sonner's own
          // `[data-sonner-toast] [data-icon]` rule is a two-selector
          // specificity and fixes size, margin and alignment.
          icon:
            "!m-0 !size-7 !shrink-0 !flex !items-center !justify-center rounded-full " +
            "bg-[rgb(var(--toast-accent)/0.14)] text-[rgb(var(--toast-accent))] [&>svg]:size-[17px]",
        },
      }}
      {...props}
    />
  );
}

export { Toaster, toast };
