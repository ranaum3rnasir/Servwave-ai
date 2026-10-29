"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

/**
 * The dropdown root and trigger both menu families (the kit's and the legacy `components/ui`
 * one) are built on. Mobile slice 73 follow-up, real-device row RD-11 (TOUCH-12).
 *
 * Radix opens a dropdown on `pointerdown`, for every kind of pointer. That is right for a mouse,
 * and wrong for a finger: a touch that lands on a "More actions" button and then drags to scroll
 * the page has already opened the menu by the time the browser decides it is a scroll (it then
 * sends `pointercancel`), and an open modal menu holds the page still. So:
 *
 * - a mouse is unchanged: the menu opens on press, as before;
 * - a touch or a pen does not open on press (Radix is told to skip its press handler); the menu opens on the `click` that follows when the pointer goes up where it went down.
 *   A touch that became a scroll sends no click, so nothing opens;
 * - the keyboard is unchanged (Radix's Enter, Space and ArrowDown handling);
 * - a `click` with no pointer press before it (a screen reader's double-tap activation, a switch
 *   control, `element.click()`) opens the menu too. Radix never handled that case, which left such
 *   a user with a button that did nothing.
 *
 * The native `pointerdown` is deliberately NOT cancelled (no `preventDefault`): WebKit then drops
 * the compatibility mouse events AND the `click`, so a tap would open nothing (measured in the
 * mobile gate's WebKit projects). Radix decides whether to run its press handler by reading
 * `defaultPrevented` on React's synthetic event, so that flag alone is set; the browser's event
 * is left untouched and the `click` still follows a tap.
 */

interface MenuOpenState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const MenuOpenContext = React.createContext<MenuOpenState | null>(null);

type RootProps = React.ComponentProps<typeof DropdownMenuPrimitive.Root>;

/** The dropdown root: Radix's own, with the open state kept here so the trigger can open it on a tap. */
function DropdownMenu({ open: openProp, defaultOpen = false, onOpenChange, ...props }: RootProps) {
  const [innerOpen, setInnerOpen] = React.useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : innerOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setInnerOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const value = React.useMemo(() => ({ open, setOpen }), [open, setOpen]);
  return (
    <MenuOpenContext.Provider value={value}>
      <DropdownMenuPrimitive.Root {...props} open={open} onOpenChange={setOpen} />
    </MenuOpenContext.Provider>
  );
}

const isFingerOrPen = (e: React.PointerEvent) => e.pointerType === "touch" || e.pointerType === "pen";

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ onPointerDown, onClick, disabled, ...props }, ref) => {
  const menu = React.useContext(MenuOpenContext);
  // True from a mouse press until its click: Radix already opened the menu on the press.
  const pressedByMouse = React.useRef(false);

  return (
    <DropdownMenuPrimitive.Trigger
      ref={ref}
      disabled={disabled}
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!menu) return;
        // Radix opens on the primary button without ctrl; any other press opens nothing and sends no click.
        pressedByMouse.current = !isFingerOrPen(event) && event.button === 0 && !event.ctrlKey;
        // Radix skips its own press handler when the synthetic event reads as default-prevented. Set the
        // flag only: a native preventDefault() would suppress the click in WebKit (see the header).
        if (isFingerOrPen(event)) (event as { defaultPrevented: boolean }).defaultPrevented = true;
      }}
      onClick={(event) => {
        onClick?.(event);
        if (!menu) return;
        const afterMousePress = pressedByMouse.current;
        pressedByMouse.current = false;
        if (disabled || event.defaultPrevented || afterMousePress || menu.open) return;
        menu.setOpen(true);
      }}
    />
  );
});
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

export { DropdownMenu, DropdownMenuTrigger };
