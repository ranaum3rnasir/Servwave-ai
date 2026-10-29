import { useRef, type ChangeEvent } from 'react';
import './RangeSlider.css';

export interface RangeSliderValue {
  from: number | null;
  to: number | null;
}

export interface RangeSliderProps {
  min: number;
  max: number;
  value: RangeSliderValue;
  /**
   * Fires on every drag frame (mirrors the mockup's `input` handler) with
   * the clamped result. `to: null` means "reached the right edge" — i.e.
   * `min`-or-more with no upper bound (see file header for why there's no
   * symmetric `from: null`).
   */
  onChange: (next: RangeSliderValue) => void;
}

/**
 * Dual-handle range slider primitive, ported from the approved
 * filter-redesign mockup's numeric-range facet control
 * (`filter-redesign.html`, "# of Estimates").
 *
 * Two overlaid native `<input type="range">` each drive their own thumb —
 * see RangeSlider.css for how `pointer-events` is split between the input
 * (none) and its thumb pseudo-element (auto) so the two ranges never fight
 * over a click in the middle of the track. A separate `.fill` div (not a
 * native input) renders the "selected range" bar between the two thumbs.
 *
 * `to === max` is treated as open-ended ("N or more"): the reported value's
 * `to` becomes `null` rather than the literal domain ceiling, matching the
 * mockup's "leave To blank for N or more" convention. There's no equivalent
 * `from: null` — the left edge is already the domain floor, so reaching it
 * doesn't need a separate "unbounded" marker.
 *
 * Smooth dragging: the `.fill` bar's position is written directly to the
 * DOM via `fillRef` inside the input handler, ahead of (and independent of)
 * calling `onChange`. This decouples the visual feedback from the parent's
 * render round-trip — e.g. a consumer that debounces `onChange` before
 * writing to the URL (as this filter system's `useFilterState` does, via
 * `history.replaceState` on every call) won't make the thumb/fill lag
 * behind the drag. React's own re-render (triggered by the parent handing
 * back new `value` props) lands on the next tick and is idempotent with
 * what's set here, so there's no fighting between the two updates.
 */
export function RangeSlider({ min, max, value, onChange }: RangeSliderProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const from = clamp(value.from ?? min);
  const to = clamp(value.to ?? max);
  const fillRef = useRef<HTMLDivElement>(null);

  const pct = (v: number) => (max === min ? 0 : ((v - min) / (max - min)) * 100);

  const paintFill = (nextFrom: number, nextTo: number) => {
    const el = fillRef.current;
    if (!el) return;
    el.style.left = `${pct(nextFrom)}%`;
    el.style.right = `${100 - pct(nextTo)}%`;
  };

  const handleMinInput = (e: ChangeEvent<HTMLInputElement>) => {
    const nextFrom = Math.min(Number(e.target.value), to);
    paintFill(nextFrom, to);
    onChange({ from: nextFrom, to: to === max ? null : to });
  };

  const handleMaxInput = (e: ChangeEvent<HTMLInputElement>) => {
    const nextTo = Math.max(Number(e.target.value), from);
    paintFill(from, nextTo);
    onChange({ from, to: nextTo === max ? null : nextTo });
  };

  return (
    <div className="range-slider">
      <div className="range-slider__track" />
      <div
        ref={fillRef}
        className="range-slider__fill"
        style={{ left: `${pct(from)}%`, right: `${100 - pct(to)}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        value={from}
        onChange={handleMinInput}
        aria-label="Minimum"
      />
      <input
        type="range"
        min={min}
        max={max}
        value={to}
        onChange={handleMaxInput}
        aria-label="Maximum"
      />
    </div>
  );
}
