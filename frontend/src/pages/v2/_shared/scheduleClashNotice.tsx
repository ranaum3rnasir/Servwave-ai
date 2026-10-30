import { AlertTriangle } from 'lucide-react';

import { formatInstant } from '@/lib/schedule-tz';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import type { ScheduleConflictItem } from './scheduleConflict';

/**
 * The block a create form shows when the server refused the save because the people booked on it are already
 * booked over that slot (a 409 with `conflicts`). Nothing has been saved; "Schedule anyway" sends the same form
 * again with the form's own override. `message` says who is double-booked and the times are written in the
 * organisation's zone.
 */
export function ScheduleClashNotice({
  conflicts, timezone, message, pending, onScheduleAnyway,
}: {
  conflicts: ScheduleConflictItem[];
  timezone: string;
  /** What is booked twice, as a sentence: "A performer is already booked over this slot." */
  message: string;
  pending: boolean;
  onScheduleAnyway: () => void;
}) {
  const when = (at: string | Date) => formatInstant(String(at), timezone, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return (
    <div className="bg-status-amber-subtle flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-status-amber size-5 shrink-0" />
        <div>
          <p className="text-sm font-semibold">Scheduling conflict</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{message} Nothing has been saved yet.</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {conflicts.map((c) => (
          <div key={`${c.type}-${c.id}-${String(c.start)}`} className="flex items-center gap-2 rounded-lg border bg-kit-card px-3 py-2 text-[13px]">
            <Badge variant="softBlue" size="sm">{c.type === 'walkthrough' ? 'WT' : 'JOB'}</Badge>
            <span className="font-semibold">{c.number}</span>
            <span className="text-muted-foreground">
              {when(c.start)} - {when(c.end)}
            </span>
          </div>
        ))}
      </div>
      <div>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onScheduleAnyway}>
          {pending ? 'Scheduling...' : 'Schedule anyway'}
        </Button>
      </div>
    </div>
  );
}
