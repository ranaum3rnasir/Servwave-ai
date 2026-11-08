/* =============================================================================
   ServWave Charts — StackedBars stories

   WHY THIS FILE LOOKS THE WAY IT DOES. StackedBars<T> renders a Recharts
   vertical BarChart with every series sharing stackId="stack", so segments
   pile into one bar per category tick instead of drawing side by side. The
   component's own comment on `radius` ("Round only the top of the top-most
   segment for a clean cap") plus the `i === lastIndex` check in its render
   loop mean rounding is applied to exactly one <Bar> - the LAST entry in the
   `series` array, which is also the visually top-most stacked segment. Every
   story below keeps 'travel' last in its `series` array so that fact stays
   demonstrably true across the whole file: whichever story you open, the
   rounded cap sits on the travel segment, not on labor or parts.

   Colors are never passed explicitly in `series` - `color` is optional and
   the component falls back to `chartPalette[i % chartPalette.length]`, so
   these stories exercise that default path rather than re-deriving colors
   here (also keeps this file clear of the raw-hex guard entirely).

   Real facts read from StackedBars.tsx, cited in argTypes below: height
   defaults to 260, radius defaults to 6, barSize defaults to 22, hideYAxis
   defaults to false, and valueFormatter (when set) drives both the Y-axis
   tick labels and the tooltip's value formatting.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { ChartCard } from './ChartCard';
import { StackedBars } from './StackedBars';

/** One week of cost-breakdown data - the real shape this chart renders in the app. */
interface WeeklyCost extends Record<string, unknown> {
  week: string;
  labor: number;
  parts: number;
  travel: number;
}

const stackedData: WeeklyCost[] = [
  { week: 'W1', labor: 18000, parts: 9000, travel: 2200 },
  { week: 'W2', labor: 21000, parts: 11500, travel: 2800 },
  { week: 'W3', labor: 16500, parts: 8200, travel: 1900 },
  { week: 'W4', labor: 24000, parts: 13000, travel: 3100 },
];

const costSeries = [
  { dataKey: 'labor', name: 'Labor' },
  { dataKey: 'parts', name: 'Parts' },
  { dataKey: 'travel', name: 'Travel' },
];

/** Same weekly rows, only labor and travel plotted - travel still last, still on top. */
const twoSeries = [
  { dataKey: 'labor', name: 'Labor' },
  { dataKey: 'travel', name: 'Travel' },
];

/**
 * Thousands-with-k-suffix formatter, self-contained on purpose - no shared
 * currency helper is imported so this story reads standalone.
 */
function formatK(value: number): string {
  return `$${(value / 1000).toFixed(1)}k`;
}

const meta = {
  title: 'Charts/StackedBars',
  component: StackedBars,
  tags: ['autodocs'],
  argTypes: {
    data: {
      control: false,
      description: 'Array of row objects, one per category tick on the x-axis.',
    },
    xKey: {
      control: false,
      description: 'Key into each data row read for the x-axis category label.',
    },
    series: {
      control: false,
      description:
        'Ordered {dataKey, name?, color?} list, one per stacked segment. Order is bottom-to-top - the LAST entry is the top-most segment and the only one that gets a rounded cap. `color` falls back to chartPalette by index when omitted.',
    },
    height: {
      control: { type: 'number' },
      description: 'Chart height in pixels. Defaults to 260.',
    },
    radius: {
      control: { type: 'number' },
      description:
        'Corner radius applied only to the top of the last (top-most) stacked segment. Defaults to 6.',
    },
    barSize: {
      control: { type: 'number' },
      description: 'Bar thickness in pixels. Defaults to 22.',
    },
    valueFormatter: {
      control: false,
      description:
        'Optional (value: number) => string formatter, used for both the Y-axis tick labels and the tooltip value.',
    },
    hideYAxis: {
      control: 'boolean',
      description: 'Hides the Y axis entirely when true. Defaults to false.',
    },
    className: {
      control: false,
      description: 'Passed through to the chart\'s outer wrapping element.',
    },
  },
} satisfies Meta<typeof StackedBars<WeeklyCost>>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The real 3-series cost breakdown this chart renders in the app: labor,
 * parts, and travel stacked per week, travel on top with the rounded cap.
 */
export const Default: Story = {
  args: {
    data: stackedData,
    xKey: 'week',
    series: costSeries,
  },
};

/**
 * Same weekly rows with only two series plotted, showing the shape scales
 * down cleanly - travel is still last, so it still carries the rounded cap.
 */
export const TwoSeries: Story = {
  args: {
    data: stackedData,
    xKey: 'week',
    series: twoSeries,
  },
};

/**
 * `valueFormatter` set to a thousands-with-k-suffix formatter - both the
 * Y-axis ticks and the tooltip values render through it.
 */
export const WithValueFormatter: Story = {
  args: {
    data: stackedData,
    xKey: 'week',
    series: costSeries,
    valueFormatter: formatK,
  },
};

/**
 * Wrapped in ChartCard the way a real dashboard panel would host it, with a
 * title and subtitle above the chart.
 */
export const InsideChartCard: Story = {
  args: {
    data: stackedData,
    xKey: 'week',
    series: costSeries,
  },
  render: (args) => (
    <ChartCard title="Cost Breakdown" subtitle="Labor / parts / travel">
      <StackedBars {...args} />
    </ChartCard>
  ),
};
