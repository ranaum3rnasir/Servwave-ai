import { Clock } from 'lucide-react';

import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { cn } from '@/lib/utils';

import { timeLeft, useNow } from '../timeLeft';

const BY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };

/**
 * How long is left to answer a dispute: a warning box (red under 48 hours) with the time left in big type and the
 * deadline under it. The words come from the page's one `timeLeft` helper, so this reads the same as the Payment drawer's
 * alert one tap away; the minute clock keeps it true while the drawer stays open.
 */
export function DisputeDeadline({ respondBy }: { respondBy: string }) {
  const now = useNow(60_000);
  const timeZone = useScheduleTimezone();
  const left = timeLeft(respondBy, now);
  if (!left) return null;
  return (
    <div
      role="status"
      data-tone={left.urgent ? 'danger' : 'warning'}
      className={cn(
        'flex items-center gap-3 rounded-lg border px-3.5 py-3',
        left.urgent
          ? 'bg-danger-surface border-danger-border text-danger-text'
          : 'bg-warning-surface border-warning-border text-warning-text',
      )}
    >
      <Clock aria-hidden className="size-5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[18px] leading-tight font-bold tabular-nums">{left.text}</div>
        <div className="text-text-secondary text-[13px]">{`Respond by ${formatInstant(respondBy, timeZone, BY)}`}</div>
      </div>
    </div>
  );
}
