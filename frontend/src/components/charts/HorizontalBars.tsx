/* =============================================================================
   ServWave Charts — HorizontalBars  (spec chart #04)
   Horizontal bars with fully-rounded caps on a neutral track (#E8ECEF token).
   Ideal for ranked categories (top sources, technicians, etc.). Single series.
   ============================================================================= */

import * as React from 'react';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { token } from '@/design-system';
import {
  axisTick,
  tooltipContentStyle,
  tooltipLabelStyle,
  trackColor,
} from './chartTheme';

export interface HorizontalBarsProps<T extends Record<string, unknown>> {
  data: T[];
  /** Category (label) key — rendered on the Y axis. */
  labelKey: keyof T & string;
  /** Value key — bar length. */
  valueKey: keyof T & string;
  height?: number;
  /** Bar fill. Defaults to the primary (ocean) token. */
  color?: string;
  colorFor?: (datum: T, index: number) => string | undefined;
  barSize?: number;
  /** Show the faint full-width capsule track behind each bar. */
  showTrack?: boolean;
  valueFormatter?: (value: number) => string;
  /** Width reserved for the category labels. */
  labelWidth?: number;
  className?: string;
}

export function HorizontalBars<T extends Record<string, unknown>>({
  data,
  labelKey,
  valueKey,
  height = 260,
  color,
  colorFor,
  barSize = 16,
  showTrack = true,
  valueFormatter,
  labelWidth = 96,
  className,
}: HorizontalBarsProps<T>) {
  const fill = color ?? token('--primary');
  const radius: [number, number, number, number] = [
    barSize / 2,
    barSize / 2,
    barSize / 2,
    barSize / 2,
  ];

  return (
    <div className={className} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={data}
          margin={{ top: 4, right: 12, bottom: 4, left: 0 }}
          barCategoryGap="30%"
        >
          <XAxis
            type="number"
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            tickFormatter={valueFormatter}
          />
          <YAxis
            type="category"
            dataKey={labelKey}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={labelWidth}
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
            dataKey={valueKey}
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

export default HorizontalBars;
