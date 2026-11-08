/* =============================================================================
   ServWave Charts — CapsuleBar  (spec chart #02)
   Vertical bar chart with fully-rounded "capsule" bars on a neutral track.
   Single series, categorical. Color from token (default success/green data
   signal); track from the border-soft token. No rainbow.
   ============================================================================= */

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { token } from '@/design-system';
import {
  axisLineColor,
  axisTick,
  gridStroke,
  tooltipContentStyle,
  tooltipLabelStyle,
  trackColor,
} from './chartTheme';

export interface CapsuleBarProps<T extends Record<string, unknown>> {
  data: T[];
  /** Category (x) key. */
  xKey: keyof T & string;
  /** Value (y) key. */
  yKey: keyof T & string;
  height?: number;
  /** Bar fill. Defaults to the success token (positive data signal). */
  color?: string;
  /** Per-bar color override, by datum index. Falls back to `color`. */
  colorFor?: (datum: T, index: number) => string | undefined;
  /** Max bar thickness in px. */
  barSize?: number;
  /** Show the faint full-height capsule track behind each bar. */
  showTrack?: boolean;
  valueFormatter?: (value: number) => string;
  hideYAxis?: boolean;
  className?: string;
}

export function CapsuleBar<T extends Record<string, unknown>>({
  data,
  xKey,
  yKey,
  height = 240,
  color,
  colorFor,
  barSize = 18,
  showTrack = true,
  valueFormatter,
  hideYAxis = false,
  className,
}: CapsuleBarProps<T>) {
  const fill = color ?? token('--success');
  // A pill-capped bar: radius = half the bar width rounds both ends fully.
  const radius: [number, number, number, number] = [
    barSize / 2,
    barSize / 2,
    barSize / 2,
    barSize / 2,
  ];

  return (
    <div className={className} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke={gridStroke()} strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey}
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: axisLineColor() }}
          />
          <YAxis
            hide={hideYAxis}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={valueFormatter}
          />
          <Tooltip
            cursor={{ fill: token('--border-soft'), opacity: 0.5 }}
            contentStyle={tooltipContentStyle()}
            labelStyle={tooltipLabelStyle()}
            formatter={
              valueFormatter
                ? (value: number | string) => valueFormatter(Number(value))
                : undefined
            }
          />
          <Bar
            dataKey={yKey}
            barSize={barSize}
            radius={radius}
            background={showTrack ? { fill: trackColor() } : undefined}
            isAnimationActive={false}
          >
            {data.map((datum, i) => (
              <Cell key={i} fill={colorFor?.(datum, i) ?? fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default CapsuleBar;
