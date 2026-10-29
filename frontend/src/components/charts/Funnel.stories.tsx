/* =============================================================================
   ServWave Charts — Funnel, Storybook stories.

   Funnel is a custom SVG conversion funnel, no charting library: each stage
   is a trapezoid whose top edge is `stage.value / max` of the 100-unit
   viewBox width and whose bottom edge morphs into the NEXT stage's width
   (the last stage has no next, so its trapezoid stays rectangular). Below
   the SVG, a plain list repeats each stage's label, its value (or
   `valueFormatter(value)` when supplied), and, when `showConversion` is
   true (the default), that stage's percentage of the FIRST stage's value —
   the first stage itself never shows a percentage, since it has nothing to
   compare against.

   COLOR HAS TWO INDEPENDENT LAYERS. Every stage without its own `color`
   falls back to the `color` prop, which itself defaults to
   `token('--primary')` — so an unstyled Funnel is one hue, distinguished
   stage-to-stage only by an opacity ramp the component computes from the
   stage index (`1 - i * (0.6 / stages.length)`), fading later stages
   lighter. `PerStageColor` below proves the per-stage override reads
   straight through to the trapezoid fill, independent of that ramp.

   `height` vs LAYOUT ARE SEPARATE NUMBERS. The SVG's viewBox height is
   always `stages.length * (bandHeight + gap)`, computed from the stage
   count regardless of what `height` is — `height` only sets the rendered
   `<svg height>` attribute, and because the SVG uses
   `preserveAspectRatio="none"`, a `height` that disagrees with the natural
   viewBox height stretches or squashes the whole drawing rather than
   changing how much room each band gets. None of the stories below pass an
   explicit `height` for that reason: `CompactBands` gets a shorter funnel by
   lowering `bandHeight`/`gap`, which is legible, not by overriding `height`,
   which would just distort it.

   THE SAMPLE DATA IS THE APP'S OWN PIPELINE — Leads through Paid, the same
   five stages `Funnel`'s own doc comment implies this component exists to
   chart — reused verbatim across every story so a reader can compare the
   list's percentages story to story instead of re-deriving what each
   dataset means.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Funnel, type FunnelStage } from './Funnel';
import { ChartCard } from './ChartCard';
import { token } from '@/design-system';

const funnelStages: FunnelStage[] = [
  { label: 'Leads', value: 480 },
  { label: 'Estimates', value: 312 },
  { label: 'Approved', value: 188 },
  { label: 'Jobs', value: 164 },
  { label: 'Paid', value: 141 },
];

/** Same five stages, each pinned to a distinct semantic token instead of the shared default fill. */
const coloredFunnelStages: FunnelStage[] = [
  { label: 'Leads', value: 480, color: token('--info') },
  { label: 'Estimates', value: 312, color: token('--ai') },
  { label: 'Approved', value: 188, color: token('--success') },
  { label: 'Jobs', value: 164, color: token('--warning') },
  { label: 'Paid', value: 141, color: token('--primary') },
];

const meta = {
  title: 'Charts/Funnel',
  component: Funnel,
  tags: ['autodocs'],
  argTypes: {
    stages: {
      control: false,
      description:
        'Ordered `{label, value, color?}` stages. Each trapezoid width is proportional to `value / max(...stages)`, and morphs into the next stage width at its bottom edge.',
    },
    height: {
      control: { type: 'number' },
      description:
        'Rendered SVG height in px. Defaults to `stages.length * (bandHeight + gap)` — the natural layout height — when omitted.',
    },
    color: {
      control: 'color',
      description:
        "Fallback trapezoid fill for any stage without its own `color`. Defaults to `token('--primary')`.",
    },
    valueFormatter: {
      control: false,
      description: 'Formats the value shown next to each stage label in the list. Defaults to the raw number.',
    },
    showConversion: {
      control: 'boolean',
      description:
        "Shows each stage's percentage of the first stage's value in the list, for every stage after the first. Defaults to true.",
    },
    bandHeight: {
      control: { type: 'number' },
      description: 'Height of each trapezoid band in px. Defaults to 44.',
    },
    gap: {
      control: { type: 'number' },
      description: 'Vertical gap between bands in px. Defaults to 8.',
    },
    className: {
      control: false,
      description: 'Applied to the outer wrapping element.',
    },
  },
} satisfies Meta<typeof Funnel>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The app's own lead-to-paid pipeline, every prop at its default. */
export const Default: Story = {
  args: { stages: funnelStages },
};

/** `showConversion={false}` — the percentage column disappears from the list; only values remain. */
export const WithoutConversion: Story = {
  args: { stages: funnelStages, showConversion: false },
};

/** `bandHeight={28}`, `gap={4}` — a denser variant for tighter layouts, same data. */
export const CompactBands: Story = {
  args: { stages: funnelStages, bandHeight: 28, gap: 4 },
};

/** Each stage set to its own `color`, read from a distinct semantic token — proves the per-stage override path. */
export const PerStageColor: Story = {
  args: { stages: coloredFunnelStages },
};

/** The funnel as it actually ships: inside a `ChartCard` with a title and subtitle. */
export const InsideChartCard: Story = {
  args: { stages: funnelStages },
  render: () => (
    <ChartCard title="Sales Funnel" subtitle="Lead to paid">
      <Funnel stages={funnelStages} />
    </ChartCard>
  ),
};
