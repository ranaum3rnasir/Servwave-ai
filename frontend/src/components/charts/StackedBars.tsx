/* =============================================================================
   ServWave Charts — StackedBars  (spec chart #03)
   Vertical stacked bars with rounded caps on the top-most segment only and a
   neutral track. Series colors from chartPalette / tokens. No rainbow.
   ============================================================================= */

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { chartPalette, token } from '@/design-system';
import {
  axisLineColor,
  axisTick,
  gridStroke,
  tooltipContentStyle,
  tooltipLabelStyle,
} from './chartTheme';

export interface StackSeries {
  dataKey: string;
  name?: string;
  color?: string;
}

export interface StackedBarsProps<T extends Record<string, unknown>> {
  data: T[];
  xKey: keyof T & string;
  series: StackSeries[];
  height?: number;
  /** Rounded cap radius on the top segment. */
  radius?: number;
  barSize?: number;
  valueFormatter?: (value: number) => string;
  hideYAxis?: boolean;
  className?: string;
}

export function StackedBars<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  height = 260,
  radius = 6,
  barSize = 22,
  valueFormatter,
  hideYAxis = false,
  className,
}: StackedBarsProps<T>) {
  const lastIndex = series.length - 1;

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
          {series.map((s, i) => {
            const color = s.color ?? chartPalette[i % chartPalette.length];
            // Round only the top of the top-most segment for a clean cap.
            const r: [number, number, number, number] =
              i === lastIndex ? [radius, radius, 0, 0] : [0, 0, 0, 0];
            return (
              <Bar
                key={s.dataKey}
                dataKey={s.dataKey}
                name={s.name ?? s.dataKey}
                stackId="stack"
                fill={color}
                barSize={barSize}
                radius={r}
                isAnimationActive={false}
              />
            );
          })}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default StackedBars;
