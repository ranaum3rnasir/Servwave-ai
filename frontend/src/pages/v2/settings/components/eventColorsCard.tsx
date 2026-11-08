/**
 * Per-organization scheduler event colours - the picker.
 *
 * One way in, per the product decision on 2026-09-15: a swatch per design-system token in
 * SCHEDULE_EVENT_PALETTE, and nothing else. No custom hex, no picker - the org chooses from the
 * palette the app already ships, so a board can never carry a colour the design system does not
 * own, and a retuned token repaints every org that chose it.
 *
 * "Unset" is a real, reachable state, not an absence: Reset removes the key entirely so the type
 * goes back to following the design system, which is what lets the tokens keep moving under orgs
 * that never opted out. That is why this writes a partial map rather than four always-present
 * values.
 */
import { EVENT_TYPE_META, type EventType } from '@/components/schedule/scheduleModel';
import { SCHEDULE_EVENT_PALETTE } from '@/design-system/scheduleEventPalette';
import type { ScheduleEventColors } from '@/lib/schedule/eventColors';

/**
 * The preview swatch for an UNCUSTOMISED type paints with the board's own ev-* utility rather
 * than a copy of the default: the default shown here can never drift from the default the board
 * actually paints.
 */
const TYPE_SWATCH: Record<EventType, string> = {
  job: 'bg-ev-job',
  walkthrough: 'bg-ev-walkthrough',
  'service-plan': 'bg-ev-service-plan',
  'calendar-entry': 'bg-ev-calendar-entry',
};

const ORDER: EventType[] = ['job', 'walkthrough', 'service-plan', 'calendar-entry'];

interface Props {
  value: ScheduleEventColors;
  onChange: (next: ScheduleEventColors) => void;
}

function EventColorRow({
  type,
  value,
  onChange,
}: {
  type: EventType;
  value: ScheduleEventColors;
  onChange: (next: ScheduleEventColors) => void;
}) {
  const set = value[type];
  const chosen = set ? SCHEDULE_EVENT_PALETTE.find((e) => e.token === set)?.label : undefined;

  const commit = (token: string) => onChange({ ...value, [type]: token });
  const reset = () => {
    const next = { ...value };
    delete next[type];
    onChange(next);
  };

  return (
    <div className="border-border border-t py-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`border-border h-5 w-5 shrink-0 rounded-sm border ${set ? '' : TYPE_SWATCH[type]}`}
          // A token reference, not a colour: `rgb(var(--sage-700))` is what the board paints with.
          style={set ? { backgroundColor: `rgb(var(--${set}))` } : undefined}
        />
        <span className="text-sm font-medium">{EVENT_TYPE_META[type].label}</span>
        {/* The chosen colour's NAME, so the row reads as a legend entry ("Job - Sage"), not only a
            square of colour. */}
        {chosen && (
          <span data-chosen-colour className="text-muted-foreground text-xs">
            {chosen}
          </span>
        )}
        {set ? (
          <button
            type="button"
            onClick={reset}
            className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
          >
            Reset to default
          </button>
        ) : (
          <span className="text-muted-foreground text-xs">Using the default</span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label={`${EVENT_TYPE_META[type].label} colour`}
        className="flex flex-wrap gap-1.5"
      >
        {SCHEDULE_EVENT_PALETTE.map(({ token, label }) => (
          <button
            key={token}
            type="button"
            role="radio"
            aria-checked={set === token}
            aria-label={label}
            title={label}
            onClick={() => commit(token)}
            style={{ backgroundColor: `rgb(var(--${token}))` }}
            className={`h-7 w-7 rounded-sm border transition-[outline] ${
              set === token
                ? 'border-transparent outline outline-2 outline-offset-2 outline-primary'
                : 'border-border hover:outline hover:outline-1 hover:outline-offset-2 hover:outline-border'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export function EventColorsCard({ value, onChange }: Props) {
  return (
    <div>
      {ORDER.map((type) => (
        <EventColorRow key={type} type={type} value={value} onChange={onChange} />
      ))}
    </div>
  );
}
