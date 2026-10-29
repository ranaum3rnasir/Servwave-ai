import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

/**
 * The bubble half of `DisabledReasonShell`. It is its own file because it is the only part that
 * needs the popover stack (positioning, dismiss layer, focus handling), which is roughly 14 KB
 * gzipped, and every page that renders a Button would otherwise pay for it up front, a
 * customer's public estimate included (mobile slice 47). The shell loads this the first time
 * someone taps a disabled button that has a reason.
 */
export default function DisabledReasonBubble({
  reason,
  anchor,
  open,
  onOpenChange,
}: {
  reason: string;
  /** The shell element the bubble points at (it is rendered by the shell, not here). */
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Anchor virtualRef={anchor as React.RefObject<HTMLElement>} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          role="status"
          side="bottom"
          align="center"
          sideOffset={6}
          collisionPadding={12}
          // The reason is read, not worked in: do not move focus away from the page.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // A tap on the shell itself is a toggle (handled by the shell), not an outside click
          // that would close the bubble and let the same tap reopen it.
          onInteractOutside={(e) => {
            if (anchor.current?.contains(e.target as Node)) e.preventDefault();
          }}
          data-slot="disabled-reason"
          className="bg-kit-popover text-kit-popover-foreground z-floating max-w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border px-3 py-2 text-sm shadow-popover outline-none"
        >
          {reason}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
