/* =============================================================================
   ServWave Charts — WaveAreaChart  (spec chart #01)
   Smooth area line with a soft gradient fill and rounded line caps.
   Single or multi-series. Colors from chartPalette / tokens (no rainbow).
   ============================================================================= */

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CurveType } from 'recharts/types/shape/Curve';
import { chartPalette, token } from '@/design-system';
import {
  axisLineColor,
  axisTick,
  gridStroke,
  tooltipContentStyle,
  tooltipLabelStyle,
} from './chartTheme';

export interface WaveAreaSeries {
  /** Key into each datum object. */
  dataKey: string;
  /** Legend / tooltip name. */
  name?: string;
  /** Stroke + gradient color. Defaults to chartPalette by index. */
  color?: string;
}

export interface WaveAreaChartProps<T extends Record<string, unknown>> {
  data: T[];
  /** X-axis category key. */
  xKey: keyof T & string;
  /** One or more series to draw. */
  series: WaveAreaSeries[];
  height?: number;
  /** Curve interpolation (rounded by default). */
  curve?: CurveType;
  /** Formatter for Y ticks / tooltip values. */
  valueFormatter?: (value: number) => string;
  /** Formatter for X ticks. */
  xFormatter?: (value: string) => string;
  /** Hide the Y axis (e.g. embedded mini panels). */
  hideYAxis?: boolean;
  className?: string;
}

export function WaveAreaChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  height = 240,
  curve = 'monotone',
  valueFormatter,
  xFormatter,
  hideYAxis = false,
  className,
}: WaveAreaChartProps<T>) {
  // Stable-ish gradient ids per render instance.
  const idBase = React.useId();

  return (
    <div className={className} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {series.map((s, i) => {
              const color = s.color ?? chartPalette[i % chartPalette.length];
              return (
                <linearGradient
                  key={s.dataKey}
                  id={`${idBase}-${s.dataKey}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>

          <CartesianGrid
            vertical={false}
            stroke={gridStroke()}
            strokeDasharray="3 3"
          />
          <XAxis
            dataKey={xKey}
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: axisLineColor() }}
            tickFormatter={xFormatter}
            minTickGap={16}
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
            contentStyle={tooltipContentStyle()}
            labelStyle={tooltipLabelStyle()}
            cursor={{ stroke: token('--border-color'), strokeWidth: 1 }}
            formatter={
              valueFormatter
                ? (value: number | string) => valueFormatter(Number(value))
                : undefined
            }
          />

          {series.map((s, i) => {
            const color = s.color ?? chartPalette[i % chartPalette.length];
            return (
              <Area
                key={s.dataKey}
                type={curve}
                dataKey={s.dataKey}
                name={s.name ?? s.dataKey}
                stroke={color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={`url(#${idBase}-${s.dataKey})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: color }}
                isAnimationActive={false}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default WaveAreaChart;
