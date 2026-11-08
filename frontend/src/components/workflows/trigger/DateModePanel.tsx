/**
 * DateModePanel — Step 3 of the two-mode trigger builder's date branch
 * ("Before or after a date"), shown once a subject and date mode (ModeFork)
 * are chosen. Renders the timing offset: four one-tap presets, plus a
 * "Custom…" chip that reveals a single-row editor — [number] [unit]
 * [Before|After segmented] {anchorLabel}. — for any other before/after
 * offset. Every path through this UI (preset OR custom) always resolves to
 * a concrete `{ direction, offsetMinutes }` pair. There is deliberately NO
 * "on the day" / "morning of" / vague day-part option anywhere in this
 * component — the product owner explicitly rejected that concept for this
 * whole redesign (see the task brief), so do not reintroduce one here.
 *
 * Mirrors md_files/specs/automations/2026-07-17-timing-builder/index.html's
 * "STAGE 3b: date timing" screen — the `PRESETS` labels/values, the
 * "Custom…" chip, the "Custom timing" section label, and the custom row's
 * `[number] [unit] [segmented] {anchor}.` layout are copied verbatim from
 * that approved mockup. Three deliberate deviations, flagged here rather
 * than silently guessed:
 *
 * 1. The mockup's heading/subheading interpolate TWO separate anchor
 *    strings per subject — a short `anchor.word` ("the appointment") for
 *    the question, and a longer `anchor.sub` ("the job's scheduled time")
 *    for the "Counts from …" subheading clause. This component's only prop
 *    for that is `anchorLabel` (one string), and the real served data
 *    (backend/src/services/automations/anchors.ts's `ANCHOR_LABELS`) only
 *    ever ships the ONE label per anchor — there is no second `sub` string
 *    anywhere in the real system — so `anchorLabel` is reused for both.
 * 2. The mockup's segmented Before/After control is fully pill-shaped
 *    (`border-radius:999px`). ServWave's `rounded-pill` token is reserved
 *    for "notify-count / avatar / switch only" (tailwind.config.js), so
 *    this uses the standard 6px control radius instead — the same
 *    resolution WaitForm.tsx's pre-existing anchored-wait Before/After
 *    toggle already made for the identical control.
 * 3. The custom row's unit dropdown offers minutes/hours/days/weeks per the
 *    task brief and mockup, but the shared `lib/workflows/timing.ts`
 *    utilities (`UNIT_MINUTES`/`splitOffset`, also used by TriggerForm.tsx
 *    and WaitForm.tsx's own custom-offset editors) only cover minutes/
 *    hours/days — `OffsetUnit` has no 'weeks' member. Reused as-is for
 *    those three units; a `weeks` entry is added locally
 *    (`CUSTOM_UNIT_MINUTES`, derived from the shared `UNIT_MINUTES.days`
 *    constant, not a new magic number) purely to cover the one unit the
 *    shared module doesn't have. `splitOffset` itself (used to seed the
 *    custom fields from an existing offsetMinutes — e.g. reopening a saved
 *    custom pick) is used unmodified and, matching its existing behavior
 *    everywhere else it's called, never produces 'weeks' on that reverse
 *    path (a stored 2-week value seeds as "14 days" — numerically
 *    identical, not a bug).
 *
 * Local-state note: `customOpen` (whether the custom row is expanded) plus
 * the custom row's own number/unit fields are seeded once from the incoming
 * `value` (via `useState` initializers), then kept in sync only through this
 * component's own handlers — not through a `useEffect` that re-seeds on
 * every later `value` prop change. This mirrors TriggerForm.tsx's and
 * WaitForm.tsx's existing custom-offset editors (same pattern, same
 * tradeoff: a *later*, external prop change to a custom, non-preset value
 * after mount won't reactively reopen/reseed the row). The four PRESET
 * chips' highlighted state, by contrast, IS fully reactive — it's computed
 * fresh from `value` on every render.
 */

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UNIT_MINUTES, splitOffset, type OffsetUnit } from '@/lib/workflows/timing';

type Direction = 'before' | 'after';
type CustomUnit = OffsetUnit | 'weeks';

