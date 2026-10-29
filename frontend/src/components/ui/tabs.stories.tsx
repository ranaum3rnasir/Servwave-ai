/* =============================================================================
   Tabs cluster (Tabs, TabsList, TabsTrigger, TabsContent) - Storybook stories,
   full coverage pass (Storybook phase, W2 plan).

   Storybook 8 is already scaffolded in this worktree (.storybook/main.ts,
   .storybook/preview.ts, @storybook/react-vite in package.json) - this file
   imports the real `Meta` / `StoryObj` types, matching card.stories.tsx /
   dialog.stories.tsx / dropdown-menu.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant key and every value tabs.tsx exposes needs at least one story that
   renders it.

     tabs.tsx ships NO cva() block - `class-variance-authority` is not
     imported anywhere in the file. Every axis is a hand-rolled
     `Record<Key, string>` lookup instead, exactly the situation
     dropdown-menu.stories.tsx and dialog.stories.tsx document for their own
     files: there is no cva() for a completeness parser to walk, so the
     target for this file is the real, shipped prop surface, covered
     exhaustively below, not just the interactive default.

       Tabs.surface (TabsSurface)              plain | card
         -> Surfaces (both, side by side).
       TabsList.variant (TabsListVariant)       line | pill
         -> ListVariants (both, each a full working tab set).
       TabsTrigger.variant (TabsTriggerVariant) line | underline |
                                                 underline-fill | pill
         -> TriggerVariants (all four) + UnderlineFillActiveTab (the one
            variant that wraps its children in an extra bar span - see
            tabs.tsx's own header comment and __tests__/tabs.test.tsx
            section 3 for why that behaviour gets its own story rather than
            just another grid cell).
       TabsTrigger padX / padY (PadStep, design-system/spacing.ts - the same
       vocabulary word TabsList/TabsContent use below, not a bespoke `size`
       scale; see tabs.tsx's own header comment for why an earlier pass on
       this file that called this axis `size` was wrong)
         -> TriggerPadding (the three real measured pairs, each paired with
            the real variant its evidence ties it to - see tabs.tsx's own
            header comment table and __tests__/tabs.test.tsx's
            EVIDENCE_VARIANT map).
       TabsList / TabsContent PadProps (pad, padX, padY, padTop, padRight,
       padBottom, padLeft - design-system/spacing.ts, spread into both
       components' prop types, not declared in this file but a real part of
       what a call site can pass to either export)
         -> ContentPaddingSteps / ListPaddingSteps (the full 13-step ladder,
            one per component, matching card.stories.tsx's own PaddingSteps
            and dialog.stories.tsx's own PadValues/GapValues precedent for a
            numeric step axis with no cva() block behind it) plus
            ContentAxisPadding / ListAxisPadding (padX and padY overriding a
            baseline pad) and ContentPerSideOverride / ListPerSideOverride
            (all four side props). InvoiceDetailPageRail additionally
            reproduces the exact real call site
            (InvoiceDetailPage.tsx:905, padX={4} padTop={2}) that is the
            documented reason padTop/padRight/padBottom/padLeft exist at all
            - see tabs.tsx's header comment and
            __tests__/tabs.test.tsx section 5.

   WHY `component` IS A STORY-ONLY WRAPPER, NOT ONE OF THE FOUR REAL EXPORTS.
   Every other full-coverage file in this pass (Card, Dialog, DropdownMenu)
   has one component that owns every axis being demonstrated, so `Meta<typeof
   X>` resolves argTypes straight off its real props. The Tabs cluster splits
   its axes across four different exports - `surface` is Tabs' own, `variant`
   means something different on TabsList than on TabsTrigger, `padX`/`padY`
   are TabsTrigger-only (a subset of the same pad axis TabsList/TabsContent
   also carry), and the fuller pad axis is shared by TabsList and
   TabsContent - so no single real export can host one flat Controls panel
   for all of it.
   `TabsClusterDemo` below is a plain function component, local to this file,
   that renders a complete three-tab tree and forwards one flat args object
   to the right sub-component each. It is not exported from tabs.tsx and
   changes nothing about what tabs.tsx ships; it exists only so the
   interactive `Default` story below can flip every real axis in the file at
   once, live, the same way button.stories.tsx casts `Button` (whose overloaded
   call signatures `Meta<>` cannot resolve props from directly) into a
   component-shaped type for the same reason.
   ============================================================================= */
