import { StatusBadge } from '@/components/data/status-badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatInstant } from '@/lib/schedule-tz-intl';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';
import type { OpenVisitsJob } from '@/components/jobs/openVisitsConflict';

interface CompleteWithOpenVisitsDialogProps {
  open: boolean;
  /** Closing it (Go back, Escape, the backdrop) changes nothing: no visit is cancelled and no job completed. */
  onOpenChange: (open: boolean) => void;
  jobs: OpenVisitsJob[];
  /** How many jobs the choice completes. A bulk Completed over several selected jobs completes all of them, even when only some are listed. */
  completeCount?: number;
  isPending: boolean;
  /** "Cancel these visits and complete the job": the caller sends the complete again with the cancel choice. */
  onConfirm: () => void;
}

/**
 * The confirmation shown on the job page, the board and the Jobs list when completing a job that still has open
 * visits. It lists them, makes cancel-and-complete the default action, and always offers a way back. A visit is never
 * marked finished by completing the job; the cancelled ones keep their stamps as history.
 */
export function CompleteWithOpenVisitsDialog({ open, onOpenChange, jobs, completeCount = jobs.length, isPending, onConfirm }: CompleteWithOpenVisitsDialogProps) {
  const tz = useScheduleTimezone();
  const manyListed = jobs.length > 1;
  const many = completeCount > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        <DialogHeader>
          <DialogTitle>{manyListed ? 'These jobs still have open visits' : many ? 'Some of these jobs still have open visits' : 'This job still has open visits'}</DialogTitle>
          <DialogDescription>
            Completing {many ? 'a job' : 'the job'} doesn&apos;t finish its visits. Cancel the open ones and complete{' '}
            {many ? 'the jobs' : 'the job'}, or go back.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {jobs.map((job, i) => (
            <div key={job.id || i} className="space-y-1.5 rounded-lg border border-border bg-background-light p-3">
              {job.job_number && <p className="font-medium text-text-primary">{job.job_number}</p>}
              <ul className="space-y-1.5">
                {job.open_visits.map((visit) => (
                  <li key={visit.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text-primary">Visit {visit.visit_seq}</span>
                    <StatusBadge domain="job" status={visit.status} />
                    <span className="text-xs text-text-secondary">
                      {visit.scheduled_at ? formatInstant(visit.scheduled_at, tz) : 'Not scheduled'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Go back
          </Button>
          <Button variant="solid" onClick={onConfirm} disabled={isPending} autoFocus={canAutoFocus()}>
            {isPending ? 'Completing...' : many ? 'Cancel these visits and complete the jobs' : 'Cancel these visits and complete the job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
