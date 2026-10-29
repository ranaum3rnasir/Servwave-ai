/**
 * Modal — the app's standard titled dialog: header (title + optional subtitle
 * and edit action), scrollable body, optional footer, four widths.
 *
 * Composes `ui/dialog` rather than replacing it; reach for the raw Dialog
 * primitives only when a surface needs a layout this does not cover. This lived
 * in components/inventory until it turned out 32 files across the app imported
 * it - nothing about it was ever inventory-specific.
 *
 * `width` is a max-width scale, not control height - program plan section 2a
 * rule 3 reserves `size` for control height only, so a max-width scale is
 * named `width` instead, matching the rename `dialog.tsx` / `sheet.tsx` /
 * `popover.tsx` / `dropdown-menu.tsx` already made for their own panel-width
 * props. `size` stays live as a deprecated alias - resolved the same way
 * `card.tsx` resolves `padding` vs `pad` - so every existing call site that
 * still passes `size=` keeps rendering the exact same width.
 */
import * as React from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useOverlayPresentation } from '@/ui-kit/hooks/useOverlayPresentation';
import type { OverlayIntent } from '@/ui-kit/lib/overlayPresentation';

export interface ModalEditAction { label: string; onClick: () => void; icon?: React.ReactNode; }

/**
 * Max width. `sm`..`xl` already matched today's rendered geometry, so no value
 * was remapped; `xs` is an ADDITION, and it is `DialogWidth`'s own `xs`
 * (max-w-sm). Without it the narrow confirm dialogs - void payment, void
 * invoice, record payment - could not move onto Modal without getting wider,
 * so they each kept hand-rolling a header and a footer instead. Naming the
 * width they already use is cheaper than letting them stay off the component.
 */
export type ModalWidth = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Max width. Defaults to `md` (max-w-lg), today's geometry - unmoved. */
  width?: ModalWidth;
  /** Forwarded to the dialog panel, for call sites a test reaches for by id. */
  'data-testid'?: string;
  /**
   * @deprecated Use `width` - same values, same rendered widths. Kept live so
   * existing call sites are unaffected; retired in phase 12c.
   */
  size?: ModalWidth;
  footer?: React.ReactNode;
  lockEscape?: boolean;
  editAction?: ModalEditAction;
  /**
   * What the dialog is for (mobile slices 26 and 53), and REQUIRED so a new Modal cannot skip it:
   *   - "form"    fields and a Save: full-screen below md and on a short landscape window.
   *   - "choice"  a confirmation or a short pick: a bottom sheet below md.
   *   - "content" something to read: full-screen below md.
   * At md and up every intent is today's centred card. In the two phone presentations the title and
   * the close are pinned at the top, the footer is pinned at the bottom (above the home indicator),
   * and only the body scrolls.
   */
  intent: OverlayIntent;
  children: React.ReactNode;
}
const WIDTH: Record<ModalWidth, string> = {
  xs: 'max-w-sm', sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl',
};
export function Modal({
  open, onClose, title, subtitle, width: widthProp, size, footer, lockEscape, editAction, intent, children,
  'data-testid': testId,
}: ModalProps) {
  const width = widthProp ?? size ?? 'md';
  const presentation = useOverlayPresentation(intent);
  const header = (
    <div className="flex items-start justify-between gap-4">
      <div>
        <DialogTitle>{title}</DialogTitle>
        {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
      </div>
      {editAction && (
        <Button variant="outline" size="sm" onClick={editAction.onClick} className="gap-1">
          {editAction.icon}{editAction.label}
        </Button>
      )}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* The height cap and the scroll are `DialogContent`'s own now, so this
          passes only a width. The 90vh it used to add was both looser than the
          primitive's cap and measured against the wrong viewport on a phone,
          and it left every dialog that reaches for DialogContent directly with
          no cap at all - which is the half that was getting cropped. */}
      <DialogContent
        className={WIDTH[width]}
        intent={intent}
        // Modal draws its own header, body and footer slots below.
        layout="own"
        data-testid={testId}
        onEscapeKeyDown={lockEscape ? (e) => e.preventDefault() : undefined}
      >
        {presentation !== 'card' ? (
          <>
            <DialogHeader
              divider
              data-slot="modal-header"
              className={cn(
                'flex shrink-0 flex-col justify-center px-6 pb-3 pr-16 text-left',
                // Full-screen starts under the status bar; a bottom sheet has nothing above it.
                presentation === 'fullscreen'
                  ? 'min-h-[calc(env(safe-area-inset-top)+3.5rem)] pt-[calc(env(safe-area-inset-top)+0.75rem)]'
                  : 'min-h-14 pt-4',
              )}
            >
              {header}
            </DialogHeader>
            {/* The only scroller: the header and the footer stay where they are. A grid with the
                card's 16 px gap, so a Modal whose children are several siblings (a fragment, or a
                form and its notes) keeps the rhythm it had as the card's grid items. */}
            <div
              data-slot="modal-body"
              className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 scroll-py-4 overflow-y-auto overscroll-contain px-6 py-4"
            >
              {children}
            </div>
            {footer && (
              <DialogFooter data-slot="modal-footer" className="shrink-0 border-t border-border px-6 pt-3 pb-[max(1rem,var(--safe-bottom,0px))]">
                {footer}
              </DialogFooter>
            )}
          </>
        ) : (
          <>
            <DialogHeader>{header}</DialogHeader>
            {children}
            {footer && <DialogFooter>{footer}</DialogFooter>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
