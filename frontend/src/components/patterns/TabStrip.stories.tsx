/* =============================================================================
   TabStrip - Storybook stories, phase 12 composition-layer pass.

   WHY PATTERN STORIES LOOK DIFFERENT FROM ui/ STORIES. component-api-guard's
   `targetFiles()` excludes `components/ui/**` wholesale but does NOT exclude
   `.stories.tsx` by name, so this file is scanned and counted against
   `DIR_CEILINGS['components/patterns'] = 0` - zero appearance tokens on any
   tag. Every label, surface and seam below is therefore a primitive invoked
   with props (`Text tone`, `Stack gap`, `Card pad`), never a className. No
   colour, background, radius, border, shadow or padding class appears
   anywhere in this file. (Spelled out in words rather than as class prefixes
   on purpose: unresolved-classes-guard tokenises raw source text, comments
   included, so a list of hyphenated class stems written as prose reddens it -
   which is exactly what the first draft of this comment did.)
   That constraint is not a nuisance to work around; a composition pattern
   that cannot be demonstrated without hand-rolled appearance would be
   evidence the pattern is incomplete.

   NO cva() BLOCK HERE EITHER. TabStrip authors no classes at all - it
   forwards `padX`/`padTop`/`listVariant`/`triggerVariant`/`triggerClassName`
   to `TabsList`/`TabsTrigger` as identifiers. So storybook-completeness.test.ts
   has nothing to walk in this file, and the coverage that matters is the
   PROP CONTRACT: the tabs array, the controlled active/onChange pair, the
   two forwarded variant axes, disabled tabs, and ReactNode labels.

   WHY EVERY STORY HOLDS ITS OWN STATE. TabStrip is fully controlled - it has
   no internal active-tab state and never will (see its header note on why it
   is narrower than the DetailPageShell it replaced). A story that passed a
   fixed `active` with a no-op `onChange` would render a strip whose tabs do
   not respond to clicks, which would misrepresent the component as broken.
   Each story below therefore wires real `useState`, exactly as all six
   migrated call sites do.

   THE WRAPPERS ARE THE POINT, NOT SCAFFOLDING NOISE. TabStrip deliberately
   deleted `card`, `tabsSurface`, `listClassName`, `railWrapperClassName` and
   `contentWrapperClassName`. A caller that wants a card writes its own
   `<Card pad={0}>` around the strip. `InsideACard` below shows exactly that,
   because it is the shape InvoiceDetailPage actually ships - and showing it
   is how a designer learns the wrapper is theirs to change, not a prop to
   hunt for.
   ============================================================================= */
import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Stack } from '@/components/ui/stack';
import { TabsContent } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';

import { TabStrip, type TabStripTab } from './TabStrip';

const BASIC_TABS: TabStripTab[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'line-items', label: 'Line Items' },
  { value: 'activity', label: 'Activity' },
];

/** Body copy for a panel, as a primitive so this file authors no appearance. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <Stack gap={2}>
      <Text as="p" size="sm" tone="secondary">
        {children}
      </Text>
    </Stack>
  );
}

/**
 * TabStrip is fully controlled and will stay that way, so every story needs
 * real state behind it - a fixed `active` with a no-op `onChange` would
 * render a strip whose tabs do not respond to clicks and misrepresent the
 * component as broken.
 *
 * That state lives in this NAMED component rather than inline in each
 * story's `render` arrow, because a hook called inside an anonymous
 * `render` function violates `react-hooks/rules-of-hooks` - React only
 * guarantees hook identity inside a component or another hook, and an
 * arrow assigned to a `render` key is neither. Storybook renders it as one
 * either way, which is exactly what makes the mistake easy to ship.
 */
function ControlledTabStrip({
  initial,
  ...props
}: { initial: string } & Omit<React.ComponentProps<typeof TabStrip>, 'active' | 'onChange'>) {
  const [active, setActive] = React.useState(initial);
  return <TabStrip {...props} active={active} onChange={setActive} />;
}

