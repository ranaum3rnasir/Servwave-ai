/* =============================================================================
   ServWave Charts - SeverityBars, Storybook stories.

   SeverityBars is generic: `SeverityBars<T extends Record<string, unknown>>`
   with props read straight from the source - `data: T[]`, `xKey: keyof T &
   string`, `yKey: keyof T & string`, `height = 240`, `barSize = 22`,
   `severityFor?: (datum: T, index: number) => number`, `showTrack = true`,
   `valueFormatter?`, `hideYAxis = false`, `className?`.

   THE WHOLE POINT OF THIS COMPONENT IS THAT THE CALLER NEVER PASSES A COLOR.
   Unlike every other bar chart in this batch, there is no `color` or
   `colorFor` prop here at all - the only override is `severityFor`, and it
   returns a ramp INDEX (0 = healthiest, clamped to the last slot = most
   severe), never a color value. Every bar's fill comes from the source
   file's own `rampAt`/`rampColor` helpers reading `severityRamp` (imported
   from `@/design-system`), full stop. So no story below ever demonstrates a
   `color` prop, because the component has none to demonstrate.

   TWO WAYS A BAR GETS ITS RAMP SLOT. When `severityFor` is omitted, the
   source's `rampColor(index, count)` spreads each bar's position in `data`
   evenly across the full ramp - that is the real, most common usage, and it
   is what `Default` below exercises with no `severityFor` at all. When
   `severityFor` is passed, it can read anything off the datum - typically a
   field that carries its own severity independent of array order -
   `CustomSeverityMapping` proves that path with a `riskLevel` field whose
   values are deliberately NOT in the same order as the buckets.

   SAMPLE DATA. `agingData` is AR aging buckets, increasing severity left to
   right, which the source docstring calls out by name as the ordering this
   component is built for ("buckets in increasing-severity order, left to
   right"). Reused verbatim per this batch's sourcing convention.

   TYPING. Same seam as `WaveAreaChart.stories.tsx`: `Meta<typeof
   SeverityBars>` alone would lose the concrete `T` and widen `xKey`/`yKey`
   to bare `string`. Meta instead pins the generic with a TS instantiation
   expression, `SeverityBars<Row>`, where `Row` is derived from `agingData`.
   `CustomSeverityMapping` needs a second, unrelated row shape (an extra
   `riskLevel` field `Row` does not have), so that one story uses `render`
   with its own inline JSX instead of `args` - the generic there is inferred
   fresh from its own data array, independent of the pinned meta type,
   exactly the way `InsideChartCard` already needs `render` for its `ChartCard`
   wrapper rather than a plain prop bag.

   COVERAGE. `Default` covers the path with no `severityFor` at all, the
   real, most common usage. `WithValueFormatter` isolates the Y axis/tooltip
   formatting prop. `CustomSeverityMapping` proves the override path reads
   data, not index. `WithoutTrack` isolates the neutral background track.
   `InsideChartCard` mirrors how every chart in this app is actually
   composed - a bare SeverityBars with no card chrome is the exception, not
   the rule, in real call sites.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { SeverityBars } from './SeverityBars';
import { ChartCard } from './ChartCard';

const agingData = [
  { bucket: 'Current', amount: 38400 },
  { bucket: '1-30', amount: 21200 },
  { bucket: '31-60', amount: 12800 },
  { bucket: '61-90', amount: 7400 },
  { bucket: '90+', amount: 4200 },
];

type Row = (typeof agingData)[number];

/**
 * A second row shape, unrelated to `Row` - each datum carries its own
 * `riskLevel` (0 = healthiest, 5 = most severe) and the buckets are
 * deliberately NOT ordered by that value, so `CustomSeverityMapping` below
 * can prove `severityFor` is reading the field, not the array position.
 */
const riskData = [
  { bucket: 'Warranty', amount: 15200, riskLevel: 1 },
  { bucket: 'Cash', amount: 9800, riskLevel: 0 },
  { bucket: 'Net 30', amount: 26400, riskLevel: 3 },
  { bucket: 'Net 60', amount: 11100, riskLevel: 5 },
  { bucket: 'Disputed', amount: 4300, riskLevel: 2 },
];

