import type { IntervalUnit } from '@/lib/api/service-plans';
import type { EndMode, RecurrenceValue } from '@/components/service-plans/RecurrenceBuilder';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { DatePicker } from './datePicker';

/**
 * The Google-Calendar-style recurrence editor, repainted on the kit.
 *
 * Only the surface is new. The value type, the default value and
 * `recurrenceToPayload` all still live in
 * `@/components/service-plans/RecurrenceBuilder` and are imported by the
 * builder dialog - that reducer is pure, unit-tested and shared with the legacy
 * page, so forking it here would be forking business logic.
 *
 * Every `aria-label` below is byte-identical to the legacy component's. They
 * are this control's entire selector surface (it has no data-testid at all), so
 * they are the contract, not decoration.
 *
 * TWO CONTROLS CHANGED SHAPE, both because the kit ships no primitive for them
 * and the design system's raw-tag ratchet forbids adding new bare markup:
 *
 *  - the weekday chips were raw round `<button>`s; they are kit Buttons now,
 *    still `aria-pressed` toggles with the same full-day-name labels;
 *  - "Ends" was a native radio group; it is a `role="radiogroup"` of kit
 *    Buttons carrying `role="radio"` + `aria-checked`, with the same three
 *    accessible names and the same "the paired input is disabled, not hidden"
 *    rule.
 *
 * LAYOUT (SRVW-232): this used to be a 2-column grid - "Repeats every" (+
 * "Repeat on" for weekly) stacked on the left, "Ends" alone on the right -
 * so the two columns ran to different heights and the block read as one
 * lopsided card. It is a single vertical stack of three sections now:
 * Repeats every, Repeat on (weekly only), Ends - each its own row, none
 * competing with a neighbour for width. Two more changes ride along with
 * that, still inside the same acceptance criteria:
 *
 *  - the weekday chips are `flex flex-wrap` below the `sm` breakpoint and a
 *    fixed `grid-cols-7` from `sm:` up. Seven `icon-sm` (34px) chips plus
 *    gaps need 262px of min-content width, and this dialog's own content
 *    width drops to roughly 259px at a 375px viewport (`DialogContent`'s
 *    `w-[calc(100%-2.5rem)]`, minus `DialogBody`'s `px-5.5` and this card's
 *    `p-4`) - a plain `grid-cols-7` alone clips the last chip there. Above
 *    `sm` there is room, so the grid claims a constant width and never
 *    reflows when a sibling field changes its own width, same as before;
 *  - each "Ends" row is `grid-cols-[5rem_1fr]` - the radio button sits in a
 *    fixed first column, so the On/After rows' date and count inputs start
 *    at the same x position instead of trailing directly after each radio's
 *    own (unequal) label width.
 *
 * The payload shape, `recurrenceToPayload` and every aria-label/name are
 * untouched - only className and DOM nesting moved.
 */

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

const END_MODES: { mode: EndMode; label: string; ariaLabel: string }[] = [
  { mode: 'never', label: 'Never', ariaLabel: 'Never ends' },
  { mode: 'on', label: 'On', ariaLabel: 'Ends on a date' },
  { mode: 'after', label: 'After', ariaLabel: 'Ends after a number of occurrences' },
];

function RecurrenceBuilder({
  value, onChange,
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

  const endModeButton = (mode: EndMode) => {
    const entry = END_MODES.find((e) => e.mode === mode)!;
    return (
      <Button
        role="radio"
        aria-checked={value.end_mode === mode}
        aria-label={entry.ariaLabel}
        variant={value.end_mode === mode ? 'default' : 'outline'}
        size="sm"
        onClick={() => set({ end_mode: mode })}
      >
        {entry.label}
      </Button>
    );
  };

  // One section per row, stacked - see the header note on why this replaced
  // the old 2-column grid.
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-col gap-4">
        {/* Repeats every */}
        <div>
          {/* Heads a compound control (Input + Select), so it is a plain Label
              with no htmlFor rather than a single-control field. */}
          <Label>Repeats every</Label>
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

        {/* Repeat on - weekly only, exactly as today. `flex flex-wrap` below
            `sm` so seven chips wrap instead of clipping the dialog's edge at
            a phone width; a fixed `grid-cols-7` from `sm:` up claims a
            constant width and never reflows when a sibling row's own width
            changes - see the header note for the 375px arithmetic. */}
        {value.interval_unit === 'WEEK' && (
          <div>
            <Label>Repeat on</Label>
            <div className="mt-1 flex w-fit flex-wrap gap-1 sm:grid sm:grid-cols-7">
              {WEEKDAY_CHIPS.map((c) => (
                <Button
                  key={c.d}
                  size="icon-sm"
                  variant={value.byweekday.includes(c.d) ? 'default' : 'secondary'}
                  aria-pressed={value.byweekday.includes(c.d)}
                  aria-label={c.name}
                  onClick={() => toggleDay(c.d)}
                >
                  {c.short}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Ends. Each row is a fixed-width label column + a fluid input
            column, so the On/After rows' date and count inputs line up
            under each other instead of trailing directly after each
            radio's own (unequal) label width. */}
        <div>
          <Label id="v2-recurrence-ends-label">Ends</Label>
          <div role="radiogroup" aria-labelledby="v2-recurrence-ends-label" className="mt-1 flex flex-col gap-2">
            <div className="grid grid-cols-[5rem_1fr] items-center gap-2">{endModeButton('never')}</div>
            <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
              {endModeButton('on')}
              <DatePicker
                value={value.end_date}
                disabled={value.end_mode !== 'on'}
                onChange={(v) => set({ end_date: v })}
                className="min-w-0"
                aria-label="End date"
              />
            </div>
            <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
              {endModeButton('after')}
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={value.occurrence_count}
                  disabled={value.end_mode !== 'after'}
                  onChange={(e) => set({ occurrence_count: Math.max(1, Number(e.target.value) || 1) })}
                  className="w-16"
                  aria-label="Occurrence count"
                />
                <span className="text-muted-foreground shrink-0 text-sm">occurrences</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { RecurrenceBuilder };
