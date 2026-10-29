/**
 * ConfirmDialog — the app's standard "are you sure?" prompt: optional icon
 * badge, title + description, optional rich body (`children`), Cancel +
 * Confirm footer with a loading state. Composes `ui/dialog` directly (same
 * primitives PublicEstimatePage's decline-confirmation already used) rather
 * than `Modal`, since a confirmation's footer semantics (Cancel/Confirm,
 * destructive tone, loading spinner) don't fit Modal's generic footer slot.
 *
 * W2/8's rename schedule (program plan section 2a.11) points this file's
 * `variant='destructive'` at `tone="danger"`. 3 of the component's 7 real
 * call sites pass it: components/crm/IconRail.tsx:146,
 * pages/PublicEstimatePage.tsx:779, pages/JobDetailPage.tsx:1776. `tone` is
 * the new, preferred prop - `brand` (the default, matching `variant`'s own
 * 'default') or `danger`. `variant` stays as a deprecated alias resolving to
 * the same tone, so all 7 call sites - including the 3 already passing
 * `variant="destructive"` - keep rendering byte-identical output.
 *
 * PHASE 12C UPDATE. Only the INTERNAL Confirm `<Button>` call below was in
 * scope for that phase's job (removing Button's own deprecated variant
 * aliases): it used to compute `variant={resolvedTone === 'danger' ?
 * 'destructive' : 'default'}`, both deprecated Button names, and now passes
 * `tone={resolvedTone}` directly - `resolvedTone` is already typed as
 * `ConfirmDialogTone` ('brand' | 'danger'), which happens to be exactly
 * Button's own tone vocabulary for the solid/brand and solid/danger cells,
 * so no `variant` prop is needed at all (Button's own default structure is
 * solid). This component's OWN public `variant` prop above is a SEPARATE,
 * similarly-shaped deprecation of ConfirmDialog's own API, not Button's -
 * phase 12c's brief was scoped to Button's alias table specifically, so that
 * public prop and its 3 external call sites are left exactly as they were,
 * as a distinct, not-yet-scoped follow-up.
 */
import type { LucideIcon } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Semantic colour: tints the icon badge + Confirm button. `danger` for delete/cancel-type actions. */
export type ConfirmDialogTone = 'brand' | 'danger';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  /**
   * @deprecated use `tone="danger"` instead of `variant="destructive"` (or
   * omit both - `tone` defaults to `"brand"`, the same look `variant`'s own
   * `"default"` already produces). Ignored when `tone` is also passed.
   */
  variant?: 'default' | 'destructive';
  /** Tints the icon badge + Confirm button danger (delete/cancel-type actions). Defaults to `"brand"`. Supersedes `variant`. */
  tone?: ConfirmDialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  isLoading?: boolean;
  /**
   * Holds Confirm disabled while the body's own precondition is unmet - e.g. a
   * type-the-name gate on an irreversible action. Cancel stays enabled.
   */
  confirmDisabled?: boolean;
  /** Rich body content (e.g. a from/to comparison panel) rendered between the description and the footer. */
  children?: ReactNode;
  /** Layout-only, e.g. a wider dialog for a richer body. */
  className?: string;
  /**
   * A warning that interrupts (WAI-ARIA alertdialog): the dialog is announced as an alert dialog
   * and focus opens on Cancel, the safe answer, so a stray Enter keeps things as they are.
   */
  alert?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  icon: Icon,
  variant = 'default',
  tone,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  isLoading = false,
  confirmDisabled = false,
  children,
  className,
  alert = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const resolvedTone: ConfirmDialogTone = tone ?? (variant === 'destructive' ? 'danger' : 'brand');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        intent={children ? 'form' : 'choice'}
        className={cn('max-w-sm', className)}
        // Spread only for an alert: an explicit `role={undefined}` would wipe the dialog's own role.
        {...(alert && {
          role: 'alertdialog',
          onOpenAutoFocus: (event: Event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          },
        })}
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            {Icon && (
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                  resolvedTone === 'danger' ? 'bg-danger/10' : 'bg-primary-subtle'
                )}
              >
                <Icon className={cn('h-5 w-5', resolvedTone === 'danger' ? 'text-danger' : 'text-primary')} />
              </div>
            )}
            <div>
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>
        {children}
        {/* An alert has no body, so in a sheet the header's own rule already separates it from the
            footer: no second rule and no margin band between them. The card keeps its spacing. */}
        <DialogFooter
          className={alert ? 'gap-3 border-t-0' : 'mt-4 gap-3'}
          cardClassName={alert ? 'mt-4' : undefined}
        >
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={() => {
              onCancel?.();
              onOpenChange(false);
            }}
            disabled={isLoading}
          >
            {cancelLabel}
          </Button>
          <Button tone={resolvedTone} onClick={onConfirm} disabled={isLoading || confirmDisabled}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