const meta = {
  title: 'Charts/SeverityBars',
  component: SeverityBars<Row>,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "Recharts vertical bar chart whose fill colors always come from `severityRamp` - never an inline color. By default each bar's ramp slot is its position in `data`, spread evenly across the ramp; `severityFor` overrides that mapping to read a severity index off the datum instead.",
      },
    },
  },
  argTypes: {
    data: {
      control: false,
      description: 'Row objects to plot, one bar per row. Each row must contain `xKey` plus `yKey`.',
    },
    xKey: {
      control: false,
      description:
        'Category (x) key. Per the source docstring, buckets should be ordered by increasing severity, left to right.',
    },
    yKey: {
      control: false,
      description: 'Value (y) key.',
    },
    height: {
      control: { type: 'number' },
      description: 'Pixel height of the chart wrapper. Defaults to 240.',
    },
    barSize: {
      control: { type: 'number' },
      description: 'Recharts bar thickness in pixels. Defaults to 22.',
    },
    severityFor: {
      control: false,
      description:
        "Maps a datum to a severity ramp index (0 = healthiest, clamped to the last slot = most severe). When omitted, the index is the datum's position in `data`, spread evenly across the full ramp - the path `Default` below exercises.",
    },
    showTrack: {
      control: { type: 'boolean' },
      description: 'Renders a neutral background track behind each bar. Defaults to true.',
    },
    valueFormatter: {
      control: false,
      description: 'Formats Y axis ticks and, when set, also formats the tooltip value via `Number(value)`.',
    },
    hideYAxis: {
      control: { type: 'boolean' },
      description: 'Hides the Y axis. Defaults to false.',
    },
    className: {
      control: 'text',
      description: 'Forwarded to the root wrapping div alongside the inline `width`/`height` style.',
    },
  },
} satisfies Meta<typeof SeverityBars<Row>>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * No `severityFor` - each bar's ramp slot is its own position in `data`,
 * spread evenly across the full ramp. This is the real, most common usage:
 * AR aging buckets already ordered current through most overdue.
 */
export const Default: Story = {
  args: {
    data: agingData,
    xKey: 'bucket',
    yKey: 'amount',
  },
};

/** `valueFormatter` reshapes both the Y axis ticks and the tooltip value, e.g. 38400 renders as 38k. */
export const WithValueFormatter: Story = {
  args: {
    data: agingData,
    xKey: 'bucket',
    yKey: 'amount',
    valueFormatter: (value: number) => `${Math.round(value / 1000)}k`,
  },
};

/**
 * `severityFor` reads an explicit `riskLevel` field per datum instead of
 * array position - the buckets here are NOT in severity order (Net 60 is
 * fourth but carries the highest `riskLevel`, 5), so a correct render here
 * proves the override maps by data, not by index.
 */
export const CustomSeverityMapping: Story = {
  // `args` is required by StoryObj even though `render` supplies its own JSX
  // below - it is a stub satisfying meta's pinned `Row` type, unused at
  // runtime, because `riskData`'s extra `riskLevel` field falls outside `Row`.
  args: { data: agingData, xKey: 'bucket', yKey: 'amount' },
  render: () => (
    <SeverityBars
      data={riskData}
      xKey="bucket"
      yKey="amount"
      severityFor={(datum) => datum.riskLevel}
    />
  ),
};

/** `showTrack={false}` removes the neutral background track from behind every bar. */
export const WithoutTrack: Story = {
  args: {
    data: agingData,
    xKey: 'bucket',
    yKey: 'amount',
    showTrack: false,
  },
};

/**
 * The chart as it actually ships: wrapped in `ChartCard` with a title and
 * subtitle, matching how every chart in this app is composed in real pages.
 */
export const InsideChartCard: Story = {
  args: { data: agingData, xKey: 'bucket', yKey: 'amount' },
  render: () => (
    <ChartCard title="AR Aging" subtitle="Green to terracotta ramp">
      <SeverityBars data={agingData} xKey="bucket" yKey="amount" />
    </ChartCard>
  ),
};
