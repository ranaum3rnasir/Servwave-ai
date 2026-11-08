/* =============================================================================
   Report row indicators - the delta pill and the inline sparkline.

   Both used to live in `pages/reports/_shared.tsx`. They are token-only
   renderers with no state, no data fetching and no dependency on any other
   report piece, so they belong in the component layer rather than in a page
   directory that the /v2 cutover deletes.

   Kept in ONE file on purpose: `components/charts/Sparkline.tsx` already
   exists and is a different component (smooth path, gradient fill, end dot,
   token-defaulted colour). Minting a second `Sparkline.tsx` would read as a
   duplicate of it. This one is the raw two-point-per-sample polyline the
   report tables have always drawn, with the stroke colour handed in by the
   caller because inside a chart the colour carries meaning.
   ============================================================================= */
import { ArrowDown, ArrowUp } from 'lucide-react';

/** Delta pill - success when rising, danger when falling. */
export function Delta({ value, suffix = '%', flipColor = false }: { value: number | null; suffix?: string; flipColor?: boolean }) {
  if (value === null || Math.abs(value) < 0.05) return <span className="text-xs text-text-secondary">—</span>;
  const up = value > 0;
  const good = flipColor ? !up : up;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${good ? 'text-success-text' : 'text-danger-text'}`}>
      {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(value).toFixed(suffix === 'pp' ? 1 : value >= 100 ? 0 : 1)}
      {suffix === 'pp' ? '' : suffix}
    </span>
  );
}

/** Inline SVG sparkline. */
export function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 88;
  const h = 26;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`).join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
