import * as React from 'react';
import { useRef, useState } from 'react';
import {
  CalendarPlus,
  Calendar as CalIcon,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Minus,
  PenLine,
  Plus,
  Users,
  ListTodo,
} from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';

import { Segment, SegmentedGroup } from '../../_shared/segmented';

/**
 * Mobile slice 42 - the scheduler's toolbar on a phone, and on a phone held sideways.
 *
 * The desktop toolbar is three clusters of a dozen controls; at 320 px it cannot be one row, and
 * on a landscape phone a second row eats the height the grid needs. This is the compact form:
 * ONE row holding what a field user touches all day (step back, the date, step forward, the
 * Day/Week/Month picker) plus a More button. Everything else sits in a bottom sheet, each control
 * under its own accessible name, so nothing is removed, only moved.
 *
 * Which controls go behind More is a judgement of how often each is used on a phone: Create,
 * Today, Standard/Member, the department filter, the visible-hours nudges, Plan Mode and the
 * legend. The row is sized for a 320 px screen: 44 + 44 + 44 + a ~72 px picker leaves the date
 * label ~90 px, which is why Today and Create are not in it.
 *
 * Every control here is 44 px on a coarse pointer, through the kit Button's own `touch:` sizes.
 */
export interface CompactToolbarProps {
  dateLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  view: string;
  viewOptions: string[];
  onViewChange: (view: string) => void;
  /** Absent for a read-only board. Receives the More button's rect, to anchor the popover to. */
  onCreate?: (anchor: { x: number; y: number }) => void;
  /** Absent when the viewer may not switch to the Member board. */
  boardMode?: { grouped: boolean; onChange: (grouped: boolean) => void };
  department: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  };
  hours: { label: string; canNarrow: boolean; canWiden: boolean; onNudge: (direction: -1 | 1) => void };
  /** Absent unless the viewer may use Plan Mode. */
  planMode?: { active: boolean; onToggle: () => void };
  /** The legend control, rendered as the board renders it. */
  legend: React.ReactNode;
  /**
   * Mobile slice 70: the unscheduled-jobs sheet. The side panel does not exist below lg, so this
   * is the way in to it; `count` is what is waiting to be scheduled.
   */
  unscheduled?: { count: number; onOpen: () => void };
}

const rowLabel = 'text-[0.75rem] font-medium text-muted-foreground';

export function CompactToolbar(props: CompactToolbarProps) {
  const { onPrev, onNext, onToday, view, viewOptions, onViewChange, onCreate, boardMode, department, hours, planMode } =
    props;
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  /** Run an action that finishes the user's business with the sheet, then close it. */
  const thenClose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div
      data-slot="schedule-compact-toolbar"
      className="flex min-w-0 shrink-0 flex-nowrap items-center gap-0.5 border-b px-2 py-0.5"
    >
      <Button
        size="icon-sm"
        variant="ghost"
        data-touch-primary
        aria-label="Previous period"
        onClick={onPrev}
      >
        <ChevronLeft />
      </Button>
      {/* `key` replays the entry animation on change, as on the desktop row. */}
      <span
        key={props.dateLabel}
        className="schedule-popup-enter min-w-0 flex-1 truncate text-center text-[0.8125rem] font-semibold"
      >
        {props.dateLabel}
      </span>
      <Button size="icon-sm" variant="ghost" data-touch-primary aria-label="Next period" onClick={onNext}>
        <ChevronRight />
      </Button>
      <SelectField
        aria-label="Calendar view"
        value={view}
        onValueChange={onViewChange}
        size="sm"
        className="data-[size=sm]:h-9 touch:data-[size=sm]:h-11 w-fit shrink-0 gap-1 px-2 text-[0.75rem] capitalize"
        options={viewOptions.map((v) => ({ value: v, label: v }))}
      />
      <Button
        ref={moreRef}
        size="icon-sm"
        variant="outline"
        data-touch-primary
        aria-label="More schedule options"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Ellipsis />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>Schedule options</SheetTitle>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {props.unscheduled && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={thenClose(props.unscheduled.onOpen)}>
                  <ListTodo />
                  Unscheduled jobs
                  <span className="rounded-full bg-muted px-1.5 text-[0.6875rem] font-semibold tabular-nums text-muted-foreground">
                    {props.unscheduled.count}
                  </span>
                </Button>
              )}
              {onCreate && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    const r = moreRef.current?.getBoundingClientRect();
                    setOpen(false);
                    onCreate({ x: r?.left ?? 0, y: r?.bottom ?? 0 });
                  }}
                >
                  <CalendarPlus />
                  Create
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={thenClose(onToday)}>
                Today
              </Button>
              {planMode && (
                <Button
                  variant={planMode.active ? 'default' : 'outline'}
                  size="sm"
                  className="gap-1.5"
                  aria-pressed={planMode.active}
                  aria-label={planMode.active ? 'Planning' : 'Plan Mode'}
                  onClick={thenClose(planMode.onToggle)}
                >
                  <PenLine />
                  {planMode.active ? 'Planning' : 'Plan Mode'}
                </Button>
              )}
              {props.legend}
            </div>

            {boardMode && (
              <div className="flex items-center justify-between gap-3">
                <span className={rowLabel}>Board</span>
                <SegmentedGroup aria-label="Board mode">
                  <Segment
                    active={!boardMode.grouped}
                    aria-label="Standard"
                    className="h-11 gap-1.5 px-3"
                    onClick={thenClose(() => boardMode.onChange(false))}
                  >
                    <CalIcon />
                    Standard
                  </Segment>
                  <Segment
                    active={boardMode.grouped}
                    aria-label="Member"
                    className="h-11 gap-1.5 px-3"
                    onClick={thenClose(() => boardMode.onChange(true))}
                  >
                    <Users />
                    Member
                  </Segment>
                </SegmentedGroup>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label className={rowLabel}>Department</Label>
              <SelectField
                aria-label="Filter schedule by department"
                value={department.value}
                onValueChange={(v) => {
                  if (v === '__add__') setOpen(false);
                  department.onChange(v);
                }}
                size="sm"
                className="data-[size=sm]:h-11 w-full"
                searchPlaceholder="Search departments…"
                emptyMessage="No departments found."
                options={department.options}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className={rowLabel}>Hours shown: {hours.label}</span>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="Show fewer hours"
                  disabled={!hours.canNarrow}
                  onClick={() => hours.onNudge(-1)}
                >
                  <Minus />
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="Show more hours"
                  disabled={!hours.canWiden}
                  onClick={() => hours.onNudge(1)}
                >
                  <Plus />
                </Button>
              </div>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
