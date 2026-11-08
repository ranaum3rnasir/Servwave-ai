/* =============================================================================
   SegmentedDonut - Storybook stories.

   WHY THIS FILE ONLY COVERS SegmentedDonut. Donut.tsx exports two components:
   `ProgressDonut` (the file's default export) and `SegmentedDonut` (a named
   export) - a custom SVG multi-segment ring, not a Recharts pie, per the
   file's own header comment ("Recharts can't give us rounded stroke caps + a
   clean center label cheaply"). The barrel comment in charts/index.ts marks
   them as two distinct spec numbers (#06 ProgressDonut, #08 SegmentedDonut),
   so they get two distinct story files; this one imports `{ SegmentedDonut }`
   by name and never touches ProgressDonut.

   THE GAP IS THE WHOLE POINT OF `gapDegrees`. Each segment's sweep is
   `value / total` of the 360-degree ring, then trimmed by half of
   `gapDegrees` (default 3) off BOTH its start and end - so a wider gap
   visibly shrinks every arc, not just the space between them. When that trim
   leaves `end <= start` the arc is skipped rather than drawn degenerate;
   nothing here exercises that path since every sample below has a
   comfortably positive value.

   COLOR FALLBACK IS PER-INDEX, NOT PER-VALUE. A segment with no `color` reads
   `chartPalette[i % chartPalette.length]` at its position in the array, so
   WithExplicitColors below overrides that per-segment via `token(...)`
   instead of inventing a hex value, and the legend under Default indexes the
   same palette the component itself falls back to - the identical pattern
   already composed next to `SegmentedDonut` in DesignSystemPage.tsx's
   "Estimate Mix" card.

   THE CENTER OVERLAY IS CONDITIONAL, NOT MERELY EMPTY. The `div` wrapping
   `centerLabel`/`centerCaption` is gated on
   `centerLabel != null || centerCaption != null` - omit both and that node
   never mounts at all, a real, distinct code path, covered by
   NoCenterContent below (not just "both props happen to be unset").
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { SegmentedDonut, type DonutSegment } from './Donut';
import { ChartCard } from './ChartCard';
import { chartPalette, token } from '@/design-system';

/** The bundled real sample data - reused verbatim across every story below. */
const segments: DonutSegment[] = [
  { label: 'Approved', value: 48 },
  { label: 'Pending', value: 26 },
  { label: 'Draft', value: 18 },
  { label: 'Declined', value: 8 },
];

/** The same segments, each pinned to a semantic token instead of the palette fallback. */
const segmentsWithExplicitColors: DonutSegment[] = [
  { label: 'Approved', value: 48, color: token('--success') },
  { label: 'Pending', value: 26, color: token('--warning') },
  { label: 'Draft', value: 18, color: token('--info') },
  { label: 'Declined', value: 8, color: token('--danger') },
];

const twoSegments: DonutSegment[] = [
  { label: 'Paid', value: 72 },
  { label: 'Unpaid', value: 28 },
];

/**
 * Legend swatch color for the segment at `index`, read from the same
 * `chartPalette` the component itself falls back to when a segment omits
 * `color` - mirrors the legend already composed next to `SegmentedDonut` in
 * DesignSystemPage.tsx.
 */
function legendColor(index: number): string {
  return chartPalette[index % chartPalette.length]!;
}

const meta = {
  title: 'Charts/SegmentedDonut',
  component: SegmentedDonut,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "Custom SVG multi-segment ring (not Recharts). Each segment's sweep is proportional to its `value`, with a small gap trimmed off both ends of every arc. A segment with no `color` falls back to `chartPalette[i % chartPalette.length]`. The center overlay renders only when at least one of `centerLabel` / `centerCaption` is set.",
      },
    },
  },
  argTypes: {
    segments: {
      control: false,
      description:
        'Array of `{ label, value, color? }`. Each sweep is `value / total` of the ring; `color` falls back to `chartPalette[i % chartPalette.length]` when omitted.',
    },
    size: {
      control: { type: 'number' },
      description: 'Diameter of the SVG, in pixels. Defaults to 160.',
    },
    thickness: {
      control: { type: 'number' },
      description: 'Stroke width of the ring, in pixels. Defaults to 14.',
    },
    gapDegrees: {
      control: { type: 'number' },
      description:
        'Gap between adjacent segments, in degrees, trimmed evenly off each segment\'s start and end. Defaults to 3.',
    },
    centerLabel: {
      control: 'text',
      description:
        'Big center label. The center overlay only renders at all when this or `centerCaption` is set.',
    },
    centerCaption: {
      control: 'text',
      description: 'Small caption under the center label.',
    },
    className: {
      control: 'text',
      description: 'Passed through to the outer wrapping `div`.',
    },
  },
} satisfies Meta<typeof SegmentedDonut>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The bundled sample segments with a center label/caption pair, plus the
 * legend list callers compose alongside the donut elsewhere in the app - see
 * DesignSystemPage's "Estimate Mix" card, which uses this exact swatch
 * pattern.
 */
export const Default: Story = {
  args: {
    segments,
    centerLabel: '100',
    centerCaption: 'estimates',
  },
  render: (args) => (
    <div className="flex flex-col items-center gap-4 py-2">
      <SegmentedDonut {...args} />
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        {segments.map((s, i) => (
          <li key={s.label} className="flex items-center gap-1.5 text-xs text-text-secondary">
            <span
              className="inline-block h-2.5 w-2.5 rounded-pill"
              style={{ backgroundColor: legendColor(i) }}
            />
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  ),
};

/**
 * Every segment sets its own `color` via `token(...)`, bypassing the
 * `chartPalette` fallback entirely - the override path on `DonutSegment.color`.
 */
export const WithExplicitColors: Story = {
  args: {
    segments: segmentsWithExplicitColors,
    centerLabel: '100',
    centerCaption: 'estimates',
  },
};

/**
 * Neither `centerLabel` nor `centerCaption` is set, so the center overlay
 * never mounts at all (it is gated on `centerLabel != null || centerCaption
 * != null`) - the ring renders alone over an empty center.
 */
export const NoCenterContent: Story = {
  args: {
    segments,
  },
};

/**
 * `gapDegrees={10}` (default is 3) trims more off both ends of every arc,
 * visibly shrinking each segment as the gap between them widens.
 */
export const WideGap: Story = {
  args: {
    segments,
    gapDegrees: 10,
    centerLabel: '100',
    centerCaption: 'estimates',
  },
};

/** A simple two-way split - paid vs. unpaid - the most common real shape. */
export const TwoSegments: Story = {
  args: {
    segments: twoSegments,
    centerLabel: '72%',
    centerCaption: 'paid',
  },
};

/** Composed inside `ChartCard`, the shared wrapper every chart primitive ships in. */
export const InsideChartCard: Story = {
  args: { segments, centerLabel: '100', centerCaption: 'estimates' },
  render: () => (
    <ChartCard title="Estimate Mix" subtitle="By status">
      <div className="flex justify-center py-2">
        <SegmentedDonut segments={segments} centerLabel="100" centerCaption="estimates" />
      </div>
    </ChartCard>
  ),
};