import type { ComponentType } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import { PAD_STEPS, type PadStep } from '@/design-system/spacing'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  type TabsSurface,
  type TabsListVariant,
  type TabsTriggerVariant,
} from './tabs'
import { Inline } from './inline'
import { Stack } from './stack'
import { Text } from './text'

const SURFACES: TabsSurface[] = ['plain', 'card']
const LIST_VARIANTS: TabsListVariant[] = ['line', 'pill']
const TRIGGER_VARIANTS: TabsTriggerVariant[] = ['line', 'underline', 'underline-fill', 'pill']

/** A dashed box so a padding value has a visible edge to measure against. */
const PAD_BOX = 'rounded-card border border-dashed border-border bg-surface-light'

interface TabsClusterArgs {
  surface?: TabsSurface
  listVariant?: TabsListVariant
  triggerVariant?: TabsTriggerVariant
  /** TabsTrigger's own `padX` - kept a separate arg name from `listPad`/`contentPad` because one flat args object cannot hold three props named `pad*` for three different components. */
  triggerPadX?: PadStep
  /** TabsTrigger's own `padY`. */
  triggerPadY?: PadStep
  /** TabsList's own `pad` - kept a separate arg name from `contentPad` because one flat args object cannot hold two props named `pad`. */
  listPad?: PadStep
  /** TabsContent's own `pad`. */
  contentPad?: PadStep
}

function TabsClusterDemo({
  surface,
  listVariant,
  triggerVariant,
  triggerPadX,
  triggerPadY,
  listPad,
  contentPad,
}: TabsClusterArgs) {
  return (
    <Tabs defaultValue="overview" surface={surface} className="w-96">
      <TabsList variant={listVariant} pad={listPad}>
        <TabsTrigger value="overview" variant={triggerVariant} padX={triggerPadX} padY={triggerPadY}>
          Overview
        </TabsTrigger>
        <TabsTrigger value="details" variant={triggerVariant} padX={triggerPadX} padY={triggerPadY}>
          Details
        </TabsTrigger>
        <TabsTrigger value="history" variant={triggerVariant} padX={triggerPadX} padY={triggerPadY}>
          History
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" pad={contentPad}>
        <Text as="p" size="sm" tone="secondary">
          Overview panel content.
        </Text>
      </TabsContent>
      <TabsContent value="details" pad={contentPad}>
        <Text as="p" size="sm" tone="secondary">
          Details panel content.
        </Text>
      </TabsContent>
      <TabsContent value="history" pad={contentPad}>
        <Text as="p" size="sm" tone="secondary">
          History panel content.
        </Text>
      </TabsContent>
    </Tabs>
  )
}

const meta = {
  title: 'UI/Tabs',
  component: TabsClusterDemo as unknown as ComponentType<TabsClusterArgs>,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
  },
  args: {
    surface: 'plain',
    listVariant: 'line',
    triggerVariant: 'line',
  },
  argTypes: {
    surface: {
      control: { type: 'select' },
      options: SURFACES,
      description:
        'Tabs\' own axis: whether the whole widget sits in its own card, or plain in the page. Defaults to "plain".',
    },
    listVariant: {
      control: { type: 'select' },
      options: LIST_VARIANTS,
      description: 'TabsList\'s rail look. "line" is a bottom border; "pill" is a filled background strip.',
    },
    triggerVariant: {
      control: { type: 'select' },
      options: TRIGGER_VARIANTS,
      description:
        'TabsTrigger\'s own shape, independent of TabsList\'s. "underline-fill" wraps its children in an extra bar span - see UnderlineFillActiveTab.',
    },
    triggerPadX: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description:
        'TabsTrigger\'s horizontal padding (design-system/spacing.ts, not a bespoke `size` scale). No default - an untouched TabsTrigger emits no padding class at all. See TriggerPadding for the real measured pairs.',
    },
    triggerPadY: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description:
        'TabsTrigger\'s vertical padding (design-system/spacing.ts). No default - an untouched TabsTrigger emits no padding class at all. See TriggerPadding for the real measured pairs.',
    },
    listPad: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description:
        'TabsList\'s padding (design-system/spacing.ts, not declared in tabs.tsx). No default - an untouched TabsList emits no padding class at all.',
    },
    contentPad: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description:
        'TabsContent\'s padding (design-system/spacing.ts, not declared in tabs.tsx). No default - an untouched TabsContent emits no padding class at all.',
    },
  },
} satisfies Meta<ComponentType<TabsClusterArgs>>

export default meta

type Story = StoryObj<typeof meta>

