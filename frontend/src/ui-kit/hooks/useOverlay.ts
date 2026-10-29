import { useEffect, type RefObject } from "react";

import { canAutoFocus } from "@/ui-kit/lib/autoFocus";

const FOCUSABLE = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"]);

/** A field that opens the on-screen keyboard when focused. */
function isTextEntry(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  return el.isContentEditable;
}

/**
 * The four behaviours every modal surface owes a keyboard user.
 *
 *   1. Focus moves INTO the overlay when it opens
 *   2. Tab cycles within it and cannot escape to the page behind
 *   3. Escape closes it
 *   4. Focus RETURNS to whatever opened it
 *
 * Plus a body scroll lock, so the page behind doesn't drift under the scrim.
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   useOverlay(isOpen, ref, close);
 *
 * Radix primitives already do all of this - reach for this hook only when
 * building a surface by hand. Sharing it between Dialog and Drawer is what
 * stops their behaviour from drifting apart over time.
 */
export function useOverlay(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Wait a frame so the enter animation has mounted the content. On touch
    // (mobile slice 24) a text field never takes focus on its own - it would
    // open the keyboard over the overlay - so the first control that is not a
    // text field does, or the overlay itself.
    const focusTimer = window.setTimeout(() => {
      const root = ref.current;
      if (!root) return;
      if (canAutoFocus()) {
        root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
        return;
      }
      const control = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => !isTextEntry(el));
      if (control) control.focus();
      else {
        if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
        root.focus({ preventScroll: true });
      }
    }, 30);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      // Re-query on every Tab: the contents may have changed since open.
      const items = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open, onClose, ref]);
}
