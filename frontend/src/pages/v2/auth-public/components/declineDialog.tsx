import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';

import { DeclineReasonFields } from './declineReasonFields';

interface DeclineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Held true while the decline is in flight. */
  isPending: boolean;
  reason: string;
  onReasonChange: (reason: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  options: { value: string; label: string }[];
}

/**
 * The public estimate's "Decline Estimate" confirmation: a yes/no with two optional questions.
 *
 * Its own file, loaded lazily by `PublicEstimatePage`, so the dialog and the searchable picker in
 * it (a Radix dialog, a popover and the positioning library behind them) are not part of the
 * 200 KB a customer downloads before the estimate paints (mobile slice 47). The page owns every
 * piece of state; this renders it. Behaviour is exactly what the page rendered inline before:
 * see the notes at the call site (no `confirmDisabled`, answers reset on close).
 */
export default function DeclineDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  reason,
  onReasonChange,
  note,
  onNoteChange,
  options,
}: DeclineDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Decline Estimate"
      description="This estimate will be marked declined and we will be notified. If you have a moment, tell us why - it is optional and you can decline without answering."
      destructive
      cancelLabel="Go Back"
      confirmLabel="Decline Estimate"
      onConfirm={onConfirm}
      isPending={isPending}
    >
      <DeclineReasonFields
        reason={reason}
        onReasonChange={onReasonChange}
        note={note}
        onNoteChange={onNoteChange}
        disabled={isPending}
        options={options}
      />
    </ConfirmDialog>
  );
}
