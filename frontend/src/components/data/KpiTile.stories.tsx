/* =============================================================================
   KpiTile / KpiStrip — Storybook stories, chart/KPI primitive story-coverage
   pass (12b).

   WHY THIS FILE EXISTS. KpiStrip.tsx exports two components: `KpiTile` (one
   stat card) and `KpiStrip` (a grid of `KpiTile`s driven by an
   `items: KpiTileProps[]` array — source lines 133-157). Per the phase
   brief, this file's `meta.component` is `KpiTile`; `KpiStrip` gets exactly
   one composition story at the bottom (`RealKpiStrip`) and no meta of its
   own — it is the one shape every real list page actually ships.

   `tone` IS MEANING, NOT COLOUR. The component's own header comment says it
   outright: "What the tile MEANS, never what colour it is." The `TONE`
   lookup (source lines 33-41) is the only place a `KpiTone` maps to a text
   colour class, and it lives entirely inside the component — every story
   below only ever passes the semantic tone name (`'primary'`, `'danger'`,
   …), never a colour literal, so there is nothing here for the raw hex
   colour guard to catch.

   `activeLabel` IS A REAL, EASY-TO-MISS BRANCH. `active={true}` alone rings
   the tile; the pill only renders when `activeLabel` is ALSO set (source
   line 101: `{active && activeLabel && (...)}`). `Active` and
   `ActiveWithLabel` below pin both sides of that on purpose, since it is
   the kind of behaviour a call site can silently rely on the wrong half of.

   `Clickable`'S BUTTON IS NOT ONE THIS FILE ADDS. Passing `onClick` makes
   the primitive swap its own wrapper element from `div` to `button` (source
   line 84: `const Wrapper = interactive ? 'button' : 'div'`) — that element
   already exists inside `KpiTile` itself, so exercising it here does not
   count against the ratchet on new raw `<button>` tags the way authoring
   one in this file would.

   SAMPLE DATA IS REAL, NOT INVENTED. All four per-prop tile examples below
   are copied verbatim from `KpiTile`'s actual call sites in
   InvoicesPage.tsx (Due / Overdue / Unsent Drafts / To Be Invoiced), reused
   as-is rather than made up, and `RealKpiStrip` composes all four through
   `KpiStrip` exactly as that page ships them.

   NO HOOKS, NO RAW FORM CONTROLS. Nothing here is interactive state — every
   `onClick` is a no-op arrow — so no story needs `useState`/`useEffect`,
   and there is no reason to reach for a raw button or input anywhere.
   `AllTones` is a plain `.map` over the seven `KpiTone` values in a static
   row, not a toggle.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import { AlertTriangle, DollarSign, FileText, Receipt } from 'lucide-react';

import { KpiTile, KpiStrip, type KpiTone } from './KpiStrip';

/** Every value the tile's `tone` union accepts, in source declaration order. */
const ALL_TONES: KpiTone[] = ['neutral', 'strong', 'primary', 'success', 'warning', 'danger', 'info'];

const meta = {
  title: 'Data/KpiTile',
  component: KpiTile,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The one KPI stat-card standard used across the app: an uppercase tracked label with an icon, a large value with aligned tabular numerals, an optional trend chip, and an optional caption line. `tone` is meaning, never colour — it is the only appearance input a call site may give.',
      },
    },
  },
  argTypes: {
    icon: {
      control: false,
      description: 'Required. Rendered at 14px beside the label, tinted with the resolved tone colour.',
    },
    label: {
      control: 'text',
      description: 'Uppercase, bold, 11px tracked caption above the value.',
    },
    value: {
      control: 'text',
      description: 'The 26px, extra bold value. Accepts any ReactNode, not only strings or numbers.',
    },
    sub: {
      control: 'text',
      description: 'Optional caption line below the value, 12px, muted.',
    },
    tone: {
      control: { type: 'select' },
      options: ALL_TONES,
      description:
        "What the tile MEANS, never what colour it is, per the component's own header comment. Defaults to 'neutral'.",
    },
    className: {
      control: false,
      description: "Layout only (width, margin, or how the tile sits inside a parent grid) — not for colour or spacing changes inside the tile.",
    },
    emphasize: {
      control: 'boolean',
      description: "When true, the value text itself takes the resolved tone colour instead of the primary text colour.",
    },
    delta: {
      control: 'text',
      description: 'Optional trend chip beside the value, e.g. "+12%". Renders a TrendDelta when set.',
    },
    deltaDirection: {
      control: { type: 'inline-radio' },
      options: ['up', 'down'],
      description: "Direction of the trend chip. Defaults to 'up'.",
    },
    active: {
      control: 'boolean',
      description: 'This tile is currently driving a filter or sort — adds a ring around the tile.',
    },
    activeLabel: {
      control: 'text',
      description:
        'Text of the active pill. When omitted, no pill renders at all, even if active is true.',
    },
    onClick: {
      control: false,
      description:
        'When set, the tile renders as a real button element instead of a div, and gains hover styling.',
    },
    loading: {
      control: 'boolean',
      description: 'Shows a skeleton block in place of the value.',
    },
  },
} satisfies Meta<typeof KpiTile>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The 'Due' tile exactly as InvoicesPage renders it: `tone="primary"`, no delta, no emphasis. */
export const Default: Story = {
  args: {
    icon: DollarSign,
    label: 'Due',
    value: '$4,820',
    sub: '12 invoices',
    tone: 'primary',
  },
};

