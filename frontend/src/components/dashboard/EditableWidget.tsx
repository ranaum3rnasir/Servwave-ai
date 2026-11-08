import type { ReactNode } from 'react';
import { GripVertical, X } from 'lucide-react';
import type { TimeRange } from '@/lib/dashboard/layoutTypes';
import { SelectField } from '@/components/form/SelectField';

const RANGES: TimeRange[] = ['today', '7d', '30d', 'month', 'all'];
const RANGE_LABEL: Record<TimeRange, string> = { today: 'Today', '7d': '7d', '30d': '30d', month: 'Month', all: 'All' };

export default function EditableWidget({
  id,
  edit,
  range,
  onHide,
  onRange,
  onDragStart,
  onDrop,
  children,
}: {
  id: string;
  edit: boolean;
  range: TimeRange;
  onHide: () => void;
  onRange: (r: TimeRange) => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
  children: ReactNode;
}) {
  if (!edit) return <>{children}</>;
  return (
    <div
      className="relative rounded-xl ring-2 ring-border group"
      draggable
      onDragStart={() => onDragStart(id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(id)}
    >
      <div className="absolute -top-2 left-2 z-20 flex items-center gap-1">
        <span className="cursor-grab active:cursor-grabbing rounded bg-ocean-800 text-on-fill px-1 py-0.5"><GripVertical className="h-3 w-3" /></span>
      </div>
      <div className="absolute -top-2 right-2 z-20 flex items-center gap-1">
        <div onClick={(e) => e.stopPropagation()}>
          <SelectField
            value={range}
            onValueChange={(v) => onRange(v as TimeRange)}
            className="h-auto text-[9px] font-bold text-primary bg-primary-subtle rounded-full pl-2 pr-1 py-0.5 border-border focus:outline-none"
            aria-label="Widget time range"
            options={RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
          />
        </div>
        {/* Idle neutral chip fill (bg-border-soft, matching the drag-handle chip beside it)
            plus a reveal-on-hover danger tint has no matching cell: ghost/danger#reveal has
            no idle fill, and solid/neutral has no danger-reveal hover. Forcing either would
            change the current look, so left raw per the no-invented-treatment rule. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onHide(); }}
          className="h-5 w-5 rounded bg-border-soft hover:bg-danger/10 hover:text-danger text-text-secondary flex items-center justify-center"
          aria-label="Hide widget"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="pointer-events-none select-none opacity-95">{children}</div>
    </div>
  );
}
