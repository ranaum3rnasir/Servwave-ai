import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui-kit/components/ui/select';
import { cn } from '@/ui-kit/lib/utils';
import { waitRelativeConfigSchema, waitAnchoredConfigSchema } from '@/lib/workflows/stepSchemas';
import { UNIT_MINUTES, splitOffset, type OffsetUnit } from '@/lib/workflows/timing';
import { formatOffset } from '@/lib/workflows/describeWorkflow';
import type { AnchorKey, WaitDirection } from '@/lib/workflows/anchors';

import { EM_DASH } from './glyphs';

/**
 * A WAIT step's timing, in two modes.
 *
 *  - Relative: presets plus a custom value/unit editor writing a single
 *    `duration_minutes`. RHF with `waitRelativeConfigSchema` minus `mode`, in
 *    `onChange` mode. Every write pushes up EVEN WHEN INVALID (a NaN), which is
 *    what makes the inline error appear.
 *  - Anchored: only offered when the trigger's entity has a resolvable date.
 *    NOT RHF. `emitAnchored` only calls `onChange` when the candidate passes
 *    `waitAnchoredConfigSchema.safeParse`, so an invalid anchored value never
 *    reaches the draft. A bad one would 400 on every autosave.
 *
 * The asymmetry between those two is deliberate and load-bearing; do not
 * "unify" it.
 */

const PRESETS: { label: string; minutes: number }[] = [
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 24 * 60 },
  { label: '3 days', minutes: 3 * 24 * 60 },
  { label: '1 week', minutes: 7 * 24 * 60 },
];

const relativeFieldsSchema = waitRelativeConfigSchema.omit({ mode: true });
type RelativeFormValues = { duration_minutes: number };

/** The preset pill look. The kit has no toggle-chip cell, so it is composed on Button. */
function pillClass(active: boolean): string {
  return cn(
    'min-h-11 rounded-full px-3.5 text-[13px] font-semibold',
    active
      ? 'border-primary bg-primary text-primary-foreground hover:opacity-90'
      : 'border-input bg-kit-card text-muted-foreground hover:border-brand',
  );
}

/** The 2-up segmented toggle look (mode switch, then before/after). */
function toggleClass(active: boolean): string {
  return cn(
    'min-h-11 rounded-md px-3 text-[13px] font-semibold',
    active
      ? 'border-brand bg-brand-subtle text-brand-emphasis'
      : 'border-input bg-kit-card text-muted-foreground hover:border-brand',
  );
}

export interface WaitFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  /** The trigger entity's date to wait against, if it has one. Offers the anchored mode. */
  anchor?: { key: AnchorKey; label: string } | null;
}

