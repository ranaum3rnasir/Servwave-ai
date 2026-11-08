import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setEstimateStatusTo } from '@/lib/api/estimates';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { useOfferedLostReasonOptions } from '@/lib/api/lostReasonOptions';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/patterns/FormField';
import { SelectField } from '@/components/form/SelectField';

// R4 (2026-07-21) — port-plan §3.2's `markdeclined`/`doreason`. A staff-recorded internal decline
// REQUIRES a real LostReason enum value — the report/conversion-funnel breakdown
// (estimate-conversion-data.ts) reads this field, so a staff decline with no reason would silently
// under-count every category but "no data".
//
// The public decline route differs from this one only in being OPTIONAL. It is NOT "free-text",
// whatever this comment claimed before (corrected under SRVW-285): `declinePublic` checks
// membership in the same LostReason enum and silently drops anything else, so an unrecognized
// value there is not stored as typed — it is not stored at all. The customer's actual prose goes
// into a SEPARATE column, `lost_reason_note`, which this staff dialog does not write.
//
// Slice C — the options are the ORGANISATION's now, fetched, not the five the enum used to fix.
// An admin who adds "Designer" in Settings -> Estimate Decline Reasons sees it offered here, and
// one they switch off stops being offered. The customer's picker on the public estimate page
// resolves the same list from its own token-scoped route, so the two still offer one vocabulary
// under one set of labels — a staff member filtering the conversion report and a homeowner
// picking a reason have to mean the same thing by the same words (D7).
//
// This file did not have to learn any of that. It swapped one import for another, which is what
// `constants/lostReasons.ts` was built as a seam to make possible; the hook is what knows about
// fetching, inactive rows and the built-in fallback.

interface DeclineEstimateInternalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
}

export function DeclineEstimateInternalDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
}: DeclineEstimateInternalDialogProps) {
  const queryClient = useQueryClient();
  const options = useOfferedLostReasonOptions();
  const [reason, setReason] = useState<string>('');

  const mutation = useMutation({
    // Spec B1 — routes through the free status setter, not POST /decline-internal. That endpoint
    // still gates on SENT/PENDING, so declining a won estimate (legal now) would 400 there. The
    // setter raises the same `estimate.declined` verb and fires the same ESTIMATE_DECLINED
    // automation trigger, and it clears the stamps of whichever status is being left.
    mutationFn: () => setEstimateStatusTo(estimateId, ESTIMATE_STATUS.DECLINED, { lost_reason: reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Decline {estimateNumber}</DialogTitle>
          <DialogDescription>
            Record a verbal or off-platform loss. This does not notify the customer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Render prop, not a plain element child: FormField's cloneElement
              path would hand the generated id to `Select` (Radix's Root),
              which renders no DOM node of its own and drops it - leaving the
              label's htmlFor pointing at nothing. The trigger is the real
              labelable control, so it takes the id. This is FormField's
              documented compound-control escape hatch, no new prop. */}
          <FormField label="Reason *">
            {(fieldProps) => (
              <SelectField
                {...fieldProps}
                value={reason}
                onValueChange={setReason}
                placeholder="Why did this estimate lose?"
                options={options}
              />
            )}
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to decline estimate')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Keep Open
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => mutation.mutate()}
              disabled={!reason || mutation.isPending}
            >
              {mutation.isPending ? 'Declining...' : 'Decline Estimate'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
