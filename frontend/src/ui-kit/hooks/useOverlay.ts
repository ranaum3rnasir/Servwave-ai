import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

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

    // Wait a frame so the enter animation has mounted the content.
    const focusTimer = window.setTimeout(() => {
      ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
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
