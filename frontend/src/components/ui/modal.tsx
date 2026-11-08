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
  children: React.ReactNode;
}
const WIDTH: Record<ModalWidth, string> = {
  xs: 'max-w-sm', sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl',
};
export function Modal({
  open, onClose, title, subtitle, width: widthProp, size, footer, lockEscape, editAction, children,
  'data-testid': testId,
}: ModalProps) {
  const width = widthProp ?? size ?? 'md';
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* The height cap and the scroll are `DialogContent`'s own now, so this
          passes only a width. The 90vh it used to add was both looser than the
          primitive's cap and measured against the wrong viewport on a phone,
          and it left every dialog that reaches for DialogContent directly with
          no cap at all - which is the half that was getting cropped. */}
      <DialogContent
        className={WIDTH[width]}
        data-testid={testId}
        onEscapeKeyDown={lockEscape ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader>
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
        </DialogHeader>
        {children}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