/**
 * The interactive default - `surface="plain"`, `listVariant="line"`,
 * `triggerVariant="line"`, no padding on TabsTrigger, TabsList, or
 * TabsContent. Flip any control above the canvas and the whole three-tab
 * tree re-renders live. `triggerPadX`/`triggerPadY`/`listPad`/`contentPad`
 * start unset on purpose: that is the byte-identical propless render every
 * shipped TabsTrigger/TabsList/TabsContent call site depends on.
 */
export const Default: Story = {}

/**
 * Every `Tabs.surface` value. `plain` (the default) renders no extra class at
 * all; `card` wraps the whole widget in `rounded-card border border-border
 * bg-surface-light shadow-card`, the shape used where a tab widget needs to
 * read as its own panel rather than sitting directly on the page background.
 */
export const Surfaces: Story = {
  render: () => (
    <Inline gap={6} wrap align="start">
      {SURFACES.map((surface) => (
        <Stack key={surface} gap={2} align="start">
          <Text size="xs" tone="secondary">{`surface="${surface}"`}</Text>
          <Tabs defaultValue="overview" surface={surface} className="w-72">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="details">Details</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" pad={surface === 'card' ? 4 : undefined}>
              <Text as="p" size="sm" tone="secondary">
                Overview content.
              </Text>
            </TabsContent>
            <TabsContent value="details" pad={surface === 'card' ? 4 : undefined}>
              <Text as="p" size="sm" tone="secondary">
                Details content.
              </Text>
            </TabsContent>
          </Tabs>
        </Stack>
      ))}
    </Inline>
  ),
}

/**
 * Every `TabsList.variant` value, each hosting a real working tab set.
 * `line` (the default) is a thin bottom border under the whole rail; `pill`
 * is a filled background strip behind it.
 */
export const ListVariants: Story = {
  render: () => (
    <Inline gap={6} wrap align="start">
      {LIST_VARIANTS.map((variant) => (
        <Stack key={variant} gap={2} align="start">
          <Text size="xs" tone="secondary">{`variant="${variant}"`}</Text>
          <Tabs defaultValue="overview" className="w-72">
            <TabsList variant={variant}>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="details">Details</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <Text as="p" size="sm" tone="secondary">
                Overview content.
              </Text>
            </TabsContent>
            <TabsContent value="details">
              <Text as="p" size="sm" tone="secondary">
                Details content.
              </Text>
            </TabsContent>
          </Tabs>
        </Stack>
      ))}
    </Inline>
  ),
}

/**
 * Every `TabsTrigger.variant` value. `line` is the shadcn default (thin
 * bottom border, brightens to primary when active) - `underline` is the
 * detail-page rail (thicker underline, was duplicated near-verbatim across
 * 7+ files before this prop existed) - `underline-fill` is
 * CustomerDetailPage's rail, whose active indicator is a bar the width of
 * the label, rendered by a wrapper span, not a border on the trigger itself (see
 * UnderlineFillActiveTab) - `pill` is PriceBookPicker's segmented-control
 * look.
 */
export const TriggerVariants: Story = {
  render: () => (
    <Inline gap={6} wrap align="start">
      {TRIGGER_VARIANTS.map((variant) => (
        <Stack key={variant} gap={2} align="start">
          <Text size="xs" tone="secondary">{`variant="${variant}"`}</Text>
          <Tabs defaultValue="overview" className="w-72">
            <TabsList variant={variant === 'pill' ? 'pill' : 'line'}>
              <TabsTrigger value="overview" variant={variant}>
                Overview
              </TabsTrigger>
              <TabsTrigger value="details" variant={variant}>
                Details
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <Text as="p" size="sm" tone="secondary">
                Overview content.
              </Text>
            </TabsContent>
            <TabsContent value="details">
              <Text as="p" size="sm" tone="secondary">
                Details content.
              </Text>
            </TabsContent>
          </Tabs>
        </Stack>
      ))}
    </Inline>
  ),
}

/**
 * `variant="underline-fill"` wraps its children in a bar span that paints
 * the active indicator as an underline the width of the label rather than a
 * border on the trigger itself (see tabs.tsx's `UNDERLINE_FILL_BAR`). `defaultValue`
 * is deliberately the SECOND tab, not the first, so this proves the bar
 * follows whichever trigger is actually active rather than always
 * rendering under the first one - the exact behaviour
 * __tests__/tabs.test.tsx section 3 pins with a rendered-DOM assertion.
 */
