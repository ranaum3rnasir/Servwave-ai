/* =============================================================================
   ServWave Charts — barrel.
   Reusable, presentational chart primitives. Every report/widget composes
   these; none re-styles Recharts inline. All colors read from
   `@/design-system` tokens (chartPalette / severityRamp / token()).

   Spec mapping:
     #01 WaveAreaChart   · #02 CapsuleBar     · #03 StackedBars
     #04 HorizontalBars  · #05 Funnel         · #06 ProgressDonut
     #07 GaugeArc        · #08 SegmentedDonut  · #10 SeverityBars
     #12 Sparkline
   Plus the shared ChartCard wrapper.
   ============================================================================= */

export { ChartCard } from './ChartCard';
export type {
  ChartCardProps,
  ChartCardSelectProps,
  ChartCardSelectOption,
} from './ChartCard';

export { WaveAreaChart } from './WaveAreaChart';
export type { WaveAreaChartProps, WaveAreaSeries } from './WaveAreaChart';

export { CapsuleBar } from './CapsuleBar';
export type { CapsuleBarProps } from './CapsuleBar';

export { StackedBars } from './StackedBars';
export type { StackedBarsProps, StackSeries } from './StackedBars';

export { HorizontalBars } from './HorizontalBars';
export type { HorizontalBarsProps } from './HorizontalBars';

export { ProgressDonut, SegmentedDonut } from './Donut';
export type {
  ProgressDonutProps,
  SegmentedDonutProps,
  DonutSegment,
} from './Donut';

export { GaugeArc } from './GaugeArc';
export type { GaugeArcProps } from './GaugeArc';

export { Funnel } from './Funnel';
export type { FunnelProps, FunnelStage } from './Funnel';

export { SeverityBars } from './SeverityBars';
export type { SeverityBarsProps } from './SeverityBars';

export { Sparkline } from './Sparkline';
export type { SparklineProps } from './Sparkline';
