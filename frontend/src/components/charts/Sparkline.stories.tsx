/* =============================================================================
   ServWave Charts — Sparkline, Storybook stories.

   Sparkline is a pure SVG micro-chart for KPI tiles — no axes, no grid, no
   legend, just a line (optionally filled) through `data`, drawn via
   `smoothPath()` from `./chartTheme`. Defaults read straight off the source:
   `width = 96`, `height = 28`, `strokeWidth = 2`, `fill = true`,
   `endDot = true`, and `color` falls back to `token('--primary')` when
   omitted.

   TWO REAL DEGENERATE CASES, EACH WORTH ITS OWN STORY. `data.length === 0`
   is an explicit early return (source lines 43-45): the component renders a
   bare `<svg>` with no `<path>` at all, carrying only its size, `role`, and
   `aria-label`. A single-point array is not an error either — that point's
   `x` centers at `innerW / 2` instead of the `(i / (data.length - 1))`
   division that would otherwise divide by zero. Empty and SinglePoint below
   pin both.

   NO HOOKS NEEDED. Sparkline takes no event handlers and holds no open or
   closed state, so every story here is a static `args` object except
   TrendColors, which only needs plain JSX (two Sparklines side by side) —
   not a wrapper component or `useState`.

   ARIA LABEL IS MANDATORY ON EVERY STORY. The rendered element is a bare
   `<svg role="img">` with no visible text of its own, so `ariaLabel` is the
   only accessible description it ever gets — every story below sets one.

   TRENDCOLORS' DECLINING SERIES. Only one real sample array (`sparkData`)
   was supplied for this batch. To show the success/danger pairing the way it
   is actually used — an up trend next to a down trend — `declineData` below
   is that same real series reversed, not invented numbers: still real
   weekly-count data, just read back to front so it falls instead of rises.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Sparkline } from './Sparkline';
import { token } from '@/design-system';

const sparkData = [12, 15, 11, 18, 16, 22, 19, 26, 24, 31];
const declineData = [...sparkData].reverse();

const meta = {
  title: 'Charts/Sparkline',
  component: Sparkline,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "Inline micro-chart for KPI tiles — a smooth line with an optional soft gradient fill and an end dot, no axes or chrome. Empty `data` renders a bare, path-less svg; a single-point `data` centers that one point instead of dividing by zero.",
      },
    },
  },
  argTypes: {
    data: {
      control: false,
      description:
        'Series of numbers. Empty array is a valid input handled by an explicit early return; a single value is centered rather than treated as an error.',
    },
    width: {
      control: { type: 'number' },
      description: 'Pixel width of the svg. Defaults to 96.',
    },
    height: {
      control: { type: 'number' },
      description: 'Pixel height of the svg. Defaults to 28.',
    },
    color: {
      control: 'color',
      description: "Stroke (and fill/dot) color. Defaults to `token('--primary')` when omitted.",
    },
    strokeWidth: {
      control: { type: 'number' },
      description:
        'Line stroke width in pixels. Also sets the end dot radius (`strokeWidth + 0.5`) and the inner padding around the plotted area. Defaults to 2.',
    },
    fill: {
      control: { type: 'boolean' },
      description:
        'Soft area fill under the line, drawn as a linear gradient from 20% down to 0% opacity of the stroke color. Defaults to true.',
    },
    endDot: {
      control: { type: 'boolean' },
      description: 'Circle marking the last data point. Defaults to true.',
    },
    className: {
      control: 'text',
      description: 'Applied to the root svg element.',
    },
    ariaLabel: {
      control: 'text',
      description:
        'Accessible description rendered as the svg `aria-label` alongside `role="img"`. The svg has no visible text of its own.',
    },
  },
} satisfies Meta<typeof Sparkline>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The real sample series with every other prop left at its default: filled area, 2px stroke, end dot. */
export const Default: Story = {
  args: { data: sparkData, ariaLabel: 'Weekly job volume, trending up' },
};

/** `fill={false}` — only the stroked line renders, no gradient area beneath it. */
export const NoFill: Story = {
  args: { data: sparkData, fill: false, ariaLabel: 'Weekly job volume, trending up, no fill' },
};

/** `endDot={false}` — no circle marks the last point. */
export const NoEndDot: Story = {
  args: { data: sparkData, endDot: false, ariaLabel: 'Weekly job volume, trending up, no end dot' },
};

/**
 * The real comparison pattern: an up trend and a down trend side by side,
 * colored via `token('--success')` and `token('--danger')` respectively.
 */
export const TrendColors: Story = {
  args: { data: sparkData, ariaLabel: 'Completed jobs, trending up' },
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-start gap-1">
        <span>Completed jobs</span>
        <Sparkline
          data={sparkData}
          color={token('--success')}
          ariaLabel="Completed jobs, trending up"
        />
      </div>
      <div className="flex flex-col items-start gap-1">
        <span>Cancelled jobs</span>
        <Sparkline
          data={declineData}
          color={token('--danger')}
          ariaLabel="Cancelled jobs, trending down"
        />
      </div>
    </div>
  ),
};

/** `data={[]}` — the component's explicit early return: no path, just a bare labeled svg at the requested size. */
export const Empty: Story = {
  args: { data: [], ariaLabel: 'No data available' },
};

/** `data={[42]}` — the one-point special case: the point centers at `innerW / 2` instead of dividing by zero. */
export const SinglePoint: Story = {
  args: { data: [42], ariaLabel: 'Single data point' },
};
