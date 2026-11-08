import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface TaxWarningDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oldState?: string | null;
  newState?: string | null;
  /** Confirm = proceed with the location change. */
  onConfirm: () => void;
  confirmLabel?: string;
  isPending?: boolean;
}

/**
 * Surfaces the location-change tax warning (entity-redesign §3). Changing the
 * service location's STATE changes the tax rate applied to estimates/invoices for
 * the lead. Shown before submit (client-side state-change detection) so the user
 * confirms the impact explicitly.
 */
export function TaxWarningDialog({
  open,
  onOpenChange,
  oldState,
  newState,
  onConfirm,
  confirmLabel = 'Change Location',
  isPending = false,
}: TaxWarningDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            Tax Rate Change
          </DialogTitle>
          <DialogDescription>
            You are moving the service location from{' '}
            <span className="font-semibold text-text-primary">{oldState || '—'}</span> to{' '}
            <span className="font-semibold text-text-primary">{newState || '—'}</span>.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-text-secondary">
          Changing the service location&apos;s state changes the tax rate applied to
          estimates and invoices for this lead. Existing documents are not retroactively
          re-taxed, but new estimates will use the new state&apos;s rate.
        </p>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Saving...' : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
