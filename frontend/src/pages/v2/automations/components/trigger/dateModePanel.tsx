import { useState } from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { cn } from '@/ui-kit/lib/utils';
import { UNIT_MINUTES, splitOffset, type OffsetUnit } from '@/lib/workflows/timing';

import { ELLIPSIS } from '../glyphs';

/**
 * Step 3, date branch. Four one-tap presets plus a "Custom" chip that reveals
 * a single-row editor: [number] [unit] [Before|After] {anchor}.
 *
 * There is deliberately NO "on the day" / "morning of" / day-part option
 * anywhere in this component. The product owner explicitly rejected the
 * concept for the whole redesign; do not reintroduce one.
 *
 * `commitCustom` refuses to emit when the text is blank, non-finite, negative,
 * or when the product is not a whole number of minutes. Every push here feeds
 * a debounced autosave, so an invalid value would 400 on a loop.
 *
 * `customOpen` and the custom fields seed ONCE from `value`; the four preset
 * chips' active state, by contrast, is fully reactive. Same tradeoff the
 * legacy panel documents.
 */

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
   * Which directions this timing may run in. A direction left out of the list is hidden
   * completely: its presets drop out and it loses its segment in the custom row.
   *
   * Two different rules narrow it, and they point opposite ways. The Estimate subject is
   * before-only, because "N after the estimate expiration" can never fire - the expiry sweep
   * cancels the estimate at `valid_until`, so nothing survives to count forward from. A lead stage
   * clock is after-only, because it records a moment as it happens, so counting BEFORE one is a
   * rule the backend refuses to save. Both were controls that silently never worked; the caller
   * intersects them and this panel just renders what is left.
   */
  allowedDirections?: Direction[];
}

interface Preset {
  key: string;
  label: string;
  minutes: number;
  direction: Direction;
}

/** Approved presets, verbatim. */
const PRESETS: Preset[] = [
  { key: '1d_before', label: '1 day before', minutes: 1440, direction: 'before' },
  { key: '2h_before', label: '2 hours before', minutes: 120, direction: 'before' },
  { key: '1d_after', label: '1 day after', minutes: 1440, direction: 'after' },
  { key: '3d_after', label: '3 days after', minutes: 4320, direction: 'after' },
];

/** Extends the shared UNIT_MINUTES with weeks. Derived, not a new magic number. */
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

/** Seed for the custom row when there is no existing value to split. */
const DEFAULT_CUSTOM_SEED: { value: number; unit: OffsetUnit } = { value: 1, unit: 'days' };

function findMatchingPreset(value: DateOffset | null, presets: Preset[]): Preset | undefined {
  if (value === null) return undefined;
  return presets.find((p) => p.direction === value.direction && p.minutes === value.offsetMinutes);
}

/** The pill chip look. The kit has no toggle-chip cell, so it is composed on Button. */
function chipClass(active: boolean, dashed: boolean): string {
  return cn(
    'min-h-11 rounded-full px-3.5 text-[13px] font-bold',
    dashed && 'border-dashed',
    active
      ? 'border-primary bg-primary text-primary-foreground hover:opacity-90'
      : 'border-input bg-kit-card text-muted-foreground hover:border-brand',
  );
}

export default function DateModePanel({
  anchorLabel,
  value,
  onChange,
  allowedDirections = ['before', 'after'],
}: DateModePanelProps) {
  // Presets for a direction this anchor cannot use drop out entirely, so every direction this
  // panel can emit is one the save will accept.
  const allows = (d: Direction) => allowedDirections.includes(d);
  const fallbackDirection: Direction = allows('before') ? 'before' : 'after';
  const presets = PRESETS.filter((p) => allows(p.direction));
  const matchedPreset = findMatchingPreset(value, presets);

  const [customOpen, setCustomOpen] = useState(() => value !== null && !matchedPreset);
  const initialSeed = value !== null ? splitOffset(value.offsetMinutes) : DEFAULT_CUSTOM_SEED;
  const [customNumberText, setCustomNumberText] = useState(() => String(initialSeed.value));
  const [customUnit, setCustomUnit] = useState<CustomUnit>(() => initialSeed.unit);
  const [customDirection, setCustomDirection] = useState<Direction>(() => {
    const seeded = value?.direction;
    return seeded !== undefined && allows(seeded) ? seeded : fallbackDirection;
  });

  /** Reads the FULL current trio so any single-field edit recomputes correctly. */
  function commitCustom(rawText: string, unit: CustomUnit, direction: Direction) {
    const n = Number(rawText);
    if (rawText.trim() === '' || !Number.isFinite(n) || n < 0) return;
    const offsetMinutes = n * CUSTOM_UNIT_MINUTES[unit];
    if (!Number.isInteger(offsetMinutes)) return;
    // Clamped rather than trusted. `customDirection` seeds ONCE, so an anchor swap that narrows
    // the legal set leaves it holding a direction whose toggle is no longer even rendered; without
    // this the next keystroke in the amount field would emit it and autosave into a 400.
    onChange({ direction: allows(direction) ? direction : fallbackDirection, offsetMinutes });
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
      setCustomDirection(allows(value.direction) ? value.direction : fallbackDirection);
    }
    setCustomOpen(true);
  }

  return (
    <div>
      <p className="text-[15px] font-extrabold tracking-tight">How far from {anchorLabel}?</p>
      <p className="text-muted-foreground mb-3.5 mt-0.5 text-[12.5px]">
        Tap a common timing, or set your own. Counts from {anchorLabel}.
      </p>

      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = !customOpen && matchedPreset?.key === preset.key;
          return (
            <Button
              key={preset.key}
              type="button"
              variant="outline"
              aria-pressed={active}
              onClick={() => pickPreset(preset)}
              className={chipClass(active, false)}
            >
              {preset.label}
            </Button>
          );
        })}
        <Button
          type="button"
          variant="outline"
          aria-pressed={customOpen}
          onClick={openCustom}
          className={chipClass(customOpen, true)}
        >
          {`Custom${ELLIPSIS}`}
        </Button>
      </div>

      {customOpen && (
        <div className="border-input bg-kit-card mt-3.5 rounded-lg border border-dashed p-3.5">
          <div className="text-muted-foreground mb-2 text-[11px] font-extrabold uppercase tracking-wide">
            Custom timing
          </div>
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
            <SelectField
              value={customUnit}
              onValueChange={(v) => {
                const unit = v as CustomUnit;
                setCustomUnit(unit);
                commitCustom(customNumberText, unit, customDirection);
              }}
              className="h-11 w-32"
              aria-label="Timing unit"
              options={CUSTOM_UNIT_OPTIONS}
            />

            {/* With only one legal direction the toggle is dropped entirely rather than shown as a
                lone locked segment. */}
            {allowedDirections.length > 1 && (
              <span className="border-input bg-muted inline-flex gap-0.5 rounded-md border p-0.5">
                {allowedDirections.map((dir) => (
                  <Button
                    key={dir}
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={customDirection === dir}
                    onClick={() => {
                      setCustomDirection(dir);
                      commitCustom(customNumberText, customUnit, dir);
                    }}
                    className={cn(
                      'min-h-9 text-[12.5px] font-bold',
                      customDirection === dir && 'bg-kit-card text-brand shadow-xs',
                    )}
                  >
                    {DIRECTION_LABEL[dir]}
                  </Button>
                ))}
              </span>
            )}

            <span className="text-brand text-[13.5px] font-extrabold">{anchorLabel}</span>
            <span className="text-[13.5px] font-semibold">.</span>
          </div>
        </div>
      )}
    </div>
  );
}
