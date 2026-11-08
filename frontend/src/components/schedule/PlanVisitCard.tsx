// A service-plan visit card in the sidebar's Service Plans rail (Service Plans PR A).
// Unlike a Jobs/Walkthroughs bucket card it is not a SchedulableEvent - no visit exists
// yet, so it is keyed `pv-<planId>` and materializes a real visit-Job only when dropped
// on the board. Lifted out of SchedulePage so the search highlight can hold a ref to it,
// the same way UnassignedBuckets' own cards do. ServWave tokens only.
import { useEffect, useRef } from 'react';
import { Clock, MapPin } from 'lucide-react';
import { PLAN_VISIT_PLAN_ID } from './dragChannels';
import type { SchedulerBucketPlan } from '@/lib/api/service-plans';
import { formatExactDay } from '@/lib/format-date';

export interface PlanVisitCardProps {
  plan: SchedulerBucketPlan;
  dragging: boolean;
  dragDisabled: boolean;
  /** The schedule search selected this card - ring it and scroll it into view. */
  highlighted: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}

/** Urgency drives the border, the "N left" chip, and the next-due line as one treatment. */
function urgencyClasses(plan: SchedulerBucketPlan) {
  if (plan.overdue) {
    return { border: 'border-danger-border hover:shadow-sm', chip: 'bg-danger-surface text-danger-text', due: 'text-danger-text font-medium' };
  }
  if (plan.due_soon) {
    return { border: 'border-warning-border hover:shadow-sm', chip: 'bg-warning-surface text-warning-text', due: 'text-text-secondary' };
  }
  return { border: 'border-border hover:border-sage-200 hover:shadow-sm', chip: 'bg-neutral-surface text-text-secondary', due: 'text-text-secondary' };
}

export function PlanVisitCard({
  plan,
  dragging,
  dragDisabled,
  highlighted,
  onDragStart,
  onDragEnd,
  onClick,
}: PlanVisitCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const urgency = urgencyClasses(plan);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  return (
    <div
      ref={ref}
      data-highlighted={highlighted || undefined}
      draggable={!dragDisabled}
      onDragStart={(e) => {
        e.dataTransfer.setData(PLAN_VISIT_PLAN_ID, plan.id);
        e.dataTransfer.effectAllowed = 'move';
        // Drag image: a transient off-screen chip, removed on the next frame (the browser
        // has snapshotted it by then). Painted with raw CSS because setDragImage needs a
        // real detached element, not a React subtree - tokens are read via var().
        const ghost = document.createElement('div');
        ghost.textContent = plan.service_plan_number;
        ghost.style.cssText =
          'position:fixed;top:-100px;background:rgb(var(--success));' +
          'color:rgb(var(--text-on-fill));' +
          'padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
        requestAnimationFrame(() => {
          if (document.body.contains(ghost)) document.body.removeChild(ghost);
        });
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`bg-surface-light border rounded-lg p-2.5 cursor-grab select-none transition-all duration-150
        ${dragging ? 'opacity-40 scale-[0.97] shadow-2xl border-sage-200 cursor-grabbing' : urgency.border}
        ${highlighted ? 'ring-2 ring-primary ring-offset-1 ring-offset-surface-light' : ''}`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="font-bold text-xs text-sage-700">{plan.service_plan_number}</span>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${urgency.chip}`}>
          {plan.visits_remaining === null ? 'Ongoing' : `${plan.visits_remaining} left`}
        </span>
      </div>
      <p className="text-xs text-text-primary font-medium mt-0.5 truncate">{plan.customer}</p>
      <p className="text-[11px] text-text-secondary flex items-center gap-1 mt-0.5 min-w-0">
        <MapPin className="h-3 w-3 shrink-0 text-text-soft" />
        <span className="truncate">
          {[plan.service_location.city, plan.service_location.state].filter(Boolean).join(', ')}
        </span>
      </p>
      <p className="text-[11px] text-text-secondary mt-0.5 truncate">{plan.recurrence}</p>
      <p className={`text-[11px] mt-0.5 flex items-center gap-1 ${urgency.due}`}>
        <Clock className="h-3 w-3 shrink-0" />
        Next due {formatExactDay(plan.next_due)}
      </p>
    </div>
  );
}
