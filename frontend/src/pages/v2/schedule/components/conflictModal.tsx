import * as React from 'react';
import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { formatInstant } from '@/lib/schedule-tz';
import { EN } from '../glyphs';
import type { ScheduleConflictItem } from '@/pages/v2/_shared/scheduleConflict';

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
 * The "Schedule Anyway" conflict modal (Q6 + a11y).
 *
 * DELIBERATELY NOT a Radix Dialog - see the comment at its one call site in SchedulePage.tsx.
 * `conflictToast` can be set from inside an already-open EventEditor (a live 409 on
 * `handleEditorSaveTime`), and EventEditor's own Dialog is gated `!conflictToast &&
 * !unscheduleConfirm` specifically to avoid two Radix dialogs' focus locks fighting on the same
 * tick. So the a11y semantics below are hand-rolled instead of inherited from the kit primitive:
 * `role="alertdialog"`, `aria-modal`, `aria-label`, focus moved into the panel on mount and
 * restored to whatever held it on unmount (the parent conditionally renders this component, so
 * mount/unmount already stands in for open/close).
 *
 * NO FOCUS TRAP: Tab is not contained inside the panel, unlike a Radix dialog. Escape already
 * closes this modal via the page's existing global keydown handler (SchedulePage.tsx), which
 * this component does not duplicate.
 */
export function ConflictModal({ message, conflicts, tz, isLoading = false, onCancel, onConfirm }: ConflictModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      // Guard the call, not just the ref: jsdom and some browsers give a detached element a
      // `.focus` method that throws once it is out of the document.
      previouslyFocused.current?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-surface bg-scrim/50 backdrop-blur-[3px] flex items-center justify-center p-4">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="Scheduling conflict"
        tabIndex={-1}
        className="w-full max-w-md bg-kit-card rounded-xl border p-6 shadow-modal focus:outline-none focus:ring-[3px] focus:ring-ring/25"
      >
        <div className="flex items-start gap-3.5 mb-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-status-amber-subtle text-status-amber [&_svg]:size-5">
            <AlertTriangle />
          </span>
          <div>
            <p className="text-[16.5px] font-bold tracking-tight">Scheduling Conflict</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{message}</p>
          </div>
        </div>
        {conflicts && conflicts.length > 0 && (
          <div className="mb-4 space-y-2">
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
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button isLoading={isLoading} onClick={onConfirm}>
            {isLoading ? 'Scheduling...' : 'Schedule Anyway'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConflictModal;
