/* =============================================================================
   ServWave Charts — ProgressDonut, Storybook stories.

   ProgressDonut is a single-value progress ring built from raw SVG (no
   charting library) — a full-circle track from `trackColor()` under a value
   arc swept clockwise from 12 o'clock, both drawn with
   `strokeLinecap="round"`. The value arc's own path is only rendered at all
   when `pct > 0`, and its stroke defaults to `token('--success')` unless
   `color` overrides it. `label` defaults to the rounded percentage
   (`Math.round(pct * 100)}%`) and `caption` is a second, smaller line under
   it that only renders when non-null. `size` defaults to 160, `thickness`
   to 14.

   `Donut.tsx` exports TWO components — ProgressDonut and SegmentedDonut —
   and this file covers ProgressDonut only; SegmentedDonut gets its own
   story file. The default export of `Donut.tsx` is ProgressDonut, but this
   file uses the named import (`import { ProgressDonut } from './Donut'`)
   to match the house convention already used at every real call site,
   including the barrel (`components/charts/index.ts`).

   FULL IS A REAL EDGE CASE, NOT A TRIVIAL ONE. The component's own source
   comment notes the track arc is swept to `start + 359.999`, not a full
   360, specifically to avoid a full-circle SVG arc collapsing to nothing —
   `value={1}` below exercises that same seam on the value arc's sweep.

   MOST STORIES ARE STATIC `args` OBJECTS. ProgressDonut takes no event
   handlers and has no open/closed state to drive, so there is nothing here
   that needs a `render` closure, a wrapper component, or a hook — every
   variant is just a different prop combination on the same component.
   InsideChartCard is the one exception, since it needs real JSX (a
   `ChartCard` plus a centering wrapper) around the component rather than
   just prop values.

   InsideChartCard mirrors the one real call site (`DesignSystemPage.tsx`,
   which this batch is retiring in favor of per-component stories): a
   ProgressDonut centered inside a `ChartCard` via a plain
   `flex justify-center` wrapper. That page's copy uses `subtitle="ProgressDonut"`;
   this story instead uses `subtitle="% of invoices paid"` per this batch's
   brief, since the caption already says what the number means and the
   component's own name is not useful subtitle copy.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { ProgressDonut } from './Donut';
import { ChartCard } from './ChartCard';
import { token } from '@/design-system';

const meta = {
  title: 'Charts/ProgressDonut',
  component: ProgressDonut,
  tags: ['autodocs'],
  argTypes: {
    value: {
      control: { type: 'number' },
      description: 'Completion fraction, clamped to 0-1. Drives how far the value arc sweeps.',
    },
    size: {
      control: { type: 'number' },
      description: 'Width and height of the ring in pixels. Defaults to 160.',
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
      description: 'Big center label. Defaults to the rounded percentage (e.g. "82%") when omitted.',
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
} satisfies Meta<typeof ProgressDonut>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The real call site's props: 82% complete with a caption naming what it measures. */
export const Default: Story = {
  args: { value: 0.82, caption: 'of invoices paid' },
};

/** `value === 0` — `pct > 0` is false, so only the track circle renders, no value arc at all. */
export const Empty: Story = {
  args: { value: 0, caption: 'of invoices paid' },
};

/**
 * `value === 1` — the value arc's sweep end lands on the same seam the
 * component's track arc already avoids (a literal full 360° circle can
 * collapse to an invisible SVG path), so this is a real edge case worth
 * pinning, not a trivial one.
 */
export const Full: Story = {
  args: { value: 1, caption: 'of invoices paid' },
};

/** `label` overrides the default rounded percentage text with any custom node. */
export const CustomLabel: Story = {
  args: { value: 0.5, label: '41/82', caption: 'jobs closed' },
};

/** `color` overrides the default success stroke — here with `token('--danger')`. */
export const DangerColor: Story = {
  args: { value: 0.24, caption: 'of invoices overdue', color: token('--danger') },
};

/** A smaller ring — `size={96}`, `thickness={8}` — for tighter layouts than the 160px default. */
export const Small: Story = {
  args: { value: 0.82, size: 96, thickness: 8, caption: 'of invoices paid' },
};

/**
 * The ring as it actually ships: centered inside a `ChartCard` with a
 * title and subtitle, matching the one real call site.
 */
export const InsideChartCard: Story = {
  args: { value: 0.82, caption: 'of invoices paid' },
  render: () => (
    <ChartCard title="Collection Rate" subtitle="% of invoices paid">
      <div className="flex justify-center py-2">
        <ProgressDonut value={0.82} caption="of invoices paid" />
      </div>
    </ChartCard>
  ),
};
