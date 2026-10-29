import { useState } from 'react';
import { RangeSlider } from '@/components/filters/RangeSlider';
import { formatCurrency } from '@/lib/utils';
import { fieldKindProps } from '@/ui-kit/lib/fieldKind';
import { useNumberField } from '@/ui-kit/lib/useNumberField';
import type { FacetControlProps } from './facetControlProps';

export interface RangeFacetProps extends FacetControlProps {
  /**
   * Domain floor override. Falls back to `facet.min ?? 0` when omitted —
   * `facet.min` already carries this per Task 5's `FacetConfig`.
   */
  min?: number;
  /**
   * Domain ceiling. Required: `facet.maxSource` is only an id naming a
   * data-derived ceiling (e.g. "max # of estimates across the current list")
   * that this leaf control has no way to resolve on its own — `FilterBar`
   * (next task) resolves it and passes the concrete number down.
   */
  max: number;
}

/**
 * Pane control for `kind: 'range'` facets: the dual-handle `RangeSlider` plus
 * two typed number inputs. Leaving "To" blank (or dragging the slider's max
 * thumb to the ceiling) reports `to: null` — open-ended / "N or more" — same
 * convention as `RangeSlider` itself.
 *
 * When `facet.money` is set, the number fields display via `formatCurrency`
 * while unfocused and fall back to a plain editable number while focused
 * (format-on-blur). The stored `FilterValue` is always a raw number either
 * way — formatting is display-only, never round-tripped through state.
 */
export function RangeFacet({ facet, value, onChange, min, max }: RangeFacetProps) {
  const domainMin = min ?? facet.min ?? 0;
  const domainMax = max;

  const from = value?.kind === 'range' ? (value.from ?? domainMin) : domainMin;
  const to = value?.kind === 'range' ? value.to : null;

  const [fromFocused, setFromFocused] = useState(false);
  const [toFocused, setToFocused] = useState(false);

  const money = facet.money === true;

  const handleSliderChange = (next: { from: number | null; to: number | null }) => {
    onChange({ kind: 'range', from: next.from ?? domainMin, to: next.to });
  };

  const handleFromChange = (raw: string) => {
    if (raw === '') {
      onChange({ kind: 'range', from: domainMin, to });
      return;
    }
    const num = Number(raw);
    if (Number.isNaN(num)) return;
    const ceiling = to ?? domainMax;
    const clamped = Math.min(Math.max(num, domainMin), ceiling);
    onChange({ kind: 'range', from: clamped, to });
  };

  const handleToChange = (raw: string) => {
    if (raw === '') {
      onChange({ kind: 'range', from, to: null });
      return;
    }
    const num = Number(raw);
    if (Number.isNaN(num)) return;
    const clamped = Math.max(Math.min(num, domainMax), from);
    onChange({ kind: 'range', from, to: clamped });
  };

  const fromDisplay = money && !fromFocused ? formatCurrency(from) : String(from);
  const toDisplay = to === null ? '' : money && !toFocused ? formatCurrency(to) : String(to);

  // Text inputs with the decimal keypad, never number inputs (mobile slice 37):
  // the formatted "$1,234.00" shows while unfocused, a plain number while typing.
  const kind = money ? 'money' : 'quantity';
  const fromField = useNumberField(kind, { value: fromDisplay, onChange: (e) => handleFromChange(e.target.value), onBlur: () => setFromFocused(false) }, undefined);
  const toField = useNumberField(kind, { value: toDisplay, onChange: (e) => handleToChange(e.target.value), onBlur: () => setToFocused(false) }, undefined);

  return (
    <div className="space-y-3">
      <RangeSlider min={domainMin} max={domainMax} value={{ from, to }} onChange={handleSliderChange} />
      <div className="flex items-center gap-2">
        <input
          {...fieldKindProps(kind)}
          {...fromField}
          onFocus={() => setFromFocused(true)}
          aria-label={`${facet.label} From`}
          className="h-8 w-full rounded border border-border px-2 text-sm mobile:!text-base"
        />
        <span className="text-text-secondary">–</span>
        <input
          {...fieldKindProps(kind)}
          {...toField}
          onFocus={() => setToFocused(true)}
          placeholder={facet.unit ? `Any ${facet.unit}` : 'Any'}
          aria-label={`${facet.label} To`}
          className="h-8 w-full rounded border border-border px-2 text-sm mobile:!text-base"
        />
      </div>
      {to === null && (
        <p className="text-xs text-text-secondary">
          {money ? formatCurrency(from) : from}
          {facet.unit ? ` ${facet.unit}` : ''} or more
        </p>
      )}
    </div>
  );
}