export const UnderlineFillActiveTab: Story = {
  render: () => (
    <Tabs defaultValue="details" className="w-96">
      <TabsList>
        <TabsTrigger value="overview" variant="underline-fill">
          Overview
        </TabsTrigger>
        <TabsTrigger value="details" variant="underline-fill">
          Details
        </TabsTrigger>
        <TabsTrigger value="history" variant="underline-fill">
          History
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <Text as="p" size="sm" tone="secondary">
          Overview content.
        </Text>
      </TabsContent>
      <TabsContent value="details">
        <Text as="p" size="sm" tone="secondary">
          Details content - the active tab, so its bar is the one painted.
        </Text>
      </TabsContent>
      <TabsContent value="history">
        <Text as="p" size="sm" tone="secondary">
          History content.
        </Text>
      </TabsContent>
    </Tabs>
  ),
}

/**
 * Every measured `TabsTrigger` padX/padY pair, each paired with the real
 * variant its evidence ties it to (tabs.tsx's own header comment table,
 * mirrored by __tests__/tabs.test.tsx's `EVIDENCE_VARIANT` map): `padX={3}
 * padY={1.5}` + `pill` (PriceBookPicker), `padX={3} padY={2}` + `underline`
 * (PriceBookPage, VendorsPage), `padX={5} padY={3}` + `underline`
 * (JobDetailPage, LeadDetailPage). The unpadded case (no padX/padY at all)
 * is shown on `underline` too, alongside the others, to make the progression
 * visible - it emits no padding class of its own, which is the only state
 * that keeps every existing call site rendering exactly what it renders
 * today.
 */
export const TriggerPadding: Story = {
  render: () => (
    <Inline gap={6} wrap align="center">
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          padX={'{3}'} padY={'{1.5}'} (PriceBookPicker)
        </Text>
        <Tabs defaultValue="a">
          <TabsList variant="pill">
            <TabsTrigger value="a" variant="pill" padX={3} padY={1.5}>
              Materials
            </TabsTrigger>
            <TabsTrigger value="b" variant="pill" padX={3} padY={1.5}>
              Labor
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          padX={'{3}'} padY={'{2}'} (PriceBookPage, VendorsPage)
        </Text>
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a" variant="underline" padX={3} padY={2}>
              Services
            </TabsTrigger>
            <TabsTrigger value="b" variant="underline" padX={3} padY={2}>
              Products
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          unpadded (default, no padding class emitted)
        </Text>
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a" variant="underline">
              Overview
            </TabsTrigger>
            <TabsTrigger value="b" variant="underline">
              Details
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          padX={'{5}'} padY={'{3}'} (JobDetailPage, LeadDetailPage)
        </Text>
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a" variant="underline" padX={5} padY={3}>
              Overview
            </TabsTrigger>
            <TabsTrigger value="b" variant="underline" padX={5} padY={3}>
              Schedule
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
    </Inline>
  ),
}

/**
 * Every step on TabsContent's `pad` scale (design-system/spacing.ts,
 * PAD_STEPS - 13/13 values), matching card.stories.tsx's own `PaddingSteps`
 * and dialog.stories.tsx's `PadValues`/`GapValues` precedent for a numeric
 * step axis with no cva() block behind it. `p-6`/`p-5`/`p-4` are the real
 * measured shapes (CustomerDetailPage, JobDetailPage, InvoiceDetailPage
 * respectively - see tabs.tsx's header comment).
 */
export const ContentPaddingSteps: Story = {
  render: () => (
    <Inline gap={3} wrap align="start">
      {PAD_STEPS.map((step) => (
        <Tabs defaultValue="pane" key={step} className="w-40">
          <TabsList>
            <TabsTrigger value="pane" padX={3} padY={2}>{`pad={${step}}`}</TabsTrigger>
          </TabsList>
          <TabsContent value="pane" pad={step} className={PAD_BOX}>
            <Text size="xs" tone="secondary">{`${step * 4}px`}</Text>
          </TabsContent>
        </Tabs>
      ))}
    </Inline>
  ),
}

/**
 * `padX` and `padY` overriding a `pad={2}` baseline independently on
 * TabsContent, matching card.stories.tsx's `HorizontalPaddingOverride` /
 * `VerticalPaddingOverride` shape for the same axis.
 */
