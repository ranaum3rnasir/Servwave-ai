import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ConfirmRateChangeDialogProps {
  open: boolean;
  /** Rate name, shown so the admin can see which row they are about to change. */
  name: string;
  /** Percent units (6.625, not 0.06625). Undefined when adding a brand-new rate. */
  previousPct?: number;
  nextPct: number;
  onConfirm: () => void;
  onCancel: () => void;
}

const fmt = (pct: number) => `${pct.toFixed(3).replace(/\.?0+$/, '')}%`;

/**
 * Second look at a tax rate that does not read like a US sales tax rate - see
 * `implausibleRateChange.ts` for the two triggers. A wrong rate here is charged to a real
 * customer on a real invoice, so a mistyped decimal point does not cost nothing.
 *
 * Cancelling leaves the stored rate untouched; the caller reverts its own field.
 */
export function ConfirmRateChangeDialog({
  open,
  name,
  previousPct,
  nextPct,
  onConfirm,
  onCancel,
}: ConfirmRateChangeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md" data-testid="confirm-rate-change-dialog">
        <DialogHeader>
          <DialogTitle>Is this rate right?</DialogTitle>
          <DialogDescription>
            {previousPct === undefined
              ? `${fmt(nextPct)} is higher than any US combined sales tax rate. Check the decimal point before saving.`
              : `This changes ${name} from ${fmt(previousPct)} to ${fmt(nextPct)}. It will apply to every new estimate, job and invoice taxed at this rate.`}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Go back
          </Button>
          <Button data-testid="confirm-rate-change-submit" onClick={onConfirm}>
            Save {fmt(nextPct)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
