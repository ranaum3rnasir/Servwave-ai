/* =============================================================================
   ServWave Charts — Sparkline  (spec chart #12)
   Inline micro-chart for KPI tiles. Pure SVG, no axes, no chrome — a smooth
   line with optional soft fill and an end dot. Color from a token (default
   primary; pass success/danger to signal a positive/negative trend).
   ============================================================================= */

import * as React from 'react';
import { token } from '@/design-system';
import { smoothPath } from './chartTheme';

export interface SparklineProps {
  /** Series of numbers (>= 2 for a line). */
  data: number[];
  width?: number;
  height?: number;
  /** Stroke color. Defaults to primary (ocean). */
  color?: string;
  strokeWidth?: number;
  /** Soft area fill under the line. */
  fill?: boolean;
  /** Dot on the last point. */
  endDot?: boolean;
  className?: string;
  /** Accessible description. */
  ariaLabel?: string;
}

export function Sparkline({
  data,
  width = 96,
  height = 28,
  color,
  strokeWidth = 2,
  fill = true,
  endDot = true,
  className,
  ariaLabel,
}: SparklineProps) {
  const stroke = color ?? token('--primary');
  const id = React.useId();

  if (data.length === 0) {
    return <svg width={width} height={height} className={className} role="img" aria-label={ariaLabel} />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = strokeWidth + 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = data.map((v, i) => ({
    x: pad + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW),
    // Invert: higher value → higher on screen (smaller y).
    y: pad + innerH - ((v - min) / span) * innerH,
  }));

  const linePath = smoothPath(points);
  const last = points[points.length - 1]!;
  const firstPt = points[0]!;
  const areaPath =
    fill && points.length > 1
      ? `${linePath} L ${last.x} ${height - pad} L ${firstPt.x} ${height - pad} Z`
      : '';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      {areaPath && (
        <>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.2} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#spark-${id})`} stroke="none" />
        </>
      )}
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {endDot && <circle cx={last.x} cy={last.y} r={strokeWidth + 0.5} fill={stroke} />}
    </svg>
  );
}

export default Sparkline;
