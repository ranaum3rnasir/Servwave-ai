/* =============================================================================
   DropdownMenu - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every real prop is a live control in the Storybook UI,
   matching badge.stories.tsx and checkbox.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in dropdown-menu.tsx's cva() block needs at
   least one story that renders it.

     dropdown-menu.tsx's colour/geometry-affecting props are a mix of one
     real cva() block, one Record<Key, string> lookup, and two hand-rolled
     axes:

       DropdownMenuContent.width: DropdownMenuContentWidth = "sm" | "md" | "lg"
         - the one real `cva` block in the file (`dropdownMenuContentVariants`).
           Named `width`, not `size` - dropdown-menu.tsx's own header note
           (program plan section 2a rule 3) reserves `size` for control
           height, so a max-width scale gets its own word, the same rule
           dialog.tsx / sheet.tsx apply to their own panel widths.
           `sm`/`WidthSm`, `md`/Default (every story that omits `width`), `lg`/
           `WidthLg`, plus a `WidthValues` story with all three side by side.
       DropdownMenuItem.readability: DropdownMenuItemReadability = "default" | "strong" | "subtle"
         - a `Record<DropdownMenuItemReadability, string>` lookup
           (`ITEM_READABILITY`), indexed by `ITEM_READABILITY[readability]` -
           the second shape the completeness guard walks (dialog.tsx's
           `width`/`pad`/`gap` are the same shape), not a cva `variants`
           entry. Non-colour: `default`/`strong`/`subtle` carry no colour of
           their own (program plan section 2a.2, rev 3's "tone = colour, no
           second word" rule is why this lives on its own prop rather than
           folded into `tone`, see dropdown-menu.tsx's own header notes on
           `DropdownMenuItemTone` / `DropdownMenuItemReadability`). Closed
           vocabulary only - VOCAB_V3 retires `muted` in favour of `subtle`,
           and `readability` is a prop minted fresh this session, so `muted`
           is not one of its selectable values. `muted` is still accepted,
           but only as a deprecated alias on the `tone` prop below, for its
           two live call sites (CommJobMenu.tsx, SmsInboxView.tsx) - see
           LegacyToneReadability.
       DropdownMenuItem.tone: DropdownMenuItemTone = "danger"
         - closed-vocabulary COLOUR only, the W2/8 rename schedule's
           (program plan section 2a.11) target for `variant="destructive"`,
           byte-identical to the class string that value used to produce
           inline. A plain string constant (`DANGER_CLASSES`), not a Record
           lookup - a single-member lookup has nothing left to branch on, so
           the completeness guard has nothing to require here; this file
           still covers it explicitly (Destructive) for the same reason
           `variant` gets a story below despite not being a guard-checked
           shape either. The old, pre-split `default`/`strong`/`subtle`/
           `muted` values are still accepted on `tone` too, but only as a
           @deprecated alias for `readability` (see dropdown-menu.tsx's own
           `DropdownMenuItemDeprecatedTone`) - LegacyToneReadability below
           covers that back-compat path explicitly.
       DropdownMenuItem.variant: "default" | "destructive"
         - a deprecated alias resolved in the component body to `tone`
           (`variant === "destructive"` -> `tone="danger"`, ignored whenever
           `tone` is passed explicitly), not cva and not a Record lookup
           either - the guard has nothing to check here, but this file still
           covers it (Default / Destructive / DeprecatedVariantDestructive)
           since a designer flipping controls needs to see the file's real,
           shipped surface regardless of which shape produced it.
       inset?: boolean
         - a shared modifier (adds "pl-8") on DropdownMenuItem,
           DropdownMenuSubTrigger and DropdownMenuLabel alike, not a variant
           axis with multiple named values.

     The completeness pass parses `dropdownMenuContentVariants` and requires
     every one of its values (`sm`/`md`/`lg`) to appear as a literal `width=`
     somewhere below - see WidthSm / WidthLg / WidthValues - and separately
     parses `ITEM_READABILITY` (indexed by `ITEM_READABILITY[readability]`)
     and requires every one of its values (`default`/`strong`/`subtle` -
     `muted` is not one of them, see `DropdownMenuItemReadability`'s own
     comment above) to appear as a literal `readability=` somewhere below -
     see Readability. `tone`, `variant` and `inset` are not cva and not a
     Record lookup, so the pass has nothing to require for them, but this
     file still covers every real prop VALUE, cva/Record or not:

       width: sm | md | lg                        -> WidthSm / (md is every
                                                       other story's default)
                                                       / WidthLg, plus
                                                       WidthValues with all
                                                       three
       variant: default | destructive             -> Default / Destructive
       tone: danger                                -> Destructive (the
                                                       compliant colour
                                                       value); the deprecated
                                                       legacy tone values
                                                       (default/strong/
                                                       subtle/muted) are
                                                       covered by
                                                       LegacyToneReadability
       readability: default | strong | subtle      -> Readability (all
                                                       three, explicit); the
                                                       deprecated `muted`
                                                       spelling only exists
                                                       on `tone` (see above)
                                                       and is covered there
       inset: false | true                        -> Inset (both, on Item,
                                                       Label AND SubTrigger -
                                                       the three places the
                                                       modifier exists)

     `variant` is a deprecated alias for `tone`, resolved BEFORE render (a
     plain `toneProp !== undefined ? toneProp === "danger" : variant ===
     "destructive"` check in the component body), not two independent props
     racing inside one `cn()` call the way they did before this rename - so
     `tone` always wins whenever both are passed, the same precedent
     ConfirmDialog and Toast's own `tone`/`variant` pairs use (see their own
     header notes). Covered explicitly by ToneWinsOverDeprecatedVariant.

   `width` defaults to "md", which dropdown-menu.tsx documents as emitting NO
   class - the primitive was already content-driven (`min-w-[8rem]`, no
   fixed width baked in), so every story above that omits `width` and instead
   passes its own `className="w-*"` (Default, Destructive, Readability, ...) is
   still exercising real `md` behaviour: the width prop contributes nothing,
   the demo width comes entirely from that className override, same as it
   did before this prop existed. WidthSm and WidthLg are the two stories that
   actually set `width` and drop the className override, so the width prop's
   own class is what's on screen.

   Every other exported piece of the file gets at least one rendering story:
   DropdownMenuCheckboxItem + the checked/unchecked/disabled states
   (CheckboxItems), DropdownMenuRadioGroup + DropdownMenuRadioItem
   (RadioGroupItems), DropdownMenuSub/SubTrigger/SubContent + Shortcut +
   Group (WithSubmenu), and a close reproduction of the real Header.tsx
   profile menu (ProfileMenuExample). DropdownMenuPortal is the one export
   with no dedicated story: DropdownMenuContent already wraps itself in one
   internally (see dropdown-menu.tsx), so it is exercised by every story
   here and has no visual form of its own to show separately.

   Every interactive story below sets `defaultOpen` on the relevant
   `DropdownMenu`/`DropdownMenuSub` so its `Content` is visible in the
   Storybook canvas without a click - the same uncontrolled-open pattern
   Radix documents, not a new mode this file introduces.
   ============================================================================= */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { Button } from './button';