const meta = {
  title: 'Patterns/TabStrip',
  component: TabStrip,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Generates a `<TabsList>` trigger row from a `{ value, label, disabled? }[]` array and wires it to a controlled active tab. That is the only shape genuinely shared across all six adopting pages - a card, a scroll rail or a tinted content tray is each page\'s own JSX, written around this component rather than configured through it. Replaced `DetailPageShell` (owner decision 2026-07-30), which had reached 11 configuration props across those same six call sites.',
      },
    },
  },
  argTypes: {
    tabs: {
      control: false,
      description:
        'The trigger row. Each `value` must match the `value` on its corresponding `<TabsContent>` child. `label` is `ReactNode`, not `string` - InvoiceDetailPage pairs every label with a count badge.',
    },
    active: { control: false, description: 'The controlled active tab value. TabStrip holds no state of its own.' },
    onChange: { control: false, description: 'Fired with the newly selected tab value.' },
    children: {
      control: false,
      description: 'The `<TabsContent>` panels, passed straight through and never restructured into an array.',
    },
    padX: {
      control: { type: 'select' },
      options: [undefined, 0, 1, 2, 3, 4, 6, 8],
      description:
        "Forwarded to `TabsList`'s own padding contract. NO default - a strip passed neither `padX` nor `padTop` emits no padding class at all.",
    },
    padTop: {
      control: { type: 'select' },
      options: [undefined, 0, 1, 2, 3, 4, 6, 8],
      description: "Forwarded to `TabsList`. NO default, same as `padX`.",
    },
    listVariant: {
      control: { type: 'inline-radio' },
      options: [undefined, 'line', 'solid'],
      description:
        "Forwarded to `TabsList`. Deliberately has NO default here - `TabsList` already defaults to `'line'`, and restating that default would be a second place for the same fact to drift.",
    },
    triggerVariant: {
      control: { type: 'inline-radio' },
      options: [undefined, 'line', 'solid'],
      description: "Forwarded uniformly to every generated `TabsTrigger`. Same no-default reasoning as `listVariant`.",
    },
    triggerClassName: {
      control: false,
      description: 'Applied uniformly to every generated trigger. Forwarded as an identifier, never authored here.',
    },
  },
} satisfies Meta<typeof TabStrip>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default shape: three tabs, controlled active state, no padding and no
 * variant overrides. This is what `<TabStrip>` renders when passed only the
 * three required props.
 */
export const Default: Story = {
  args: { tabs: BASIC_TABS, active: 'overview', onChange: () => {}, children: null },
  render: () => (
    <ControlledTabStrip tabs={BASIC_TABS} initial="overview">
      <TabsContent value="overview">
        <Panel>The overview panel. Click another tab - this strip is fully controlled.</Panel>
      </TabsContent>
      <TabsContent value="line-items">
        <Panel>The line items panel.</Panel>
      </TabsContent>
      <TabsContent value="activity">
        <Panel>The activity panel.</Panel>
      </TabsContent>
    </ControlledTabStrip>
  ),
};

/**
 * `label` is `ReactNode`, not `string`. InvoiceDetailPage pairs every label
 * with a live count, which is the reason the prop was never narrowed to a
 * string - a string-only API could not reproduce that call site.
 */
export const LabelsWithCounts: Story = {
  args: { tabs: BASIC_TABS, active: 'overview', onChange: () => {}, children: null },
  render: () => {
    const tabs: TabStripTab[] = [
      { value: 'overview', label: 'Overview' },
      {
        value: 'line-items',
        label: (
          <Stack direction="horizontal" align="center" gap={2}>
            <Text>Line Items</Text>
            <Badge>12</Badge>
          </Stack>
        ),
      },
      {
        value: 'activity',
        label: (
          <Stack direction="horizontal" align="center" gap={2}>
            <Text>Activity</Text>
            <Badge>3</Badge>
          </Stack>
        ),
      },
    ];
    return (
      <ControlledTabStrip tabs={tabs} initial="line-items">
        <TabsContent value="overview">
          <Panel>Counts live in the label node, so they update with the data behind them.</Panel>
        </TabsContent>
        <TabsContent value="line-items">
          <Panel>Twelve line items.</Panel>
        </TabsContent>
        <TabsContent value="activity">
          <Panel>Three activity entries.</Panel>
        </TabsContent>
      </ControlledTabStrip>
    );
  },
};

