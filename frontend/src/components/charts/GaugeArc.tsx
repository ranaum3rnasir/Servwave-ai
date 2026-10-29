/* =============================================================================
   ServWave Charts — GaugeArc  (spec chart #07)
   Half-circle gauge with rounded stroke ends. Custom SVG. Track from
   border-soft token; value arc from a token color (default success).
   ============================================================================= */

import * as React from 'react';
import { token } from '@/design-system';
import { describeArc, trackColor } from './chartTheme';

export interface GaugeArcProps {
  /** Current value. */
  value: number;
  /** Range. Defaults 0–100. */
  min?: number;
  max?: number;
  size?: number;
  thickness?: number;
  /** Value arc color. Defaults to success. */
  color?: string;
  /** Big center label (defaults to the raw value). */
  label?: React.ReactNode;
  caption?: React.ReactNode;
  className?: string;
}

export function GaugeArc({
  value,
  min = 0,
  max = 100,
  size = 180,
  thickness = 14,
  color,
  label,
  caption,
  className,
}: GaugeArcProps) {
  const span = max - min || 1;
  const frac = Math.max(0, Math.min(1, (value - min) / span));
  const stroke = color ?? token('--success');

  // Semicircle from 180° (9 o'clock) sweeping CW to 360°/0° (3 o'clock).
  const startAngle = 180;
  const endAngle = 360;
  const valueAngle = startAngle + frac * (endAngle - startAngle);

  const cx = size / 2;
  const pad = thickness / 2 + 2;
  const r = (size - thickness) / 2 - 2;
  const cy = size / 2; // arc center; we crop the bottom half via height.
  const height = size / 2 + pad;

  return (
    <div className={className} style={{ width: size, position: 'relative' }}>
      <svg width={size} height={height} viewBox={`0 0 ${size} ${height}`} role="img">
        <path
          d={describeArc(cx, cy, r, startAngle, endAngle)}
          fill="none"
          stroke={trackColor()}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {frac > 0 && (
          <path
            d={describeArc(cx, cy, r, startAngle, valueAngle)}
            fill="none"
            stroke={stroke}
            strokeWidth={thickness}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <span className="text-2xl font-extrabold text-text-primary leading-none">
          {label ?? value}
        </span>
        {caption != null && (
          <span className="mt-1 text-xs text-text-secondary">{caption}</span>
        )}
      </div>
    </div>
  );
}

export default GaugeArc;
