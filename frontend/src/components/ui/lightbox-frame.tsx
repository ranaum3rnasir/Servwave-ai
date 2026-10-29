import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { Dialog, DialogPortal } from '@/components/ui/dialog';
import { useReturnFocus } from '@/ui-kit/hooks/useReturnFocus';

/**
 * The full-screen viewer frame the photo and video lightboxes share, on the app's dialog
 * primitive (mobile slice 16, A11Y-04).
 *
 * The two lightboxes used to be hand-rolled `createPortal` divs with a document Escape listener:
 * focus stayed on the thumbnail behind them, Tab walked the page underneath, and closing left
 * focus wherever it had wandered. On the Radix dialog they get what every other dialog has: focus
 * moves in on open, Tab stays inside, Escape closes, focus returns to the thumbnail that opened
 * it, the page behind is inert and its scroll is locked. Escape also closes only the top layer
 * now, so a lightbox opened from inside another dialog no longer closes that dialog too.
 *
 * It is a viewer, not a card, so it does not use `DialogContent`'s surface: the content element
 * is the whole screen, and a click on its empty area (not on the media or the controls) closes
 * it, as the old backdrop did. The layer keeps the old z-[90] so it still sits above the dialogs
 * a lightbox is opened from.
 */
export function LightboxFrame({
  label,
  onClose,
  initialFocus,
  children,
}: {
  /** The dialog's accessible name ("Attachment preview", "Video preview"). */
  label: string;
  onClose: () => void;
  /**
   * The control that takes focus on open. The close button, never the first control in DOM
   * order: that can be Delete, and Enter on an auto-focused destructive control is one keypress
   * from a confirm the user never meant to start.
   */
  initialFocus: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  // Radix returns focus only to a Dialog.Trigger; a lightbox opens from a thumbnail's onClick.
  const returnFocus = useReturnFocus();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[90] bg-scrim/80" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[90] flex items-center justify-center p-6 outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            initialFocus.current?.focus();
          }}
          onCloseAutoFocus={returnFocus}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
