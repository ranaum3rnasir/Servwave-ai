/* =============================================================================
   ServWave Charts — narrow-screen axis fitting (mobile slice 30).

   A report chart on a phone is about 240-300 px wide. Two habits starved it:

   - Category axes that force every label (`interval={0}`), so neighbouring
     labels ran into each other at 360. The fix there is to drop the forced
     interval and let Recharts hide the labels that would collide; the tooltip
     still names every bar. Nothing in this file is needed for that.
   - Horizontal bar charts that reserve a fixed label column (up to 150 px)
     plus a wide right margin for the value labels, which left the bars a
     sliver and let long names run out of the chart. `fitCategoryAxis` caps
     both on narrow screens, and `fittedCategoryTick` ellipsizes a label to
     the column it is given, keeping the full name as the SVG title.

   Desktop and tablet keep the widths their call sites chose.

   Every export is lowercase on purpose: chart-story-coverage.test.ts treats a
   capitalised export in this directory as a chart component that needs a story.
   ============================================================================= */

import { useMediaQuery } from '@/ui-kit/hooks/useMediaQuery';

/** Below `sm`: phones in portrait. */
export const narrowChartQuery = '(max-width: 639px)';

/** The most a horizontal bar chart's label column takes on a phone. */
export const narrowLabelWidth = 80;
/** The most a horizontal bar chart keeps right of the bars for value labels on a phone. */
export const narrowValueRoom = 52;
/** Space between a category label and the plot (Recharts' own tick offset is 8 px). */
const TICK_GAP = 8;

export function useNarrowChart(): boolean {
  return useMediaQuery(narrowChartQuery);
}

export interface CategoryAxisFit {
  /** YAxis `width` for the category labels. */
  labelWidth: number;
  /** Right margin kept for the value labels at the end of each bar. */
  valueRoom: number;
}

/** The label column and value margin a horizontal bar chart should use. */
export function fitCategoryAxis(narrow: boolean, wanted: CategoryAxisFit): CategoryAxisFit {
  if (!narrow) return wanted;
  return {
    labelWidth: Math.min(wanted.labelWidth, narrowLabelWidth),
    valueRoom: Math.min(wanted.valueRoom, narrowValueRoom),
  };
}

const ELLIPSIS = '…';

/**
 * The longest prefix of `text` (plus an ellipsis) that `measure` says fits in
 * `maxWidth`. The text itself when it fits; never less than one character.
 */
export function fitLabel(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  let lo = 1;
  let hi = text.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measure(text.slice(0, mid).trimEnd() + ELLIPSIS) <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, best).trimEnd() + ELLIPSIS;
}

let canvas: CanvasRenderingContext2D | null | undefined;

/** Rendered width of `text` at `fontSize` in the page's font; an estimate where no canvas exists. */
function measureText(text: string, fontSize: number): number {
  if (canvas === undefined) {
    try {
      canvas = typeof document !== 'undefined' && !/jsdom/i.test(navigator.userAgent)
        ? document.createElement('canvas').getContext('2d')
        : null;
    } catch {
      canvas = null;
    }
  }
  if (canvas) {
    canvas.font = `${fontSize}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    return canvas.measureText(text).width;
  }
  return text.length * fontSize * 0.6;
}

/** The props Recharts hands a custom tick renderer (the ones used here). */
interface RechartsTickProps {
  x?: number | string;
  y?: number | string;
  payload?: { value?: unknown };
  textAnchor?: 'start' | 'middle' | 'end' | 'inherit';
}

export interface FittedCategoryTickOptions {
  /** The YAxis `width` the ticks sit in. */
  axisWidth: number;
  fontSize?: number;
  fill?: string;
}

/**
 * A left-hand category tick renderer that fits its axis column: a long name is
 * cut with an ellipsis, and the full name stays available as the SVG title.
 *
 *   <YAxis type="category" width={w} tick={fittedCategoryTick({ axisWidth: w, fill })} />
 *
 * A factory rather than a component so Recharts calls it as a function and the
 * axis's own position props reach the `<text>` unchanged.
 */
export function fittedCategoryTick({ axisWidth, fontSize = 12, fill }: FittedCategoryTickOptions) {
  const maxWidth = Math.max(axisWidth - TICK_GAP, fontSize);
  return function renderTick({ x, y, payload, textAnchor = 'end' }: RechartsTickProps) {
    const full = String(payload?.value ?? '');
    const shown = fitLabel(full, maxWidth, (s) => measureText(s, fontSize));
    return (
      <text x={x} y={y} dy="0.355em" textAnchor={textAnchor} fontSize={fontSize} fill={fill}>
        {shown !== full && <title>{full}</title>}
        {shown}
      </text>
    );
  };
}
