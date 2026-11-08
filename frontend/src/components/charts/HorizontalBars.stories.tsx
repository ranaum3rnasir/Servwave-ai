/* =============================================================================
   HorizontalBars - Storybook stories, chart primitive coverage pass (12b).

   HorizontalBars renders a single-series Recharts `<BarChart layout="vertical">`
   with fully rounded bar caps (`radius` is set to `barSize / 2` on all four
   corners) for ranked categories - top lead sources, top technicians, and
   so on. Every default named below is read straight from the component's
   own prop defaults: `height` 260, `barSize` 16, `showTrack` true,
   `labelWidth` 96.

   FOUR STORIES, EACH PINNED TO WHAT ITS PROP ACTUALLY CHANGES.
     Default         - every prop left at its default.
     WithoutTrack    - `showTrack={false}`; the neutral capsule track that
                       Recharts' `background` option paints behind each bar
                       (via the shared `trackColor()` helper) is omitted.
     WideLabels      - `labelWidth={160}` against category names long enough
                       ("Referral partner network") that the default 96px Y
                       axis label column would crowd or clip them - this is
                       the prop's actual reason to exist, not an arbitrary
                       wider number.
     InsideChartCard - the real composition every report call site uses:
                       `HorizontalBars` as `ChartCard`'s `children`, with a
                       title and subtitle, not the bare chart alone.

   `color`, `colorFor`, and `valueFormatter` are documented in `argTypes`
   (every prop the component takes gets a description, per house style) but
   are not exercised in a dedicated story of their own - none of the four
   variants above call for a second series color or a custom tick format,
   and adding one here would be a demo invented for its own sake rather than
   something this pass measured a real need for.

   META IS TYPED AGAINST A CONCRETE ROW SHAPE, NOT LEFT GENERIC.
   `HorizontalBars<T extends Record<string, unknown>>` is a generic function
   component, and `labelKey`/`valueKey` are typed `keyof T & string` - so its
   prop shape only resolves once `T` is fixed. `meta` below instantiates the
   component against this file's own `LeadSourceDatum` row shape
   (`typeof HorizontalBars<LeadSourceDatum>`) so `satisfies Meta<...>` and
   every story's `args` still type-check against the real prop names and
   defaults, rather than widening anything to `unknown` or `any`.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { ChartCard } from './ChartCard';
import { HorizontalBars } from './HorizontalBars';

type LeadSourceDatum = {
  source: string;
  leads: number;
};

const horizontalData: LeadSourceDatum[] = [
  { source: 'Referral', leads: 142 },
  { source: 'Google', leads: 118 },
  { source: 'Website', leads: 96 },
  { source: 'Repeat', leads: 74 },
  { source: 'Social', leads: 48 },
];

/** Same ranking, longer category names - what `labelWidth` exists to make room for. */
const wideLabelData: LeadSourceDatum[] = [
  { source: 'Referral partner network', leads: 142 },
  { source: 'Google Ads + organic search', leads: 118 },
  { source: 'Website contact form', leads: 96 },
  { source: 'Repeat customer outreach', leads: 74 },
  { source: 'Social media inbound', leads: 48 },
];

const meta = {
  title: 'Charts/HorizontalBars',
  component: HorizontalBars<LeadSourceDatum>,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Single-series horizontal bar chart with fully rounded caps, for ranked categories (top lead sources, top technicians, and so on). Wraps a Recharts `<BarChart layout="vertical">`; each bar can show a faint capsule track behind it via `showTrack`.',
      },
    },
  },
  argTypes: {
    data: {
      control: false,
      description: 'Row objects to plot, one bar per element, in the given order.',
    },
    labelKey: {
      control: false,
      description: 'Category key rendered on the Y axis. Must exist on every row in `data`.',
    },
    valueKey: {
      control: false,
      description: 'Value key that sets bar length. Must exist on every row in `data`.',
    },
    height: {
      control: { type: 'number' },
      description: 'Chart height in pixels. Defaults to 260.',
    },
    color: {
      control: false,
      description:
        'Bar fill for every row not covered by `colorFor`. Defaults to the primary (ocean) design token.',
    },
    colorFor: {
      control: false,
      description:
        'Optional per-datum/index fill override, called once per row. Falls back to `color` when it returns undefined.',
    },
    barSize: {
      control: { type: 'number' },
      description:
        'Bar thickness in pixels, and the basis for the fully rounded corner radius (`barSize / 2` on all four corners). Defaults to 16.',
    },
    showTrack: {
      control: 'boolean',
      description: 'Shows the faint full-width capsule track behind each bar. Defaults to true.',
    },
    valueFormatter: {
      control: false,
      description:
        'Formats the X axis ticks and the tooltip value. Left undefined, raw numbers render.',
    },
    labelWidth: {
      control: { type: 'number' },
      description: 'Width in pixels reserved for the Y axis category labels. Defaults to 96.',
    },
    className: {
      control: 'text',
      description: 'Applied to the outer wrapper div.',
    },
  },
} satisfies Meta<typeof HorizontalBars<LeadSourceDatum>>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Every prop at its default: 260px tall, 16px bars with rounded caps, track on, 96px label column. */
export const Default: Story = {
  args: {
    data: horizontalData,
    labelKey: 'source',
    valueKey: 'leads',
  },
};

/** `showTrack={false}` - the neutral capsule track behind each bar is omitted, leaving only the filled bar. */
export const WithoutTrack: Story = {
  args: {
    data: horizontalData,
    labelKey: 'source',
    valueKey: 'leads',
    showTrack: false,
  },
};

/** `labelWidth={160}` against category names long enough that the default 96px column would crowd them. */
export const WideLabels: Story = {
  args: {
    data: wideLabelData,
    labelKey: 'source',
    valueKey: 'leads',
    labelWidth: 160,
  },
};

/** The real call-site shape: `HorizontalBars` as `ChartCard`'s body, with a title and subtitle. */
export const InsideChartCard: Story = {
  args: {
    data: horizontalData,
    labelKey: 'source',
    valueKey: 'leads',
  },
  render: (args) => (
    <ChartCard title="Leads by Source" subtitle="Ranked, this quarter">
      <HorizontalBars {...args} />
    </ChartCard>
  ),
};