import { Inline } from './inline';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu';
import type {
  DropdownMenuContentWidth,
  DropdownMenuItemReadability,
  DropdownMenuItemTone,
} from './dropdown-menu';

const VARIANTS = ['default', 'destructive'] as const;
// Compliant colour values only - `danger` is the sole closed-vocabulary
// member DropdownMenuItemTone has. The deprecated legacy readability
// spellings (default/strong/subtle/muted) still work on `tone` too (see
// LegacyToneReadability below) but are not listed as a selectable `tone`
// control option, the same way a deprecated alias never gets its own
// argTypes entry elsewhere in this tree.
const TONES: DropdownMenuItemTone[] = ['danger'];
// Closed vocabulary only - `muted` is retired (VOCAB_V3) and, since
// `readability` is a prop minted fresh this session rather than one
// carrying forward call sites, it is not a selectable value here at all,
// unlike `tone` above which does keep its deprecated legacy spellings
// live. `muted` is still reachable, but only through the deprecated `tone`
// prop - see LegacyToneReadability below.
const READABILITIES: DropdownMenuItemReadability[] = ['default', 'strong', 'subtle'];
const WIDTHS: DropdownMenuContentWidth[] = ['sm', 'md', 'lg'];

const WIDTH_DESCRIPTIONS: Record<DropdownMenuContentWidth, string> = {
  sm: 'w-48, 192px wide.',
  md: 'no width class - content-driven (min-w-[8rem] floor only), the default.',
  lg: 'w-56, 224px wide.',
};

