/* =============================================================================
   ServWave Charts — Funnel  (spec chart #05)
   Custom SVG conversion funnel. Each stage is a centered trapezoid whose width
   is proportional to its value; a soft connector links stages. Colors from a
   single token by default (no rainbow) with optional per-stage override.
   ============================================================================= */

import * as React from 'react';
import { token } from '@/design-system';

export interface FunnelStage {
  label: string;
  value: number;
  color?: string;
}

export interface FunnelProps {
  stages: FunnelStage[];
  height?: number;
  /** Default stage fill. Defaults to primary (ocean). */
  color?: string;
  /** Format the value shown on each stage. */
  valueFormatter?: (value: number) => string;
  /** Show conversion % relative to the first stage. */
  showConversion?: boolean;
  /** Height of each stage band, in px. */
  bandHeight?: number;
  /** Vertical gap between bands, in px. */
  gap?: number;
  className?: string;
}

export function Funnel({
  stages,
  height,
  color,
  valueFormatter,
  showConversion = true,
  bandHeight = 44,
  gap = 8,
  className,
}: FunnelProps) {
  const fill = color ?? token('--primary');
  const max = Math.max(...stages.map((s) => Math.max(0, s.value)), 1);
  const width = 100; // viewBox units; scales to container.
  const topValue = stages[0]?.value ?? 0;

  const totalHeight = height ?? stages.length * (bandHeight + gap);
  const viewHeight = stages.length * (bandHeight + gap);

  return (
    <div className={className} style={{ width: '100%' }}>
      <svg
        width="100%"
        height={totalHeight}
        viewBox={`0 0 ${width} ${viewHeight}`}
        preserveAspectRatio="none"
        role="img"
      >
        {stages.map((stage, i) => {
          const w = (Math.max(0, stage.value) / max) * width;
          const next = stages[i + 1];
          const nextW = next ? (Math.max(0, next.value) / max) * width : w;
          const x = (width - w) / 2;
          const nextX = (width - nextW) / 2;
          const y = i * (bandHeight + gap);
          const segFill = stage.color ?? fill;

          // Trapezoid morphing from this stage's width to the next.
          const points = [
            `${x},${y}`,
            `${x + w},${y}`,
            `${nextX + nextW},${y + bandHeight}`,
            `${nextX},${y + bandHeight}`,
          ].join(' ');

          return (
            <polygon
              key={i}
              points={points}
              fill={segFill}
              opacity={1 - i * (0.6 / Math.max(1, stages.length))}
            />
          );
        })}
      </svg>

      <ul className="mt-3 space-y-1.5">
        {stages.map((stage, i) => {
          const conv = topValue > 0 ? (stage.value / topValue) * 100 : 0;
          return (
            <li
              key={i}
              className="flex items-center justify-between text-xs"
            >
              <span className="text-text-secondary">{stage.label}</span>
              <span className="font-semibold text-text-primary tabular-nums">
                {valueFormatter ? valueFormatter(stage.value) : stage.value}
                {showConversion && i > 0 && (
                  <span className="ml-2 font-normal text-text-soft">
                    {Math.round(conv)}%
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default Funnel;
