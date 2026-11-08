import { useState, useEffect } from 'react';
import { SelectField } from '@/components/form/SelectField';
import { DatePicker } from '@/components/form/DatePicker';
import { PRESETS, matchPreset } from '@/lib/date-range';

export interface DateRangeFieldProps {
  /** Optional label, used only for aria — the surrounding FilterSection shows the visible title. */
  label?: string;
  from: string; // 'YYYY-MM-DD' | ''
  to: string;   // 'YYYY-MM-DD' | ''
  onChange: (next: { from: string; to: string }) => void;
  /**
   * Optional org timezone. Omitted (the default for every pre-existing host) ->
   * presets resolve on the BROWSER's clock, byte-identical to before #1634's
   * date-range half. Pass it only when this field is filtering a genuine
   * scheduling fact (e.g. Jobs' "Scheduled" facet) - never for a "when was
   * this row created" facet, which stays viewer-local by design.
   */
  tz?: string;
}

/**
 * Preset-driven date-range picker for use inside the Filter popover. Replaces the
 * dual native date inputs with a presets dropdown (Today / This week / This month /
 * Last 7-90 / This year / Custom); "Custom…" reveals the two native date inputs.
 */
export function DateRangeField({ label, from, to, onChange, tz }: DateRangeFieldProps) {
  // customMode is sticky: picking "Custom…" must not snap back to a preset that
  // happens to match the typed dates (e.g. today–today === "Today"). Reset when
  // both bounds are cleared (e.g. via "Clear all").
  const [customMode, setCustomMode] = useState(() => matchPreset(from, to, tz) === 'custom');
  useEffect(() => {
    if (!from && !to) setCustomMode(false);
  }, [from, to]);

  const selected = customMode ? 'custom' : matchPreset(from, to, tz);

  const handleSelect = (key: string) => {
    if (key === 'custom') {
      setCustomMode(true); // reveal inputs, keep any existing dates
      return;
    }
    setCustomMode(false);
    const preset = PRESETS.find((p) => p.key === key);
    if (preset) onChange(preset.range(tz));
  };

  return (
    <div className="space-y-2">
      <SelectField
        value={selected}
        onValueChange={handleSelect}
        className="h-9 w-full text-sm text-text-primary focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
        aria-label={label ? `${label} range` : 'Date range'}
        options={[...PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: 'custom', label: 'Custom…' }]}
      />
      {selected === 'custom' && (
        <div className="flex items-center gap-2">
          <DatePicker
            value={from} max={to || undefined}
            onChange={(v) => onChange({ from: v, to })}
            inputClassName="h-9" aria-label={label ? `${label} from` : 'From'}
          />
          <span className="text-text-secondary">–</span>
          <DatePicker
            value={to} min={from || undefined}
            onChange={(v) => onChange({ from, to: v })}
            inputClassName="h-9" aria-label={label ? `${label} to` : 'To'}
          />
        </div>
      )}
    </div>
  );
}