export interface DateOffset {
  direction: Direction;
  offsetMinutes: number;
}

export interface DateModePanelProps {
  anchorLabel: string;
  value: DateOffset | null;
  onChange: (v: DateOffset) => void;
  /**
   * When false, the whole "after" direction is hidden — both `after` presets
   * drop out and the custom row loses its After segment (direction is forced
   * `before`). Used for the Estimate subject: "N after the estimate expiration"
   * can never fire, because estimate-expiration.ts CANCELs the estimate the
   * moment `valid_until` passes and the date-anchor sweep only selects
   * SENT/PENDING. Offering it would be a control that silently never works.
   * Defaults true — every other subject supports both directions.
   */
  allowAfter?: boolean;
}

interface Preset {
  key: string;
  label: string;
  minutes: number;
  direction: Direction;
}

/** Approved presets — verbatim. No day-of/morning-of/"on the day" option (see docblock above). */
const PRESETS: Preset[] = [
  { key: '1d_before', label: '1 day before', minutes: 1440, direction: 'before' },
  { key: '2h_before', label: '2 hours before', minutes: 120, direction: 'before' },
  { key: '1d_after', label: '1 day after', minutes: 1440, direction: 'after' },
  { key: '3d_after', label: '3 days after', minutes: 4320, direction: 'after' },
];

/** Extends the shared UNIT_MINUTES with 'weeks' (see docblock point 3) — derived, not a new magic number. */
const CUSTOM_UNIT_MINUTES: Record<CustomUnit, number> = {
  ...UNIT_MINUTES,
  weeks: UNIT_MINUTES.days * 7,
};

const CUSTOM_UNIT_OPTIONS: { value: CustomUnit; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
  { value: 'weeks', label: 'weeks' },
];

const DIRECTION_LABEL: Record<Direction, string> = { before: 'Before', after: 'After' };

/** The default seed for the custom row when there's no existing value to split (nothing chosen yet). */
const DEFAULT_CUSTOM_SEED: { value: number; unit: OffsetUnit } = { value: 1, unit: 'days' };

function findMatchingPreset(value: DateOffset | null, presets: Preset[]): Preset | undefined {
  if (value === null) return undefined;
  return presets.find((p) => p.direction === value.direction && p.minutes === value.offsetMinutes);
}

/**
 * All 2 `<button>` JSX sites built from this helper (the PRESETS `.map()`
 * chip and the "Custom…" chip) are segmented toggle controls (aria-pressed,
 * mutually-exclusive selection) - a documented non-Button shape the UI
 * component architecture program calls out as expected to stay raw.
 */
function presetChipClass(active: boolean, dashed: boolean): string {
  return `min-h-11 rounded-pill border px-3.5 py-2 text-[13px] font-bold transition-colors ${dashed ? 'border-dashed' : ''} ${
    active
      ? 'border-primary bg-primary text-on-fill'
      : 'border-border bg-surface-light text-text-secondary hover:border-primary-light'
  }`;
}

/**
 * Same reason as `presetChipClass` above: its 1 `<button>` JSX site (the
 * before/after direction segment, rendered twice via `.map()`) is a
 * segmented toggle control and left raw.
 */
function segmentClass(active: boolean): string {
  return `min-h-9 rounded px-3 py-1.5 text-[12.5px] font-bold transition-colors ${
    active ? 'bg-surface-light text-primary shadow-soft' : 'text-text-secondary hover:text-text-primary'
  }`;
}

