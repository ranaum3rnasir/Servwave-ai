/* =============================================================================
   ServWave Charts — ProgressDonut (#06) + SegmentedDonut (#08)
   Custom SVG (Recharts can't give us rounded stroke caps + a clean center
   label cheaply). Track from border-soft token; colors from tokens / palette.
   ============================================================================= */

import * as React from 'react';
import { chartPalette, token } from '@/design-system';
import { describeArc, trackColor } from './chartTheme';

/* ----------------------------- ProgressDonut ----------------------------- */

export interface ProgressDonutProps {
  /** 0–1 completion fraction. */
  value: number;
  size?: number;
  /** Stroke thickness. */
  thickness?: number;
  /** Progress arc color. Defaults to success (positive signal). */
  color?: string;
  /** Big center label (defaults to rounded percentage). */
  label?: React.ReactNode;
  /** Small caption under the center label. */
  caption?: React.ReactNode;
  className?: string;
}

export function ProgressDonut({
  value,
  size = 160,
  thickness = 14,
  color,
  label,
  caption,
  className,
}: ProgressDonutProps) {
  const pct = Math.max(0, Math.min(1, value));
  const stroke = color ?? token('--success');
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - thickness) / 2;
  // Start at 12 o'clock (-90°), sweep clockwise.
  const start = -90;
  const end = start + pct * 360;
  const fullEnd = start + 359.999; // avoid full-circle arc collapse

  return (
    <div className={className} style={{ width: size, height: size, position: 'relative' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        <path
          d={describeArc(cx, cy, r, start, fullEnd)}
          fill="none"
          stroke={trackColor()}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {pct > 0 && (
          <path
            d={describeArc(cx, cy, r, start, end)}
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
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span className="text-2xl font-extrabold text-text-primary leading-none">
          {label ?? `${Math.round(pct * 100)}%`}
        </span>
        {caption != null && (
          <span className="mt-1 text-xs text-text-secondary">{caption}</span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- SegmentedDonut ---------------------------- */

export interface DonutSegment {
  label: string;
  value: number;
  color?: string;
}

export interface SegmentedDonutProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  /** Gap between segments, in degrees. */
  gapDegrees?: number;
  /** Big center label. */
  centerLabel?: React.ReactNode;
  centerCaption?: React.ReactNode;
  className?: string;
}

export function SegmentedDonut({
  segments,
  size = 160,
  thickness = 14,
  gapDegrees = 3,
  centerLabel,
  centerCaption,
  className,
}: SegmentedDonutProps) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0) || 1;
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - thickness) / 2;

  let cursor = -90; // 12 o'clock
  const arcs = segments.map((seg, i) => {
    const frac = Math.max(0, seg.value) / total;
    const sweep = frac * 360;
    const start = cursor + gapDegrees / 2;
    const end = cursor + sweep - gapDegrees / 2;
    cursor += sweep;
    const color = seg.color ?? chartPalette[i % chartPalette.length];
    // Skip degenerate arcs (start >= end after gap).
    const renderable = end > start;
    return { key: i, d: renderable ? describeArc(cx, cy, r, start, end) : '', color };
  });

  return (
    <div className={className} style={{ width: size, height: size, position: 'relative' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={trackColor()} strokeWidth={thickness} />
        {arcs.map((a) =>
          a.d ? (
            <path
              key={a.key}
              d={a.d}
              fill="none"
              stroke={a.color}
              strokeWidth={thickness}
              strokeLinecap="round"
            />
          ) : null,
        )}
      </svg>
      {(centerLabel != null || centerCaption != null) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {centerLabel != null && (
            <span className="text-2xl font-extrabold text-text-primary leading-none">
              {centerLabel}
            </span>
          )}
          {centerCaption != null && (
            <span className="mt-1 text-xs text-text-secondary">{centerCaption}</span>
          )}
        </div>
      )}
    </div>
  );
}

export default ProgressDonut;