/**
 * A tab can be `disabled` - it renders in the row but cannot be selected.
 * Used where a section exists but has no data the current user may see.
 */
export const WithDisabledTab: Story = {
  args: { tabs: BASIC_TABS, active: 'overview', onChange: () => {}, children: null },
  render: () => {
    const tabs: TabStripTab[] = [
      { value: 'overview', label: 'Overview' },
      { value: 'line-items', label: 'Line Items' },
      { value: 'logistics', label: 'Logistics', disabled: true },
    ];
    return (
      <ControlledTabStrip tabs={tabs} initial="overview">
        <TabsContent value="overview">
          <Panel>Logistics is disabled - it stays visible but cannot be selected.</Panel>
        </TabsContent>
        <TabsContent value="line-items">
          <Panel>The line items panel.</Panel>
        </TabsContent>
        <TabsContent value="logistics">
          <Panel>Unreachable while the tab is disabled.</Panel>
        </TabsContent>
      </ControlledTabStrip>
    );
  },
};

/**
 * `padX` / `padTop` forwarded to `TabsList`. Both are undefined by default,
 * so an untouched strip emits no padding class at all - which is what lets a
 * caller inset the trigger row to match its own container without this
 * component guessing a value.
 */
export const WithPadding: Story = {
  args: { tabs: BASIC_TABS, active: 'overview', onChange: () => {}, children: null, padX: 6, padTop: 2 },
  render: (args) => (
    <ControlledTabStrip tabs={BASIC_TABS} initial="overview" padX={args.padX} padTop={args.padTop}>
      <TabsContent value="overview">
        <Panel>Trigger row inset by `padX`. Change it in the controls panel.</Panel>
      </TabsContent>
      <TabsContent value="line-items">
        <Panel>The line items panel.</Panel>
      </TabsContent>
      <TabsContent value="activity">
        <Panel>The activity panel.</Panel>
      </TabsContent>
    </ControlledTabStrip>
  ),
};

/**
 * The real InvoiceDetailPage shape: the caller wraps the strip in its own
 * `<Card pad={0}>`. TabStrip has no `card` prop - that was one of the six
 * props deleted when it replaced DetailPageShell, on the grounds that a card
 * is one page's structure rather than something every adopter shares.
 */
export const InsideACard: Story = {
  args: { tabs: BASIC_TABS, active: 'overview', onChange: () => {}, children: null },
  render: () => (
    <Card pad={0}>
      <ControlledTabStrip tabs={BASIC_TABS} initial="overview" padX={6} padTop={2}>
        <TabsContent value="overview">
          <Panel>The card is the caller's own JSX, written around the strip.</Panel>
        </TabsContent>
        <TabsContent value="line-items">
          <Panel>The line items panel.</Panel>
        </TabsContent>
        <TabsContent value="activity">
          <Panel>The activity panel.</Panel>
        </TabsContent>
      </ControlledTabStrip>
    </Card>
  ),
};

/**
 * A longer strip, the shape the settings and inventory pages adopted at
 * 11.6. Nothing changes structurally - the trigger row is generated from the
 * array, so growing it is a data change, not a markup change.
 */
export const ManyTabs: Story = {
  args: { tabs: BASIC_TABS, active: 'overview', onChange: () => {}, children: null },
  render: () => {
    const tabs: TabStripTab[] = [
      { value: 'general', label: 'General' },
      { value: 'branding', label: 'Branding' },
      { value: 'taxes', label: 'Taxes' },
      { value: 'locations', label: 'Locations' },
      { value: 'roles', label: 'Roles' },
    ];
    return (
      <ControlledTabStrip tabs={tabs} initial="general">
        {tabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <Panel>The {String(tab.label).toLowerCase()} panel.</Panel>
          </TabsContent>
        ))}
      </ControlledTabStrip>
    );
  },
};
