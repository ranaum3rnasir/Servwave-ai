/* =============================================================================
   ServWave Charts — shared theme constants & geometry helpers.
   Internal module: axis/grid/tooltip styling + small SVG math used by the
   custom (non-Recharts) primitives. Colors come from tokens only.
   ============================================================================= */

import type { CSSProperties } from 'react';
import { token } from '@/design-system';

/** Muted 11px axis tick style (spec: axis labels in muted 11px). */
export const axisTick = {
  fontSize: 11,
  fill: token('--text-secondary'),
} as const;

/**
 * Data-label style for Recharts `<LabelList style={...} />`. Derived from the
 * axis tick typography so value labels and axis ticks cannot drift apart.
 */
export const chartLabelStyle: CSSProperties = { ...axisTick };

/** Axis line / tick line color — uses the border token. */
export function axisLineColor(): string {
  return token('--border-color');
}

/** Default cartesian grid stroke (border-border, dashed, horizontal only). */
export function gridStroke(): string {
  return token('--border-color');
}

/** Recharts <Tooltip> contentStyle — white, 6px, soft card shadow. */
export function tooltipContentStyle(): CSSProperties {
  return {
    background: token('--surface-light'),
    border: `1px solid ${token('--border-color')}`,
    borderRadius: 6,
    // Mirrors --shadow-card; tint derived from the primary (ocean) token.
    boxShadow: `0 8px 24px color-mix(in srgb, ${token('--primary')} 10%, transparent)`,
    fontSize: 12,
    color: token('--text-primary'),
    padding: '8px 10px',
  };
}

/** Tooltip label (the category/x value) style. */
export function tooltipLabelStyle(): CSSProperties {
  return { color: token('--text-secondary'), fontSize: 11, marginBottom: 2 };
}

/** Neutral track color for bar backgrounds / unfilled donut & gauge arcs. */
export function trackColor(): string {
  // Spec: track #E8ECEF — sits between border-soft and border-color; use the
  // border-soft token so it stays token-driven and theme-aware.
  return token('--border-soft');
}

/* --------------------------------------------------------------------------
   Geometry helpers for custom SVG charts (donut / gauge / funnel / sparkline)
   -------------------------------------------------------------------------- */

/** Point on a circle for a given angle (degrees, 0° = 3 o'clock, CW). */
export function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * SVG arc path between two angles (degrees) on a circle of radius `r`.
 * Angles measured clockwise from 3 o'clock. Used for donut & gauge strokes.
 */
export function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polar(cx, cy, r, startAngle);
  const end = polar(cx, cy, r, endAngle);
  const sweep = endAngle - startAngle;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  const sweepFlag = sweep >= 0 ? 1 : 0;
  return [
    `M ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${end.x} ${end.y}`,
  ].join(' ');
}

/** Build a smooth (Catmull-Rom → cubic Bézier) SVG path through points. */
export function smoothPath(points: Array<{ x: number; y: number }>): string {
  const first = points[0];
  if (!first) return '';
  if (points.length === 1) return `M ${first.x} ${first.y}`;
  const d: string[] = [`M ${first.x} ${first.y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p0 = points[i - 1] ?? p1;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`);
  }
  return d.join(' ');
}