export const ContentAxisPadding: Story = {
  render: () => (
    <Inline gap={4} wrap align="start">
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          pad={'{2}'} padX={'{6}'} - wide, shallow
        </Text>
        <Tabs defaultValue="pane" className="w-56">
          <TabsList>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pane" pad={2} padX={6} className={PAD_BOX}>
            <Text size="xs" tone="secondary">
              pad=2, padX=6
            </Text>
          </TabsContent>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          pad={'{2}'} padY={'{6}'} - narrow, tall
        </Text>
        <Tabs defaultValue="pane" className="w-56">
          <TabsList>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pane" pad={2} padY={6} className={PAD_BOX}>
            <Text size="xs" tone="secondary">
              pad=2, padY=6
            </Text>
          </TabsContent>
        </Tabs>
      </Stack>
    </Inline>
  ),
}

/**
 * Every one of TabsContent's four per-side props
 * (padTop/padRight/padBottom/padLeft), each overriding a `pad={1}` baseline
 * on one side only. The InvoiceDetailPage:905 rail reconstruction below
 * shows the real, combined call site these compose into; this story shows
 * each side prop in isolation first.
 */
export const ContentPerSideOverride: Story = {
  render: () => (
    <Inline gap={4} wrap align="start">
      {(
        [
          ['padTop', 'top only'],
          ['padRight', 'right only'],
          ['padBottom', 'bottom only'],
          ['padLeft', 'left only'],
        ] as const
      ).map(([side, label]) => (
        <Stack key={side} gap={2} align="start">
          <Text size="xs" tone="secondary">{`${side}={4} (${label})`}</Text>
          <Tabs defaultValue="pane" className="w-40">
            <TabsList>
              <TabsTrigger value="pane" padX={3} padY={2}>
                Pane
              </TabsTrigger>
            </TabsList>
            {side === 'padTop' && (
              <TabsContent value="pane" pad={1} padTop={4} className={PAD_BOX}>
                <Text size="xs" tone="secondary">
                  4px on top only
                </Text>
              </TabsContent>
            )}
            {side === 'padRight' && (
              <TabsContent value="pane" pad={1} padRight={4} className={PAD_BOX}>
                <Text size="xs" tone="secondary">
                  4px on the right only
                </Text>
              </TabsContent>
            )}
            {side === 'padBottom' && (
              <TabsContent value="pane" pad={1} padBottom={4} className={PAD_BOX}>
                <Text size="xs" tone="secondary">
                  4px on the bottom only
                </Text>
              </TabsContent>
            )}
            {side === 'padLeft' && (
              <TabsContent value="pane" pad={1} padLeft={4} className={PAD_BOX}>
                <Text size="xs" tone="secondary">
                  4px on the left only
                </Text>
              </TabsContent>
            )}
          </Tabs>
        </Stack>
      ))}
    </Inline>
  ),
}

/**
 * Every step on TabsList's `pad` scale (13/13 values) - the real measured
 * shapes are `p-0` (7 call sites, the most common), `p-1`, `px-4` and `pt-2`
 * (see tabs.tsx's header comment).
 */
export const ListPaddingSteps: Story = {
  render: () => (
    <Inline gap={3} wrap align="start">
      {PAD_STEPS.map((step) => (
        <Tabs defaultValue="pane" key={step} className="w-40">
          <TabsList pad={step} className={PAD_BOX}>
            <TabsTrigger value="pane" padX={3} padY={2}>{`pad={${step}}`}</TabsTrigger>
          </TabsList>
          <TabsContent value="pane">
            <Text size="xs" tone="secondary">{`${step * 4}px`}</Text>
          </TabsContent>
        </Tabs>
      ))}
    </Inline>
  ),
}

/**
 * `padX` and `padY` overriding a `pad={1}` baseline independently on
 * TabsList - the same shape as `ContentAxisPadding`, for the rail rather
 * than the panel.
 */
export const ListAxisPadding: Story = {
  render: () => (
    <Inline gap={4} wrap align="start">
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          pad={'{1}'} padX={'{6}'}
        </Text>
        <Tabs defaultValue="pane" className="w-56">
          <TabsList pad={1} padX={6} className={PAD_BOX}>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pane">
            <Text size="xs" tone="secondary">
              pad=1, padX=6
            </Text>
          </TabsContent>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          pad={'{1}'} padY={'{6}'}
        </Text>
        <Tabs defaultValue="pane" className="w-56">
          <TabsList pad={1} padY={6} className={PAD_BOX}>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pane">
            <Text size="xs" tone="secondary">
              pad=1, padY=6
            </Text>
          </TabsContent>
        </Tabs>
      </Stack>
    </Inline>
  ),
}

/**
 * Every one of TabsList's four per-side props, the same shape as
 * `ContentPerSideOverride`, for the rail rather than the panel.
 */
