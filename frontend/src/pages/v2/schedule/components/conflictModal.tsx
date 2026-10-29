import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog } from '@/ui-kit/components/ui/dialog';
import { formatInstant } from '@/lib/schedule-tz';
import { EN } from '../glyphs';
import type { ScheduleConflictItem } from '@/pages/v2/_shared/scheduleConflict';
import { ScheduleAlertContent } from './scheduleAlert';

/** U+00B7 MIDDLE DOT - joins the optional row segments (customer, crew, date). Not a dash. */
const DOT = '·';

export interface ConflictModalProps {
  message: string;
  /** Additive `crew` / `customer_name` may be absent - see ScheduleConflictItem. */
  conflicts?: ScheduleConflictItem[];
  /** The org zone - every date/time in this modal renders on it, never the viewer's. */
  tz: string;
  isLoading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** "Alice Ng, Bob Reyes" from the clashing crew, or null if the body carries none. */
function crewNames(crew: ScheduleConflictItem['crew']): string | null {
  if (!crew || crew.length === 0) return null;
  const names = crew.map((m) => m.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : null;
}

/** The row's detail line: customer · crew · weekday, date · time window - each part optional. */
function rowDetail(c: ScheduleConflictItem, tz: string): string {
  const weekdayDate = formatInstant(c.start, tz, { weekday: 'short', month: 'short', day: 'numeric' });
  const window =
    `${formatInstant(c.start, tz, { hour: 'numeric', minute: '2-digit' })} ${EN} ` +
    `${formatInstant(c.end, tz, { hour: 'numeric', minute: '2-digit' })}`;
  const dateWindow = weekdayDate ? `${weekdayDate} ${DOT} ${window}` : window;
  const parts = [c.customer_name ?? null, crewNames(c.crew), dateWindow].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  return parts.join(` ${DOT} `);
}

/**
 * The "Schedule Anyway" conflict modal (Q6 + a11y), on the kit Dialog since mobile slice 16.
 *
 * The parent renders it only while `conflictToast` is set, so mount and unmount stand in for
 * open and close, and Escape is the same as Cancel. `conflictToast` can be set from inside the
 * open EventEditor (a live 409), whose `open` is gated `!conflictToast`: the editor closes as this
 * opens. What the primitive brings, and why that swap is safe on it, is in `scheduleAlert.tsx`.
 */
export function ConflictModal({ message, conflicts, tz, isLoading = false, onCancel, onConfirm }: ConflictModalProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <ScheduleAlertContent
        tone="warning"
        icon={<AlertTriangle />}
        title="Scheduling Conflict"
        description={message}
        actions={
          <>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button isLoading={isLoading} onClick={onConfirm}>
              {isLoading ? 'Scheduling...' : 'Schedule Anyway'}
            </Button>
          </>
        }
      >
        {conflicts && conflicts.length > 0 ? (
          <div className="space-y-2">
            {conflicts.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-[13px] bg-status-amber-subtle rounded-lg px-3 py-2 border">
                {/* Walkthrough and job share one accent family, so the WT/JOB label carries the distinction on its own. */}
                <Badge variant="softBlue" size="sm">
                  {c.type === 'walkthrough' ? 'WT' : 'JOB'}
                </Badge>
                <span className="font-semibold">{c.number}</span>
                <span className="text-muted-foreground">{rowDetail(c, tz)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </ScheduleAlertContent>
    </Dialog>
  );
}

export default ConflictModal;