export default function DateModePanel({ anchorLabel, value, onChange, allowAfter = true }: DateModePanelProps) {
  // With after disallowed, the after presets drop out and every direction the
  // panel can emit is forced to 'before'.
  const presets = allowAfter ? PRESETS : PRESETS.filter((p) => p.direction === 'before');
  const matchedPreset = findMatchingPreset(value, presets);

  const [customOpen, setCustomOpen] = useState(() => value !== null && !matchedPreset);
  const initialSeed = value !== null ? splitOffset(value.offsetMinutes) : DEFAULT_CUSTOM_SEED;
  const [customNumberText, setCustomNumberText] = useState(() => String(initialSeed.value));
  const [customUnit, setCustomUnit] = useState<CustomUnit>(() => initialSeed.unit);
  const [customDirection, setCustomDirection] = useState<Direction>(() =>
    allowAfter ? value?.direction ?? 'before' : 'before',
  );

  /** Reads the FULL current trio (not just whichever field just changed) so any single-field edit recomputes correctly. */
  function commitCustom(rawText: string, unit: CustomUnit, direction: Direction) {
    const n = Number(rawText);
    if (rawText.trim() === '' || !Number.isFinite(n) || n < 0) return;
    const offsetMinutes = n * CUSTOM_UNIT_MINUTES[unit];
    // Only whole-minute offsets are structurally valid (mirrors TriggerForm's/WaitForm's own
    // "don't propagate a value the server would 400 on" guard) — e.g. "1.5 minutes" is rejected,
    // "0.5 hours" (=30) is fine.
    if (!Number.isInteger(offsetMinutes)) return;
    onChange({ direction, offsetMinutes });
  }

  function pickPreset(preset: Preset) {
    setCustomOpen(false);
    onChange({ direction: preset.direction, offsetMinutes: preset.minutes });
  }

  function openCustom() {
    if (value !== null) {
      const seed = splitOffset(value.offsetMinutes);
      setCustomNumberText(String(seed.value));
      setCustomUnit(seed.unit);
      setCustomDirection(allowAfter ? value.direction : 'before');
    }
    setCustomOpen(true);
  }

  return (
    <div>
      {/* Raw h3, deferred: text-[15px] has no matching Heading scale key, and
          font-extrabold has no matching Heading weight (semibold/bold only). */}
      <h3 className="text-[15px] font-extrabold tracking-tight text-text-primary">How far from {anchorLabel}?</h3>
      <p className="mb-3.5 mt-0.5 text-[12.5px] text-text-secondary">
        Tap a common timing, or set your own. Counts from {anchorLabel}.
      </p>

      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = !customOpen && matchedPreset?.key === preset.key;
          return (
            <button
              key={preset.key}
              type="button"
              aria-pressed={active}
              onClick={() => pickPreset(preset)}
              className={presetChipClass(active, false)}
            >
              {preset.label}
            </button>
          );
        })}
        <button type="button" aria-pressed={customOpen} onClick={openCustom} className={presetChipClass(customOpen, true)}>
          Custom…
        </button>
      </div>

      {customOpen && (
        <div className="mt-3.5 rounded-card border border-dashed border-border bg-surface-light p-3.5">
          <div className="mb-2 text-[11px] font-extrabold uppercase tracking-wide text-text-secondary">Custom timing</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={0}
              value={customNumberText}
              onChange={(e) => {
                setCustomNumberText(e.target.value);
                commitCustom(e.target.value, customUnit, customDirection);
              }}
              aria-label="Timing amount"
              className="h-11 w-24"
            />
            <Select
              value={customUnit}
              onValueChange={(v) => {
                const unit = v as CustomUnit;
                setCustomUnit(unit);
                commitCustom(customNumberText, unit, customDirection);
              }}
            >
              <SelectTrigger className="h-11 w-32" aria-label="Timing unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CUSTOM_UNIT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* With after disallowed there's only one direction, so the toggle is
                dropped entirely rather than shown as a lone locked "Before" segment. */}
            {allowAfter && (
              <span className="inline-flex gap-0.5 rounded border border-border bg-background-light p-0.5">
                {(['before', 'after'] as const).map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    aria-pressed={customDirection === dir}
                    onClick={() => {
                      setCustomDirection(dir);
                      commitCustom(customNumberText, customUnit, dir);
                    }}
                    className={segmentClass(customDirection === dir)}
                  >
                    {DIRECTION_LABEL[dir]}
                  </button>
                ))}
              </span>
            )}

            <span className="text-[13.5px] font-extrabold text-primary">{anchorLabel}</span>
            <span className="text-[13.5px] font-semibold text-text-primary">.</span>
          </div>
        </div>
      )}
    </div>
  );
}