export const ListPerSideOverride: Story = {
  render: () => (
    <Inline gap={4} wrap align="start">
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          padTop={'{4}'} (top only)
        </Text>
        <Tabs defaultValue="pane" className="w-40">
          <TabsList pad={1} padTop={4} className={PAD_BOX}>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          padRight={'{4}'} (right only)
        </Text>
        <Tabs defaultValue="pane" className="w-40">
          <TabsList pad={1} padRight={4} className={PAD_BOX}>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          padBottom={'{4}'} (bottom only)
        </Text>
        <Tabs defaultValue="pane" className="w-40">
          <TabsList pad={1} padBottom={4} className={PAD_BOX}>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
      <Stack gap={2} align="start">
        <Text size="xs" tone="secondary">
          padLeft={'{4}'} (left only)
        </Text>
        <Tabs defaultValue="pane" className="w-40">
          <TabsList pad={1} padLeft={4} className={PAD_BOX}>
            <TabsTrigger value="pane" padX={3} padY={2}>
              Pane
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Stack>
    </Inline>
  ),
}

/**
 * The exact real call site the padTop/padRight/padBottom/padLeft amendment
 * exists for - InvoiceDetailPage.tsx:905, written today as `px-4 pt-2`.
 * Expressed with the published pad/padX/padY vocabulary the nearest
 * reachable form is `padY={2}`, which also pads the BOTTOM by 8px - a
 * rendered change. `padX={4} padTop={2}` instead resolves (per
 * design-system/spacing.ts's branch 3 and __tests__/tabs.test.tsx section 5)
 * to `pt-2 pr-4 pl-4`: the same computed padding on all four sides as
 * `px-4 pt-2` - 8px top, 16px right, NOTHING at the bottom, 16px left -
 * with no vertical shorthand and no bottom padding utility anywhere in the
 * emitted class string. The dashed box below has no padding on its bottom
 * edge, visibly, which is the whole point of the amendment.
 */
export const InvoiceDetailPageRail: Story = {
  render: () => (
    <Tabs defaultValue="details" surface="card" className="w-96">
      <TabsList variant="line" padX={4} padTop={2} className="w-full justify-start">
        <TabsTrigger value="details" variant="underline">
          Details
        </TabsTrigger>
        <TabsTrigger value="line-items" variant="underline">
          Line items
        </TabsTrigger>
        <TabsTrigger value="payments" variant="underline">
          Payments
        </TabsTrigger>
      </TabsList>
      <TabsContent value="details" pad={4}>
        <Text as="p" size="sm" tone="secondary">
          padX={'{4}'} padTop={'{2}'} on the rail above - top, right and left padding, no bottom.
        </Text>
      </TabsContent>
      <TabsContent value="line-items" pad={4}>
        <Text as="p" size="sm" tone="secondary">
          Line items content.
        </Text>
      </TabsContent>
      <TabsContent value="payments" pad={4}>
        <Text as="p" size="sm" tone="secondary">
          Payments content.
        </Text>
      </TabsContent>
    </Tabs>
  ),
}

/**
 * A realistic composed example - the JobDetailPage/LeadDetailPage shape from
 * tabs.tsx's own header comment table: `variant="underline"`,
 * `padX={5} padY={3}` triggers (px-5 py-3, 15 real call sites), TabsContent
 * padded to `pad={5}` (JobDetailPage's own measured shape).
 */
export const ComposedExample: Story = {
  render: () => (
    <Tabs defaultValue="overview" surface="card" className="w-96">
      <TabsList variant="line">
        <TabsTrigger value="overview" variant="underline" padX={5} padY={3}>
          Overview
        </TabsTrigger>
        <TabsTrigger value="schedule" variant="underline" padX={5} padY={3}>
          Schedule
        </TabsTrigger>
        <TabsTrigger value="invoices" variant="underline" padX={5} padY={3}>
          Invoices
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" pad={5}>
        <Text as="p" size="sm" tone="secondary">
          Job #J00042 - HVAC repair, 214 Maple St.
        </Text>
      </TabsContent>
      <TabsContent value="schedule" pad={5}>
        <Text as="p" size="sm" tone="secondary">
          Scheduled for Thursday, 9:00 AM - 11:00 AM.
        </Text>
      </TabsContent>
      <TabsContent value="invoices" pad={5}>
        <Text as="p" size="sm" tone="secondary">
          Invoice I00081 - $420.00, due on completion.
        </Text>
      </TabsContent>
    </Tabs>
  ),
}