export default function WaitForm({ config, onChange, anchor }: WaitFormProps) {
  const configIsAnchored = config.mode === 'anchored';
  const [mode, setMode] = useState<'relative' | 'anchored'>(anchor && configIsAnchored ? 'anchored' : 'relative');

  const initial = Number(config.duration_minutes);
  const startMinutes = Number.isFinite(initial) && initial > 0 ? initial : 1440;
  const isPreset = PRESETS.some((p) => p.minutes === startMinutes);

  const form = useForm<RelativeFormValues>({
    resolver: zodResolver(relativeFieldsSchema),
    mode: 'onChange',
    defaultValues: { duration_minutes: startMinutes },
  });
  const { watch, setValue, formState } = form;
  const duration = watch('duration_minutes');

  const [custom, setCustom] = useState(!isPreset);
  const seed = splitOffset(startMinutes);
  const [value, setVal] = useState<string>(String(seed.value));
  const [unit, setUnit] = useState<OffsetUnit>(seed.unit);

  const write = (minutes: number) => {
    setValue('duration_minutes', minutes, { shouldDirty: true, shouldValidate: true });
    onChange({ duration_minutes: minutes });
  };

  const recompute = (rawValue: string, nextUnit: OffsetUnit) => {
    const n = Number(rawValue);
    const minutes = rawValue.trim() !== '' && Number.isFinite(n) ? n * UNIT_MINUTES[nextUnit] : Number.NaN;
    write(minutes);
  };

  const seedOffsetRaw = configIsAnchored ? Number(config.offset_minutes) : Number.NaN;
  const seedOffset = Number.isFinite(seedOffsetRaw) && seedOffsetRaw >= 0 ? seedOffsetRaw : 1440;
  const seedDirection: WaitDirection = configIsAnchored && config.direction === 'after' ? 'after' : 'before';

  const [aDirection, setADirection] = useState<WaitDirection>(seedDirection);
  const [aOffset, setAOffset] = useState<number | null>(seedOffset);
  const [aCustom, setACustom] = useState(!PRESETS.some((p) => p.minutes === seedOffset));
  const aSeed = splitOffset(seedOffset > 0 ? seedOffset : 60);
  const [aValue, setAValue] = useState<string>(String(aSeed.value));
  const [aUnit, setAUnit] = useState<OffsetUnit>(aSeed.unit);

  function emitAnchored(offset: number | null, direction: WaitDirection) {
    if (!anchor || offset == null) return;
    const candidate = { mode: 'anchored' as const, anchor: anchor.key, direction, offset_minutes: offset };
    if (waitAnchoredConfigSchema.safeParse(candidate).success) onChange(candidate);
  }

  function selectMode(next: 'relative' | 'anchored') {
    setMode(next);
    if (next === 'relative') {
      onChange({ duration_minutes: duration });
    } else {
      emitAnchored(aOffset, aDirection);
    }
  }

  function pickDirection(direction: WaitDirection) {
    setADirection(direction);
    emitAnchored(aOffset, direction);
  }

  function pickAnchoredPreset(minutes: number) {
    setACustom(false);
    setAOffset(minutes);
    emitAnchored(minutes, aDirection);
  }

  function openAnchoredCustom() {
    const s = splitOffset(aOffset && aOffset > 0 ? aOffset : 60);
    setAValue(String(s.value));
    setAUnit(s.unit);
    setACustom(true);
  }

  function recomputeAnchored(rawValue: string, nextUnit: OffsetUnit) {
    const n = Number(rawValue);
    const minutes = rawValue.trim() !== '' && Number.isFinite(n) ? n * UNIT_MINUTES[nextUnit] : null;
    setAOffset(minutes);
    emitAnchored(minutes, aDirection);
  }

  const anchoredValid =
    anchor != null &&
    aOffset != null &&
    waitAnchoredConfigSchema.safeParse({
      mode: 'anchored',
      anchor: anchor.key,
      direction: aDirection,
      offset_minutes: aOffset,
    }).success;

  return (
    <div className="space-y-4">
      {anchor && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            aria-pressed={mode === 'relative'}
            onClick={() => selectMode('relative')}
            className={toggleClass(mode === 'relative')}
          >
            Wait a set time
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-pressed={mode === 'anchored'}
            onClick={() => selectMode('anchored')}
            className={toggleClass(mode === 'anchored')}
          >
            Before / after {anchor.label}
          </Button>
        </div>
      )}

      {mode === 'relative' && (
        <>
          <div>
            <Label className="mb-1.5 block text-sm font-semibold">How long to wait</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => {
                const active = !custom && duration === p.minutes;
                return (
                  <Button
                    key={p.minutes}
                    type="button"
                    variant="outline"
                    aria-pressed={active}
                    onClick={() => {
                      setCustom(false);
                      write(p.minutes);
                    }}
                    className={pillClass(active)}
                  >
                    {p.label}
                  </Button>
                );
              })}
              <Button
                type="button"
                variant="outline"
                aria-pressed={custom}
                onClick={() => {
                  const s = splitOffset(Number.isFinite(duration) && duration > 0 ? duration : 60);
                  setVal(String(s.value));
                  setUnit(s.unit);
                  setCustom(true);
                }}
                className={pillClass(custom)}
              >
                Custom
              </Button>
            </div>
          </div>

          {custom && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                className="h-11 w-24"
                value={value}
                onChange={(e) => {
                  setVal(e.target.value);
                  recompute(e.target.value, unit);
                }}
                aria-label="Wait amount"
              />
              <Select
                value={unit}
                onValueChange={(v) => {
                  const u = v as OffsetUnit;
                  setUnit(u);
                  recompute(value, u);
                }}
              >
                <SelectTrigger className="h-11 w-32" aria-label="Wait unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">minutes</SelectItem>
                  <SelectItem value="hours">hours</SelectItem>
                  <SelectItem value="days">days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {formState.errors.duration_minutes ? (
            <p className="text-destructive text-xs font-medium">{formState.errors.duration_minutes.message}</p>
          ) : (
            <p className="bg-muted rounded-md px-3 py-2 text-sm font-medium">
              Wait <span className="font-bold">{formatOffset(duration)}</span> before the next step.
            </p>
          )}
        </>
      )}

      {mode === 'anchored' && anchor && (
        <>
          <div>
            <Label className="mb-1.5 block text-sm font-semibold">Before or after {anchor.label}?</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                aria-pressed={aDirection === 'before'}
                onClick={() => pickDirection('before')}
                className={toggleClass(aDirection === 'before')}
              >
                Before
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-pressed={aDirection === 'after'}
                onClick={() => pickDirection('after')}
                className={toggleClass(aDirection === 'after')}
              >
                After
              </Button>
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block text-sm font-semibold">How long {aDirection}?</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => {
                const active = !aCustom && aOffset === p.minutes;
                return (
                  <Button
                    key={p.minutes}
                    type="button"
                    variant="outline"
                    aria-pressed={active}
                    onClick={() => pickAnchoredPreset(p.minutes)}
                    className={pillClass(active)}
                  >
                    {p.label}
                  </Button>
                );
              })}
              <Button
                type="button"
                variant="outline"
                aria-pressed={aCustom}
                onClick={openAnchoredCustom}
                className={pillClass(aCustom)}
              >
                Custom
              </Button>
            </div>
          </div>

          {aCustom && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                className="h-11 w-24"
                value={aValue}
                onChange={(e) => {
                  setAValue(e.target.value);
                  recomputeAnchored(e.target.value, aUnit);
                }}
                aria-label="Timing amount"
              />
              <Select
                value={aUnit}
                onValueChange={(v) => {
                  const u = v as OffsetUnit;
                  setAUnit(u);
                  recomputeAnchored(aValue, u);
                }}
              >
                <SelectTrigger className="h-11 w-32" aria-label="Timing unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">minutes</SelectItem>
                  <SelectItem value="hours">hours</SelectItem>
                  <SelectItem value="days">days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {!anchoredValid ? (
            <p className="text-destructive text-xs font-medium">
              {`Set the timing ${EM_DASH} whole minutes, 0 up to the 90-day limit.`}
            </p>
          ) : (
            <p className="bg-muted rounded-md px-3 py-2 text-sm font-medium">
              Wait until{' '}
              <span className="font-bold">
                {formatOffset(aOffset as number)} {aDirection} {anchor.label}
              </span>
              , then continue.
            </p>
          )}
        </>
      )}
    </div>
  );
}