const meta = {
  title: 'UI/DropdownMenu',
  component: DropdownMenuItem,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        'Deprecated - use `tone="danger"` instead. `destructive` is the delete / cancel / remove action - 20 call sites used to hand-roll `text-danger` before this prop existed, 14 of which still pass `variant="destructive"` on disk. Ignored when `tone` is also passed.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        'Colour, closed-vocabulary. `danger` is the delete / cancel / remove action, the current preferred entry point for what `variant="destructive"` used to do - supersedes `variant`. The old pre-split spellings (`default`/`strong`/`subtle`/`muted`) are still accepted here too, but only as a @deprecated alias for the `readability` prop below - see LegacyToneReadability.',
    },
    readability: {
      control: { type: 'select' },
      options: READABILITIES,
      description:
        'Non-colour readability - independent of `tone`. `default` inherits its idle colour from context; `strong` is always full-contrast, not just on focus; `subtle` is a disabled placeholder row (e.g. "No open jobs") - closed-vocabulary values only. `muted` is retired and is not one of this prop\'s values - it is only reachable as a deprecated alias on the `tone` prop above, for its two live call sites.',
    },
    inset: {
      control: 'boolean',
      description:
        'Left-pads the row (pl-8) to align with a sibling row that carries a leading CheckboxItem/RadioItem indicator. Also accepted by DropdownMenuSubTrigger and DropdownMenuLabel - see the Inset story.',
    },
    disabled: {
      control: 'boolean',
    },
    children: {
      control: 'text',
    },
    onClick: {
      action: 'onClick',
    },
    className: {
      table: { disable: true },
    },
  },
} satisfies Meta<typeof DropdownMenuItem>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The interactive default - `variant="default"`, `readability="default"`,
 * `inset={false}`. No `render` override on the highlighted row's props, so
 * flipping `variant` / `readability` / `inset` in the Controls panel
 * re-renders the real `<DropdownMenuItem>` live; the two sibling rows stay
 * fixed for contrast.
 */
