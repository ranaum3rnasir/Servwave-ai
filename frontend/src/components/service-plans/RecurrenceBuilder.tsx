import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/form/DatePicker';
import { SelectField } from '@/components/form/SelectField';
import type { IntervalUnit } from '@/lib/api/service-plans';

// A Google-Calendar-style recurrence editor. Fully controlled so it stays trivially testable and
// the parent owns the state. byweekday uses 0–6 (0=Sun), matching the API + describeRecurrence.

export type EndMode = 'never' | 'on' | 'after';

export interface RecurrenceValue {
  interval_unit: IntervalUnit;
  interval_count: number;
  byweekday: number[];
  end_mode: EndMode;
  end_date: string; // yyyy-mm-dd (only used when end_mode === 'on')
  occurrence_count: number; // only used when end_mode === 'after'
}

export const DEFAULT_RECURRENCE: RecurrenceValue = {
  interval_unit: 'MONTH',
  interval_count: 1,
  byweekday: [],
  end_mode: 'never',
  end_date: '',
  occurrence_count: 12,
};

/** Reduce the builder's UI state to the create/update API recurrence fields. */
export function recurrenceToPayload(v: RecurrenceValue): {
  interval_unit: IntervalUnit;
  interval_count: number;
  byweekday: number[];
  end_date: string | null;
  occurrence_count: number | null;
} {
  return {
    interval_unit: v.interval_unit,
    interval_count: Math.max(1, v.interval_count),
    byweekday: v.interval_unit === 'WEEK' ? v.byweekday : [],
    end_date: v.end_mode === 'on' && v.end_date ? new Date(v.end_date).toISOString() : null,
    occurrence_count: v.end_mode === 'after' ? Math.max(1, v.occurrence_count) : null,
  };
}

const UNIT_OPTIONS: { value: IntervalUnit; label: string }[] = [
  { value: 'DAY', label: 'days' },
  { value: 'WEEK', label: 'weeks' },
  { value: 'MONTH', label: 'months' },
  { value: 'YEAR', label: 'years' },
];

// 0=Sun..6=Sat (matches the API byweekday convention). Sunday-first like Google's US layout.
const WEEKDAY_CHIPS: { d: number; short: string; name: string }[] = [
  { d: 0, short: 'S', name: 'Sunday' },
  { d: 1, short: 'M', name: 'Monday' },
  { d: 2, short: 'T', name: 'Tuesday' },
  { d: 3, short: 'W', name: 'Wednesday' },
  { d: 4, short: 'T', name: 'Thursday' },
  { d: 5, short: 'F', name: 'Friday' },
  { d: 6, short: 'S', name: 'Saturday' },
];

export function RecurrenceBuilder({
  value,
  onChange,
}: {
  value: RecurrenceValue;
  onChange: (v: RecurrenceValue) => void;
}) {
  const set = (patch: Partial<RecurrenceValue>) => onChange({ ...value, ...patch });
  const toggleDay = (d: number) =>
    set({
      byweekday: value.byweekday.includes(d)
        ? value.byweekday.filter((x) => x !== d)
        : [...value.byweekday, d].sort((a, b) => a - b),
    });

  // Two columns so the card fills the dialog's width: "how often" on the left (with the weekday
  // chips for weekly), "when it ends" on the right. Stacks to one column on narrow screens.
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {/* Left: how often it repeats (+ which weekdays, for weekly) */}
        <div className="space-y-3">
          <div>
            {/* Label sits above a compound control (Input + Select), not a single sibling -
                outside this pass's FormField fit criteria (see FormField.tsx's own header
                comment on compound fields). Left raw. */}
            <label className="text-sm text-text-secondary">Repeats every</label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={value.interval_count}
                onChange={(e) => set({ interval_count: Math.max(1, Number(e.target.value) || 1) })}
                className="w-20"
                aria-label="Interval count"
              />
              <SelectField
                value={value.interval_unit}
                onValueChange={(v) => set({ interval_unit: v as IntervalUnit })}
                className="flex-1"
                aria-label="Interval unit"
                options={UNIT_OPTIONS}
              />
            </div>
          </div>

          {/* Weekday chips (weekly only) */}
          {value.interval_unit === 'WEEK' && (
            <div>
              {/* Label sits above a group of toggle buttons (not a form control at all) - not a
                  FormField-shape site, left raw. */}
              <label className="text-sm text-text-secondary">Repeat on</label>
              <div className="mt-1 flex flex-wrap gap-1">
                {WEEKDAY_CHIPS.map((c, i) => {
                  const active = value.byweekday.includes(c.d);
                  return (
                    // Weekday chip (segmented toggle group, rounded-full) - not Button-shaped.
                    // Deferred.
                    <button
                      key={i}
                      type="button"
                      aria-pressed={active}
                      aria-label={c.name}
                      onClick={() => toggleDay(c.d)}
                      className={`h-8 w-8 rounded-full text-xs font-medium transition-colors ${
                        active ? 'bg-primary text-on-fill' : 'bg-background-light text-text-secondary hover:bg-border'
                      }`}
                    >
                      {c.short}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right: when it ends */}
        <div>
          {/* Label sits above a radio group (compound control), not a single sibling - not a
              FormField-shape site, left raw. */}
          <label className="text-sm text-text-secondary">Ends</label>
          <div className="mt-1 space-y-2">
            {/* Radio row (label wraps its control) - not a FormField-shape site, left raw. */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="recurrence-end-mode"
                aria-label="Never ends"
                checked={value.end_mode === 'never'}
                onChange={() => set({ end_mode: 'never' })}
              />
              Never
            </label>
            {/* Radio row (label wraps its control, and also fronts a second sibling Input) -
                not a FormField-shape site, left raw. */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="recurrence-end-mode"
                aria-label="Ends on a date"
                checked={value.end_mode === 'on'}
                onChange={() => set({ end_mode: 'on' })}
              />
              <span className="shrink-0">On</span>
              <DatePicker
                value={value.end_date}
                disabled={value.end_mode !== 'on'}
                onChange={(v) => set({ end_date: v })}
                className="min-w-0 flex-1"
                aria-label="End date"
              />
            </label>
            {/* Radio row (label wraps its control, and also fronts a second sibling Input) -
                not a FormField-shape site, left raw. */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="recurrence-end-mode"
                aria-label="Ends after a number of occurrences"
                checked={value.end_mode === 'after'}
                onChange={() => set({ end_mode: 'after' })}
              />
              <span className="shrink-0">After</span>
              <Input
                type="number"
                min={1}
                value={value.occurrence_count}
                disabled={value.end_mode !== 'after'}
                onChange={(e) => set({ occurrence_count: Math.max(1, Number(e.target.value) || 1) })}
                className="w-16"
                aria-label="Occurrence count"
              />
              <span className="shrink-0 text-text-secondary">occurrences</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
