import { CalendarX2 } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Dialog } from '@/ui-kit/components/ui/dialog';
import { ScheduleAlertContent } from './scheduleAlert';

export interface UnscheduleConfirmProps {
  /** The record number leaving the schedule, e.g. "J00041". */
  number: string;
  /**
   * Slice 03: a walkthrough visit whose lead still has another booked visit does not go back to
   * the bucket - only this visit leaves the schedule.
   */
  keepsAnotherVisit: boolean;
  /** Escape does the same. */
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * D6 unschedule confirm (TG10 - board card dragged to the bucket, or the editor's "Move to
 * Unscheduled"), on the kit Dialog since mobile slice 16. Opened from the editor, it replaces the
 * editor on one tick (the page gates the editor's `open` with `!unscheduleConfirm`) and Cancel
 * brings the editor back; see `scheduleAlert.tsx` for why that swap is safe.
 *
 * No notify composer here (scheduling-notifications follow-up f3): customer notifications come
 * only from the org's automations, so this confirm asks nothing about the customer and the
 * request carries no notify key.
 */
export function UnscheduleConfirm({ number, keepsAnotherVisit, onCancel, onConfirm }: UnscheduleConfirmProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <ScheduleAlertContent
        tone="brand"
        icon={<CalendarX2 />}
        title="Move to Unscheduled?"
        description={
          keepsAnotherVisit ? (
            <>
              This visit of <strong>{number}</strong> is removed from the
              schedule. The lead keeps its other booked visit.
            </>
          ) : (
            <>
              <strong>{number}</strong> goes back to its bucket. The crew is{' '}
              <strong>kept</strong>. This is not a cancellation of the job.
            </>
          )
        }
        actions={
          <>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onConfirm}>Unschedule</Button>
          </>
        }
      />
    </Dialog>
  );
}
