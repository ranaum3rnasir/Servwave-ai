/**
 * WaitForm — configure a WAIT step's timing. Two modes:
 *  - Relative ("wait a set time"): one-tap presets (1 hour … 1 week) plus a
 *    "Custom" value×unit editor, writing a single `duration_minutes`. This is
 *    the ORIGINAL (and still default) behavior — unchanged, back-compat shape.
 *  - Anchored ("before/after {anchor.label}"): only offered when the trigger's
 *    entity has a resolvable date (see lib/workflows/anchors.ts). Same
 *    preset/custom editor for the offset, plus a before/after direction
 *    toggle, writing `{ mode:'anchored', anchor, direction, offset_minutes }`.
 * A live summary line reads back the current value. Propagates the parsed
 * config up on every change (this drawer holds no draft of its own).
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { waitRelativeConfigSchema, waitAnchoredConfigSchema } from '@/lib/workflows/stepSchemas';
import { UNIT_MINUTES, splitOffset, type OffsetUnit } from '@/lib/workflows/timing';
import { formatOffset } from '@/lib/workflows/describeWorkflow';
import type { AnchorKey, WaitDirection } from '@/lib/workflows/anchors';

const PRESETS: { label: string; minutes: number }[] = [
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 24 * 60 },
  { label: '3 days', minutes: 3 * 24 * 60 },
  { label: '1 week', minutes: 7 * 24 * 60 },
];

/** RHF resolver for the relative sub-form — same fields/messages as waitRelativeConfigSchema, minus `mode`. */
const relativeFieldsSchema = waitRelativeConfigSchema.omit({ mode: true });
type RelativeFormValues = { duration_minutes: number };

/**
 * Shared pill-button classes for the preset/custom rows (both modes).
 *
 * Every call site below is a segmented toggle control (aria-pressed,
 * mutually-exclusive preset selection) - one of the non-Button shapes the
 * UI component architecture program explicitly calls out as expected to
 * stay raw. 4 `<button>` JSX sites use this helper (a PRESETS `.map()` +
 * a "Custom" button in relative mode, the same pair again in anchored
 * mode) and are all left unconverted for that reason, not missed.
 */
function pillClass(active: boolean, wide: boolean): string {
  const px = wide ? 'px-3.5' : 'px-3';
  return `min-h-11 rounded-pill border ${px} py-1.5 text-[13px] font-semibold transition-colors ${
    active ? 'border-primary bg-primary text-on-fill' : 'border-border bg-surface-light text-text-secondary hover:border-primary/40'
  }`;
}

/**
 * Shared 2-up segmented-toggle classes (mode switch + before/after).
 *
 * Same reason as `pillClass` above: all 4 `<button>` JSX sites that use this
 * helper (the relative/anchored mode switch pair, then the before/after
 * direction pair) are segmented toggle controls, a documented non-Button
 * shape, and are left raw.
 */
function toggleClass(active: boolean): string {
  return `min-h-11 rounded border px-3 py-2 text-[13px] font-semibold transition-colors ${
    active ? 'border-primary bg-primary-subtle text-primary' : 'border-border bg-surface-light text-text-secondary hover:border-primary/40'
  }`;
}

export interface WaitFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  /** The trigger's entity date to wait against, if it has one — offers the anchored mode. */
  anchor?: { key: AnchorKey; label: string } | null;
}

export default function WaitForm({ config, onChange, anchor }: WaitFormProps) {
  const configIsAnchored = config.mode === 'anchored';
  const [mode, setMode] = useState<'relative' | 'anchored'>(anchor && configIsAnchored ? 'anchored' : 'relative');

  // ── relative sub-form — EXACTLY the original behavior/shape (no `mode` key) ──
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

  // ── anchored sub-form — only reachable when `anchor` is offered ──
  const seedOffsetRaw = configIsAnchored ? Number(config.offset_minutes) : Number.NaN;
  const seedOffset = Number.isFinite(seedOffsetRaw) && seedOffsetRaw >= 0 ? seedOffsetRaw : 1440;
  const seedDirection: WaitDirection = configIsAnchored && config.direction === 'after' ? 'after' : 'before';

  const [aDirection, setADirection] = useState<WaitDirection>(seedDirection);
  const [aOffset, setAOffset] = useState<number | null>(seedOffset);
  const [aCustom, setACustom] = useState(!PRESETS.some((p) => p.minutes === seedOffset));
  const aSeed = splitOffset(seedOffset > 0 ? seedOffset : 60);
  const [aValue, setAValue] = useState<string>(String(aSeed.value));
  const [aUnit, setAUnit] = useState<OffsetUnit>(aSeed.unit);

  // Only server-valid anchored configs reach the draft — same reasoning as
  // TriggerForm's offset guard: a bad value would 400 EVERY autosave.
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
          <button
            type="button"
            aria-pressed={mode === 'relative'}
            onClick={() => selectMode('relative')}
            className={toggleClass(mode === 'relative')}
          >
            Wait a set time
          </button>
          <button
            type="button"
            aria-pressed={mode === 'anchored'}
            onClick={() => selectMode('anchored')}
            className={toggleClass(mode === 'anchored')}
          >
            Before / after {anchor.label}
          </button>
        </div>
      )}

      {mode === 'relative' && (
        <>
          <div>
            <Label tone="strong" className="mb-1.5 block text-sm font-semibold">How long to wait</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => {
                const active = !custom && duration === p.minutes;
                return (
                  <button
                    key={p.minutes}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setCustom(false);
                      write(p.minutes);
                    }}
                    className={pillClass(active, true)}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={custom}
                onClick={() => {
                  const s = splitOffset(Number.isFinite(duration) && duration > 0 ? duration : 60);
                  setVal(String(s.value));
                  setUnit(s.unit);
                  setCustom(true);
                }}
                className={pillClass(custom, false)}
              >
                Custom
              </button>
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
            <p className="text-xs font-medium text-danger">{formState.errors.duration_minutes.message}</p>
          ) : (
            <p className="rounded bg-background-light px-3 py-2 text-sm font-medium text-text-primary">
              Wait <span className="font-bold">{formatOffset(duration)}</span> before the next step.
            </p>
          )}
        </>
      )}

      {mode === 'anchored' && anchor && (
        <>
          <div>
            <Label tone="strong" className="mb-1.5 block text-sm font-semibold">Before or after {anchor.label}?</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={aDirection === 'before'}
                onClick={() => pickDirection('before')}
                className={toggleClass(aDirection === 'before')}
              >
                Before
              </button>
              <button
                type="button"
                aria-pressed={aDirection === 'after'}
                onClick={() => pickDirection('after')}
                className={toggleClass(aDirection === 'after')}
              >
                After
              </button>
            </div>
          </div>

          <div>
            <Label tone="strong" className="mb-1.5 block text-sm font-semibold">How long {aDirection}?</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => {
                const active = !aCustom && aOffset === p.minutes;
                return (
                  <button
                    key={p.minutes}
                    type="button"
                    aria-pressed={active}
                    onClick={() => pickAnchoredPreset(p.minutes)}
                    className={pillClass(active, true)}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button type="button" aria-pressed={aCustom} onClick={openAnchoredCustom} className={pillClass(aCustom, false)}>
                Custom
              </button>
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
            <p className="text-xs font-medium text-danger">Set the timing — whole minutes, 0 up to the 90-day limit.</p>
          ) : (
            <p className="rounded bg-background-light px-3 py-2 text-sm font-medium text-text-primary">
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
