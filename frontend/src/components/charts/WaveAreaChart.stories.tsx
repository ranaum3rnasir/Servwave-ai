/* =============================================================================
   WaveAreaChart - Storybook stories.

   WaveAreaChart is generic: `WaveAreaChart<T extends Record<string, unknown>>`
   with props read straight from the source - `data: T[]`, `xKey: keyof T &
   string`, `series: { dataKey, name?, color? }[]`, `height = 240`,
   `curve: CurveType = 'monotone'`, `valueFormatter?`, `xFormatter?`,
   `hideYAxis = false`, `className?`. When a series omits `color`, the
   component falls back to `chartPalette` by index, so none of the stories
   below pass an explicit color - every gradient/stroke here is exercised via
   that default palette path, not a hardcoded value.

   TYPING. `Meta<typeof WaveAreaChart>` alone would lose the concrete `T` and
   let `args.series[].dataKey` widen to a bare `string`. Meta instead pins the
   generic with a TS instantiation expression, `WaveAreaChart<Row>`, where
   `Row` is derived from the sample data below - so `dataKey` narrows to
   `'month' | 'revenue' | 'target'` in every story's args.

   SAMPLE DATA. `waveData` is the same six-month revenue/target set the app's
   own design-system gallery page renders, reused verbatim per the program's
   sourcing convention - this is the actual two-series comparison shape most
   reports in the app render, not synthetic filler.

   COVERAGE. Default (single series) and MultiSeries (the real revenue vs
   target shape) cover the series axis. WithValueFormatter and HiddenYAxis
   each isolate one formatting/layout prop. InsideChartCard wraps the
   multi-series case in ChartCard, which is how every chart in this app is
   actually composed - a bare WaveAreaChart with no card chrome is the
   exception, not the rule, in real call sites.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { WaveAreaChart } from './WaveAreaChart';
import { ChartCard } from './ChartCard';

const waveData = [
  { month: 'Jan', revenue: 42000, target: 38000 },
  { month: 'Feb', revenue: 48500, target: 41000 },
  { month: 'Mar', revenue: 45200, target: 44000 },
  { month: 'Apr', revenue: 53800, target: 47000 },
  { month: 'May', revenue: 61200, target: 50000 },
  { month: 'Jun', revenue: 58900, target: 53000 },
];

type Row = (typeof waveData)[number];

const meta = {
  title: 'Charts/WaveAreaChart',
  component: WaveAreaChart<Row>,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Smooth Recharts area chart with a soft gradient fill and rounded line caps. Renders one `<Area>` per entry in `series`; each area gets its own linear gradient (22% opacity fading to 0). Colors default to `chartPalette` by index when a series omits `color`.',
      },
    },
  },
  argTypes: {
    data: {
      control: false,
      description: 'Row objects to plot. Each row must contain `xKey` plus every `series[].dataKey`.',
    },
    xKey: {
      control: false,
      description: 'X-axis category key, typed as `keyof T & string`. Read off each row via Recharts `dataKey`.',
    },
    series: {
      control: false,
      description:
        'One or more `{ dataKey, name?, color? }` entries, one `<Area>` per entry. `name` defaults to `dataKey`; `color` defaults to `chartPalette` by index.',
    },
    height: {
      control: { type: 'number' },
      description: 'Pixel height of the chart wrapper. Defaults to 240.',
    },
    curve: {
      control: { type: 'select' },
      options: ['monotone', 'linear', 'natural', 'step', 'stepBefore', 'stepAfter'],
      description: "Recharts curve interpolation passed to every `<Area>`'s `type`. Defaults to 'monotone'.",
    },
    valueFormatter: {
      control: false,
      description: 'Formats Y-axis ticks and, when set, also formats the tooltip value via `Number(value)`.',
    },
    xFormatter: {
      control: false,
      description: 'Formats X-axis tick labels. Not applied to the tooltip label.',
    },
    hideYAxis: {
      control: { type: 'boolean' },
      description: 'Hides the Y axis (source docstring: e.g. embedded mini panels). Defaults to false.',
    },
    className: {
      control: 'text',
      description: 'Forwarded to the root wrapping div alongside the inline `width`/`height` style.',
    },
  },
} satisfies Meta<typeof WaveAreaChart<Row>>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A single series: `dataKey: 'revenue'` named 'Revenue'. */
export const Default: Story = {
  args: {
    data: waveData,
    xKey: 'month',
    series: [{ dataKey: 'revenue', name: 'Revenue' }],
  },
};

/** Two series, revenue plus target - the real actual-vs-target comparison shape most reports render. */
export const MultiSeries: Story = {
  args: {
    data: waveData,
    xKey: 'month',
    series: [
      { dataKey: 'revenue', name: 'Revenue' },
      { dataKey: 'target', name: 'Target' },
    ],
  },
};

/** `valueFormatter` reshapes both the Y-axis ticks and the tooltip value, e.g. 45000 renders as 45k. */
export const WithValueFormatter: Story = {
  args: {
    data: waveData,
    xKey: 'month',
    series: [{ dataKey: 'revenue', name: 'Revenue' }],
    valueFormatter: (value: number) => `${Math.round(value / 1000)}k`,
  },
};

/** `hideYAxis` removes the Y axis entirely, matching the source docstring's embedded-mini-panel use case. */
export const HiddenYAxis: Story = {
  args: {
    data: waveData,
    xKey: 'month',
    series: [{ dataKey: 'revenue', name: 'Revenue' }],
    hideYAxis: true,
  },
};

/**
 * The multi-series chart wrapped in ChartCard - the real composition every
 * chart in this app ships inside, not a bare Recharts element on the page.
 */
export const InsideChartCard: Story = {
  args: {
    data: waveData,
    xKey: 'month',
    series: [
      { dataKey: 'revenue', name: 'Revenue' },
      { dataKey: 'target', name: 'Target' },
    ],
  },
  render: () => (
    <ChartCard title="Revenue vs Target" subtitle="Monthly, actual vs target">
      <WaveAreaChart
        data={waveData}
        xKey="month"
        series={[
          { dataKey: 'revenue', name: 'Revenue' },
          { dataKey: 'target', name: 'Target' },
        ]}
      />
    </ChartCard>
  ),
};