export const Default: Story = {
  args: {
    variant: 'default',
    readability: 'default',
    inset: false,
    children: 'Edit',
  },
  render: (args) => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem {...args} />
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuItem>Archive</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * `tone="danger"` - the delete / cancel / remove action, the new preferred
 * entry point. Replaces the 20 call sites that used to hand-roll
 * `text-danger` on a plain DropdownMenuItem before this axis existed. See
 * DeprecatedVariantDestructive below for proof the old `variant="destructive"`
 * spelling - still on disk at 14 real call sites - renders identically.
 */
export const Destructive: Story = {
  args: {
    tone: 'danger',
    children: 'Delete',
  },
  render: (args) => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem {...args} />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * The deprecated `variant="destructive"` alias, with no `tone` passed -
 * byte-identical to `tone="danger"` above (dropdown-menu.tsx resolves
 * `variant` to the exact same `DANGER_CLASSES` string). The literal shape
 * all 14 real call sites still on disk use (Header.tsx's own sign-out row -
 * see ProfileMenuExample below - among them).
 */
export const DeprecatedVariantDestructive: Story = {
  args: {
    variant: 'destructive',
    children: 'Delete',
  },
  render: (args) => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem {...args} />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * Every `readability` value, side by side, plus `tone="danger"` on the last
 * row for comparison. `default` and `strong` paint identically at rest in a
 * static screenshot - `strong`'s real point is that it stays full-contrast
 * even off focus, which only shows up next to `default` inside a live menu
 * that also has focus/hover state; `subtle` (paired with `disabled`, its
 * real call-site shape) and `danger` are the two visibly different rows.
 * `muted` is retired and deliberately absent from this story - it is not a
 * `readability` value at all (see `DropdownMenuItemReadability`'s own
 * comment); its two live call sites still pass the deprecated
 * `tone="muted"` spelling instead, demonstrated in LegacyToneReadability
 * below, not here.
 */
export const Readability: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Assign to
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuItem readability="default">Default - inherits from context</DropdownMenuItem>
        <DropdownMenuItem readability="strong">Strong - always full-contrast</DropdownMenuItem>
        <DropdownMenuItem readability="subtle" disabled>
          Subtle - No open jobs
        </DropdownMenuItem>
        <DropdownMenuItem tone="danger">Danger - delete / cancel / remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * The deprecated legacy spelling of the readability axis - passing a
 * readability value straight to `tone` (this component's pre-split shape),
 * rather than the current `readability` prop. Kept legal for the real call
 * sites that still do this today: components/communication/inbox/
 * AiAssistMenu.tsx:168 and components/communication/InboxPage.tsx (x4) pass
 * `tone="strong"`; components/communication/shared/CommJobMenu.tsx:32 and
 * components/communication/phone/SmsInboxView.tsx:1091 pass `tone="muted"`.
 * `DropdownMenuItemDeprecatedTone` in dropdown-menu.tsx is the type this
 * exercises - the `strong` and `subtle` rows render byte-identical to their
 * `readability=` equivalent in the Readability story above; the `muted` row
 * has no `readability=` equivalent at all (that value is not one of
 * `readability`'s own, per `DropdownMenuItemReadability`'s comment) - it
 * folds to the same class string as `readability="subtle"` instead.
 */
export const LegacyToneReadability: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Legacy tone=
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
        <DropdownMenuItem tone="strong">
          Legacy tone=&quot;strong&quot; (= readability=&quot;strong&quot;)
        </DropdownMenuItem>
        <DropdownMenuItem tone="subtle" disabled>
          Legacy tone=&quot;subtle&quot; (= readability=&quot;subtle&quot;)
        </DropdownMenuItem>
        <DropdownMenuItem tone="muted" disabled>
          Legacy tone=&quot;muted&quot; (folds to readability=&quot;subtle&quot; - not its own value)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * `inset` - the shared modifier, shown on all three components that accept
 * it: DropdownMenuLabel, DropdownMenuItem and DropdownMenuSubTrigger. Each
 * inset row lines up with a sibling row that would carry a leading
 * CheckboxItem/RadioItem indicator; the flush rows below show the
 * difference.
 */
export const Inset: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel inset>Inset label</DropdownMenuLabel>
        <DropdownMenuItem inset>Inset item</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger inset>Inset submenu trigger</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Nested item</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Flush label</DropdownMenuLabel>
        <DropdownMenuItem>Flush item</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Flush submenu trigger</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Nested item</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * `width="sm"` - w-48/192px, DropdownMenuContent's narrower measured rung (3
 * real call sites: layout/Sidebar.tsx:128, communication/InboxPage.tsx:1239,
 * reports/ActivityFilterBar.tsx:140). No className width override alongside
 * it - the width prop alone is what's setting the width here.
 */
export const WidthSm: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          width=&quot;sm&quot;
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="sm">
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuItem>Archive</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * `width="lg"` - w-56/224px, DropdownMenuContent's wider measured rung (3
 * real call sites: EstimateWorkspacePage.tsx:502, communication/
 * InboxPage.tsx:1275, reports/ActivityFilterBar.tsx:61).
 */
export const WidthLg: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          width=&quot;lg&quot;
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="lg">
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuItem>Archive</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * Every `width` value, 3/3, one trigger per value so all three are reachable
 * in a single canvas without forcing them all open at once. `md` is the
 * default - no width class, content-driven (`min-w-[8rem]` floor only) -
 * the same geometry DropdownMenuContent rendered before this prop existed.
 */
export const WidthValues: Story = {
  render: () => (
    <Inline gap={4} wrap align="center">
      {WIDTHS.map((width) => (
        <DropdownMenu key={`width-${width}`}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">{`width="${width}"`}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent width={width}>
            <DropdownMenuLabel>{`width="${width}"`}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>{WIDTH_DESCRIPTIONS[width]}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </Inline>
  ),
};

/**
 * The deprecated `variant="destructive"` and the deprecated legacy
 * `tone="strong"` (its pre-split readability spelling) set together - an
 * unsupported but legal combination, kept legal rather than validated away
 * (matches badge.tsx's own `intent`/`tone` precedent). `variant` only
 * drives `isDanger` when `tone` is undefined (dropdown-menu.tsx's
 * `DropdownMenuItem`, a plain check, not two independent classes racing
 * inside one `cn()` call), so the explicit `tone="strong"` wins outright -
 * the row renders full-contrast, not red - the same "tone wins whenever
 * both are passed" precedent ConfirmDialog and Toast's own `tone`/`variant`
 * pairs use.
 */
export const ToneWinsOverDeprecatedVariant: Story = {
  args: {
    variant: 'destructive',
    tone: 'strong',
    children: 'variant=destructive, tone=strong -> renders strong, not danger',
  },
  render: (args) => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
        <DropdownMenuItem {...args} />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * The current `readability` prop set together with the deprecated legacy
 * `tone="subtle"` spelling - the explicit `readability` prop wins, the same
 * "the more specific/current prop wins" precedent
 * ToneWinsOverDeprecatedVariant demonstrates one level up (tone over
 * variant). Proves `readability` is not silently overridden by a stale
 * `tone` value left over on a call site mid-migration.
 */
export const ReadabilityWinsOverLegacyTone: Story = {
  args: {
    tone: 'subtle',
    readability: 'strong',
    children: 'tone=subtle, readability=strong -> renders strong, not subtle',
  },
  render: (args) => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
        <DropdownMenuItem {...args} />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * DropdownMenuCheckboxItem - two independently-controlled rows plus a
 * checked-and-disabled row (a setting locked on). The check glyph is
 * `ItemIndicator`-gated, so unchecked renders no icon at all, not a hollow
 * box.
 */
function CheckboxItemsDemo() {
  const [showStatusBar, setShowStatusBar] = useState(true);
  const [showActivityBar, setShowActivityBar] = useState(false);
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={showStatusBar} onCheckedChange={setShowStatusBar}>
          Status bar
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={showActivityBar} onCheckedChange={setShowActivityBar}>
          Activity bar
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked disabled>
          Panel (locked on)
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const CheckboxItems: Story = {
  render: () => <CheckboxItemsDemo />,
};

/**
 * DropdownMenuRadioGroup + DropdownMenuRadioItem - one selection out of
 * three, live-controlled with `useState` so clicking a different row in the
 * Storybook canvas actually moves the selected dot.
 */
function RadioGroupDemo() {
  const [position, setPosition] = useState('bottom');
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Panel position
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Panel position</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={position} onValueChange={setPosition}>
          <DropdownMenuRadioItem value="top">Top</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bottom">Bottom</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="right">Right</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const RadioGroupItems: Story = {
  render: () => <RadioGroupDemo />,
};

/**
 * DropdownMenuSub / DropdownMenuSubTrigger / DropdownMenuSubContent, plus
 * DropdownMenuShortcut and DropdownMenuGroup. The submenu is rendered
 * `defaultOpen` so its content is visible without a hover interaction.
 */
export const WithSubmenu: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          File
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem>
            New Tab
            <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            New Window
            <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub defaultOpen>
          <DropdownMenuSubTrigger>Share</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Email link</DropdownMenuItem>
            <DropdownMenuItem>Copy link</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * A close reproduction of the real Header.tsx profile menu (layout/Header.tsx
 * lines 226-286): a user-info label, a DropdownMenuGroup of plain items, and
 * a `variant="destructive"` sign-out row - the shape every account menu in
 * the app assembles from.
 */
export const ProfileMenuExample: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" tone="neutral">
          Jordan Rivera
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">Jordan Rivera</p>
          <p className="text-xs text-text-secondary">jordan@servwave.com</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>My Profile</DropdownMenuItem>
          <DropdownMenuItem>Settings</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Sign Out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
