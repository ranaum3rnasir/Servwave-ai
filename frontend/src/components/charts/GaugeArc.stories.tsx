/* =============================================================================
   ServWave Charts — GaugeArc, Storybook stories.

   GaugeArc is a half-circle progress gauge built from raw SVG (no charting
   library) — a track arc from `token('--border-soft')` via `trackColor()`,
   plus a value arc swept from `min` to `max` in `token('--success')` unless
   `color` overrides it, both drawn with `strokeLinecap="round"` so the ends
   are rounded rather than square-cut. `min` defaults to 0, `max` to 100, so
   a bare `value` reads as a percentage — CustomRange below proves that is a
   convention, not a hard limit: the component clamps `frac` to [0, 1] off
   whatever `(value - min) / (max - min)` is, so any numeric range works.
   `label` defaults to the raw `value` number if omitted; `caption` is a
   second, smaller line under it and is only rendered when non-null.

   ALL STORIES ARE STATIC `args` OBJECTS. GaugeArc takes no event handlers
   and has no open/closed state to drive like the portalled dialogs
   elsewhere in this stories batch, so there is nothing here that needs a
   `render` closure, a wrapper component, or a hook — every variant is just
   a different prop combination on the same component.

   InsideChartCard mirrors the one real call site (`DesignSystemPage.tsx`,
   which this batch is retiring in favor of per-component stories): a
   GaugeArc centered inside a `ChartCard`. That page's copy uses
   `subtitle="GaugeArc"`; this story instead uses `subtitle="% utilized"` per
   this batch's brief, since the caption already says "GaugeArc" nowhere and
   "% utilized" is what the number on screen actually means.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { GaugeArc } from './GaugeArc';
import { ChartCard } from './ChartCard';
import { token } from '@/design-system';

const meta = {
  title: 'Charts/GaugeArc',
  component: GaugeArc,
  tags: ['autodocs'],
  argTypes: {
    value: {
      control: { type: 'number' },
      description: 'Current value. Drives how far the value arc sweeps between `min` and `max`.',
    },
    min: {
      control: { type: 'number' },
      description: 'Bottom of the range the gauge represents. Defaults to 0.',
    },
    max: {
      control: { type: 'number' },
      description: 'Top of the range the gauge represents. Defaults to 100.',
    },
    size: {
      control: { type: 'number' },
      description: 'Width of the gauge in pixels (the SVG height is half that, plus stroke padding). Defaults to 180.',
    },
    thickness: {
      control: { type: 'number' },
      description: 'Stroke width of both the track and value arcs, in pixels. Defaults to 14.',
    },
    color: {
      control: 'color',
      description: "Value arc color. Defaults to `token('--success')` when omitted.",
    },
    label: {
      control: 'text',
      description: 'Big center label. Defaults to the raw `value` number when omitted.',
    },
    caption: {
      control: 'text',
      description: 'Small line under the label. Only rendered when set.',
    },
    className: {
      control: false,
      description: 'Applied to the outer wrapping element.',
    },
  },
} satisfies Meta<typeof GaugeArc>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The real call site's props: a 0-100 default range read as a percentage. */
export const Default: Story = {
  args: { value: 74, caption: '% utilized' },
};

/** `value === min` — the value arc's `frac` is 0, so only the track renders. */
export const AtMin: Story = {
  args: { value: 0, min: 0, max: 100, caption: '% utilized' },
};

/** `value === max` — `frac` clamps to 1, so the value arc sweeps the full half-circle. */
export const AtMax: Story = {
  args: { value: 100, min: 0, max: 100, caption: '% utilized' },
};

/**
 * A 0-500 range, not the default 0-100 — shows the gauge is driven by
 * `(value - min) / (max - min)`, not hardcoded to read as a percentage.
 */
export const CustomRange: Story = {
  args: { value: 340, min: 0, max: 500, caption: 'units this month' },
};

/** `color` overrides the default success stroke — here with `token('--danger')`. */
export const DangerColor: Story = {
  args: { value: 92, caption: '% utilized', color: token('--danger') },
};

/**
 * The gauge as it actually ships: centered inside a `ChartCard` with a
 * title and subtitle, matching the one real call site.
 */
export const InsideChartCard: Story = {
  args: { value: 74, caption: '% utilized' },
  render: () => (
    <ChartCard title="Technician Utilization" subtitle="% utilized">
      <div className="flex justify-center">
        <GaugeArc value={74} caption="% utilized" />
      </div>
    </ChartCard>
  ),
};
