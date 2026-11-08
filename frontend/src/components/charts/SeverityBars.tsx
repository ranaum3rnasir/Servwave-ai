/* =============================================================================
   ServWave Charts — SeverityBars  (spec chart #10)
   Categorical bars colored along the severity ramp (green → terracotta) for
   "worse as it goes" scales like AR aging buckets. Rounded caps, neutral track.
   Colors come from severityRamp in tokens — never inline.
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
import { severityRamp, token } from '@/design-system';
import {
  axisLineColor,
  axisTick,
  gridStroke,
  tooltipContentStyle,
  tooltipLabelStyle,
  trackColor,
} from './chartTheme';

export interface SeverityBarsProps<T extends Record<string, unknown>> {
  data: T[];
  /** Category (x) key — buckets in increasing-severity order, left→right. */
  xKey: keyof T & string;
  /** Value (y) key. */
  yKey: keyof T & string;
  height?: number;
  barSize?: number;
  /**
   * Map a datum to a severity index (0 = healthiest). Defaults to the datum's
   * position in `data`, sampled evenly across the ramp.
   */
  severityFor?: (datum: T, index: number) => number;
  showTrack?: boolean;
  valueFormatter?: (value: number) => string;
  hideYAxis?: boolean;
  className?: string;
}

/** Clamp + read a ramp color by slot (never undefined). */
function rampAt(slot: number): string {
  const i = Math.max(0, Math.min(severityRamp.length - 1, slot));
  return severityRamp[i] ?? severityRamp[0]!;
}

/** Pick a ramp color for `index` of `count`, spread across the full ramp. */
function rampColor(index: number, count: number): string {
  if (count <= 1) return severityRamp[0]!;
  const pos = index / (count - 1); // 0..1
  return rampAt(Math.round(pos * (severityRamp.length - 1)));
}

export function SeverityBars<T extends Record<string, unknown>>({
  data,
  xKey,
  yKey,
  height = 240,
  barSize = 22,
  severityFor,
  showTrack = true,
  valueFormatter,
  hideYAxis = false,
  className,
}: SeverityBarsProps<T>) {
  const radius: [number, number, number, number] = [6, 6, 0, 0];

  return (
    <div className={className} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
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
            {data.map((datum, i) => {
              const color = severityFor
                ? rampAt(severityFor(datum, i))
                : rampColor(i, data.length);
              return <Cell key={i} fill={color} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default SeverityBars;