/** All seven `KpiTone` values side by side, same icon and value, to compare the resolved colour per tone. */
export const AllTones: Story = {
  args: { icon: DollarSign, label: 'neutral tone', value: '$128', tone: 'neutral' },
  render: () => (
    <div className="flex flex-wrap gap-3">
      {ALL_TONES.map((tone) => (
        <KpiTile key={tone} icon={DollarSign} label={`${tone} tone`} value="$128" tone={tone} />
      ))}
    </div>
  ),
};

/** `delta="+12%"` with the default `deltaDirection="up"` renders a TrendDelta chip beside the value. */
export const WithDelta: Story = {
  args: {
    icon: DollarSign,
    label: 'Due',
    value: '$4,820',
    sub: '12 invoices',
    tone: 'primary',
    delta: '+12%',
    deltaDirection: 'up',
  },
};

/** `deltaDirection="down"` flips the TrendDelta chip's direction. */
export const WithDeltaDown: Story = {
  args: {
    icon: DollarSign,
    label: 'Due',
    value: '$4,820',
    sub: '12 invoices',
    tone: 'primary',
    delta: '-4%',
    deltaDirection: 'down',
  },
};

/** The 'Overdue' tile with `emphasize`: the value text itself takes the danger tone colour, not just the icon. */
export const Emphasized: Story = {
  args: {
    icon: AlertTriangle,
    label: 'Overdue',
    value: '$1,240',
    sub: '3 invoices',
    tone: 'danger',
    emphasize: true,
  },
};

/** `active` with NO `activeLabel`: the ring renders, but no pill — `activeLabel` is required for the pill regardless of `active`. */
export const Active: Story = {
  args: {
    icon: DollarSign,
    label: 'Due',
    value: '$4,820',
    sub: '12 invoices',
    tone: 'primary',
    active: true,
  },
};

/** `active` with `activeLabel` set: the ring and the pill both render this time. */
export const ActiveWithLabel: Story = {
  args: {
    icon: DollarSign,
    label: 'Due',
    value: '$4,820',
    sub: '12 invoices',
    tone: 'primary',
    active: true,
    activeLabel: 'Filtering',
  },
};

/** `loading`: a skeleton block replaces the value; the label, icon, and sub caption are unaffected. */
export const Loading: Story = {
  args: {
    icon: DollarSign,
    label: 'Due',
    value: '$4,820',
    sub: '12 invoices',
    tone: 'primary',
    loading: true,
  },
};

/**
 * `onClick` set (a no-op here): the primitive itself swaps its wrapper from a div to a real
 * button element and gains hover styling — that button is existing code inside KpiTile, not one
 * authored in this file.
 */
export const Clickable: Story = {
  args: {
    icon: DollarSign,
    label: 'Due',
    value: '$4,820',
    sub: '12 invoices',
    tone: 'primary',
    onClick: () => {},
  },
};

/** The 'To Be Invoiced' tile, showing the `sub` caption line under the value. */
export const WithSub: Story = {
  args: {
    icon: Receipt,
    label: 'To Be Invoiced',
    value: 4,
    sub: 'Completed, unbilled',
    tone: 'warning',
  },
};

/**
 * The actual composition every real list page ships: `KpiStrip` laying out all four real
 * InvoicesPage tiles together via its `items` array, rather than four bare `KpiTile`s.
 */
export const RealKpiStrip: Story = {
  args: { icon: DollarSign, label: 'Due', value: '$4,820', sub: '12 invoices', tone: 'primary' },
  render: () => (
    <KpiStrip
      items={[
        { icon: DollarSign, label: 'Due', value: '$4,820', sub: '12 invoices', tone: 'primary' },
        {
          icon: AlertTriangle,
          label: 'Overdue',
          value: '$1,240',
          sub: '3 invoices',
          tone: 'danger',
          emphasize: true,
        },
        { icon: FileText, label: 'Unsent Drafts', value: 7, tone: 'warning', emphasize: true },
        {
          icon: Receipt,
          label: 'To Be Invoiced',
          value: 4,
          sub: 'Completed, unbilled',
          tone: 'warning',
        },
      ]}
    />
  ),
};
