/* =============================================================================
   CapsuleBar — Storybook stories, chart primitive story-coverage pass (12b).

   WHY THIS FILE EXISTS. CapsuleBar is spec chart #02 (see the numbered list
   in this folder's own index.ts) and shipped with no co-located story file -
   one of ten chart primitives being closed out in this same pass so every
   chart primitive is discoverable without reading source.

   THE FILL DEFAULTS TO A TOKEN, NOT A HARDCODED COLOR. `color` is optional;
   when it is left unset the component itself falls back to
   `token('--success')` internally, so Default below passes no `color` at all
   rather than re-stating that token from outside.

   `colorFor` IS THE PER-BAR VARIANT AXIS, AND IT IS NOT A CLASS LOOKUP.
   CapsuleBar has no `cva()` call - `colorFor(datum, index)` returns a color
   string per bar, or `undefined` to fall back to the flat `color`/token fill.
   PerBarColor below is the only story that exercises it, picking out the
   single highest value in the sample week rather than a fixed index, so the
   story keeps working if the sample data changes shape.

   HEIGHT IS A PIXEL NUMBER ON THE WRAPPING DIV, NOT A LAYOUT CLASS. The
   component sets `style={{ width: '100%', height }}` on its own outer div,
   so the 240 default read into argTypes below is the real source default,
   not a guess.

   SAMPLE DATA IS THE VERBATIM SET SPECIFIED FOR THIS PASS - six weekdays of
   a `jobs` count, Mon through Sat - reused unmodified across every story so
   the gallery reads as one dataset viewed through different props rather
   than six unrelated charts.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { CapsuleBar } from './CapsuleBar';
import { ChartCard } from './ChartCard';
import { chartPalette, token } from '@/design-system';

/** Verbatim sample set for this pass: a week of completed job counts. */
const capsuleData = [
  { day: 'Mon', jobs: 12 },
  { day: 'Tue', jobs: 18 },
  { day: 'Wed', jobs: 9 },
  { day: 'Thu', jobs: 22 },
  { day: 'Fri', jobs: 16 },
  { day: 'Sat', jobs: 7 },
];

const maxJobs = Math.max(...capsuleData.map((row) => row.jobs));

const meta = {
  title: 'Charts/CapsuleBar',
  component: CapsuleBar,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Vertical bar chart with fully-rounded capsule bars on an optional neutral track. Single series, categorical - color comes from a token by default, or from `color`/`colorFor` per call site.',
      },
    },
  },
  argTypes: {
    data: {
      control: false,
      description: 'Row data for the chart; each row renders as one capsule bar.',
    },
    xKey: {
      control: false,
      description: 'Category (x) key read from each row.',
    },
    yKey: {
      control: false,
      description: 'Value (y) key read from each row.',
    },
    height: {
      control: 'number',
      description: "Pixel height set on the chart's own wrapping div. Defaults to 240.",
    },
    color: {
      control: false,
      description: "Bar fill. Defaults to the success token ('--success') when left unset.",
    },
    colorFor: {
      control: false,
      description:
        'Per-bar color override, called with (datum, index) for every row; returning undefined falls back to `color`.',
    },
    barSize: {
      control: 'number',
      description:
        'Max bar thickness in pixels. Also sets the capsule radius, which is always half of barSize on all four corners. Defaults to 18.',
    },
    showTrack: {
      control: 'boolean',
      description: 'Shows the faint full-height capsule track behind each bar. Defaults to true.',
    },
    valueFormatter: {
      control: false,
      description: 'Formats the y-axis tick labels and the tooltip value when provided.',
    },
    hideYAxis: {
      control: 'boolean',
      description: 'Hides the y-axis entirely. Defaults to false.',
    },
    className: {
      control: false,
      description: "Applied to the chart's own wrapping div.",
    },
  },
} satisfies Meta<typeof CapsuleBar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No `color`, no `colorFor`, `showTrack` left at its default - the bars read the success token, on the neutral track. */
export const Default: Story = {
  args: {
    data: capsuleData,
    xKey: 'day',
    yKey: 'jobs',
  },
};

/** `showTrack={false}` - the same bars with no track behind them, for a busier layout that already supplies its own grid. */
export const WithoutTrack: Story = {
  args: {
    data: capsuleData,
    xKey: 'day',
    yKey: 'jobs',
    showTrack: false,
  },
};

/** `color` set explicitly via `token()` rather than left to the component's own default success token. */
export const CustomColor: Story = {
  args: {
    data: capsuleData,
    xKey: 'day',
    yKey: 'jobs',
    color: token('--info'),
  },
};

/** `colorFor` singles out the week's highest bar (Thu, 22) in a second palette color, leaving every other bar on the default fill. */
export const PerBarColor: Story = {
  args: {
    data: capsuleData,
    xKey: 'day',
    yKey: 'jobs',
    colorFor: (datum) => (datum.jobs === maxJobs ? chartPalette[2] : undefined),
  },
};

/** The chart as it actually ships - wrapped in ChartCard with a title and subtitle, not rendered bare. */
export const InsideChartCard: Story = {
  args: {
    data: capsuleData,
    xKey: 'day',
    yKey: 'jobs',
  },
  render: (args) => (
    <ChartCard title="Jobs Completed" subtitle="This week, by day">
      <CapsuleBar {...args} />
    </ChartCard>
  ),
};
