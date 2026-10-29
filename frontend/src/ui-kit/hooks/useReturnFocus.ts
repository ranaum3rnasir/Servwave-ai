import { useCallback, useState } from "react";

/**
 * Give focus back to whatever held it when a dialog opened (mobile slice 16, A11Y-04).
 *
 * Radix Dialog returns focus on close to its `<Dialog.Trigger>` and to nothing else. A dialog
 * opened from state (a thumbnail's onClick, a 409 handler, an action inside another dialog) has no
 * Trigger, so focus fell to <body> and a keyboard or screen-reader user had to find their place
 * again from the top of the page.
 *
 * Call it in the component that renders the dialog's content while it is open, and pass the
 * returned handler as `onCloseAutoFocus`. The opener is read during the first render, before
 * Radix's focus scope moves focus into the dialog. An opener that has since left the document
 * (the confirm replaced a dialog that is now gone) is skipped, so whichever dialog took over
 * keeps the focus it took.
 */
export function useReturnFocus(): (event: Event) => void {
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  return useCallback(
    (event: Event) => {
      event.preventDefault();
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    },
    [opener],
  );
}
