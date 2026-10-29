/* =============================================================================
   Checkbox - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every real prop is a live control in the Storybook UI,
   matching badge.stories.tsx (Checkbox's own sibling in program-plan step 8g:
   "Calendar, Separator, Checkbox, Switch, Badge - size where demand exists").

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in checkbox.tsx's cva() block needs at least
   one story that renders it.

     checkbox.tsx ships NO cva() block - it is a single fixed className
     string with no `variant` / `tone` / `size` / `gap` / `pad` axis, so this
     requirement has zero keys and zero values to satisfy. That is a
     deliberate, evidenced decision, not an oversight this pass should
     correct:

     - Checkbox does not appear in the program plan's measured-demand tables
       at all (section 1b's top-15-by-site-count list bottoms out at Avatar's
       9 sites; section 1c's >=3-occurrence signature list has no Checkbox
       row either).
     - A grep of every real call site (15 files: CheckboxFacet.tsx,
       StripeOnboardingDrawer.tsx, TaskFilterBar.tsx, RefundInvoiceDialog.tsx,
       CreateJobInvoiceDialog.tsx, CreditInvoiceDialog.tsx,
       SendEstimateDialog.tsx, MarkSentDialog.tsx, AssignTeamPopover.tsx,
       RecipientMultiSelect.tsx, LineItemsEditor.tsx, AcceptInvitePage.tsx,
       PublicEstimatePage.tsx, PhoneNumbersSettingsPage.tsx,
       CustomerFormPage.tsx) turned up zero className overrides of Checkbox's
       own geometry or colour - every site either passes no className at all
       or one purely for layout alignment (`className="mt-0.5"` in
       AcceptInvitePage.tsx, to align the box with adjacent multi-line text,
       not to resize or recolour the box itself).
     - Step 8g itself hedges "size where demand exists" rather than mandating
       it for all five listed primitives; for Checkbox specifically, no such
       demand exists, so no prop is invented. Matches box.tsx's own
       documented "no measured demand for an axis -> leave it without one"
       rule from this same session.

   What this file covers instead: every real prop Checkbox exposes today
   (all inherited from `@radix-ui/react-checkbox`'s `Root`, since
   checkbox.tsx adds none of its own) - `checked` (including Radix's third
   `"indeterminate"` state), `disabled`, `required`, `name`, `value`, and the
   `onCheckedChange` callback - plus the real call-site composition shape
   (a `<label>` wrapping the box and its text; see PublicEstimatePage.tsx
   line 688 and AcceptInvitePage.tsx line 169 for two of the twelve sites
   that use it).

   Note: `checked="indeterminate"` renders the same `Check` glyph as
   `checked={true}` - checkbox.tsx has never distinguished the two states
   visually. That is the file's existing, unchanged behaviour; this pass
   does not touch checkbox.tsx and does not alter it.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Checkbox } from './checkbox';
import { Label } from './label';

const meta = {
  title: 'UI/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  argTypes: {
    checked: {
      control: { type: 'radio' },
      options: [false, true, 'indeterminate'],
      description:
        'Radix\'s tri-state value. `"indeterminate"` renders the same glyph as `true` in this file today.',
    },
    disabled: { control: 'boolean' },
    required: { control: 'boolean' },
    name: { control: 'text' },
    value: { control: 'text' },
    onCheckedChange: { action: 'onCheckedChange' },
    className: { control: false },
  },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Unchecked - the default state every call site starts from. */
export const Default: Story = {
  args: {
    checked: false,
    'aria-label': 'Default checkbox',
  },
};

/** `checked={true}` - the filled, `Check`-glyph state. */
export const Checked: Story = {
  args: {
    checked: true,
    'aria-label': 'Checked checkbox',
  },
};

/**
 * `checked="indeterminate"` - Radix's third state, typically used for a
 * parent checkbox summarising a partially-selected set of children. No real
 * call site in this codebase currently passes it, but it is part of the
 * shipped prop type and worth a designer seeing: see the header note on why
 * it looks identical to `Checked` here.
 */
export const Indeterminate: Story = {
  args: {
    checked: 'indeterminate',
    'aria-label': 'Indeterminate checkbox',
  },
};

/** `disabled` on an unchecked box - matches AssignTeamPopover.tsx's "By SMS" row. */
export const Disabled: Story = {
  args: {
    checked: false,
    disabled: true,
    'aria-label': 'Disabled checkbox',
  },
};

/** `disabled` on a checked box. */
export const DisabledChecked: Story = {
  args: {
    checked: true,
    disabled: true,
    'aria-label': 'Disabled checked checkbox',
  },
};

/** `required` plus the form-participation props (`name`/`value`). */
export const Required: Story = {
  args: {
    checked: false,
    required: true,
    name: 'terms',
    value: 'agreed',
    'aria-label': 'Required checkbox',
  },
};

/**
 * The real call-site shape - a `<label>` wrapping the checkbox and its text
 * so a click anywhere in the row toggles it (PublicEstimatePage.tsx:688-691,
 * AcceptInvitePage.tsx:169-174, and ten other sites all follow this pattern).
 * Args stay wired through so the Controls panel still drives it live.
 */
export const WithLabel: Story = {
  render: (args) => (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <Checkbox {...args} />
      I agree to the terms and conditions
    </label>
  ),
  args: {
    checked: false,
  },
};

/**
 * Paired with `Label` via `htmlFor`/`id` - the other real composition shape
 * (AcceptInvitePage.tsx, CreateJobInvoiceDialog.tsx) for a checkbox with its
 * own dedicated label element instead of a wrapping `<label>`.
 */
export const WithFieldLabel: Story = {
  render: (args) => (
    <div className="flex items-center gap-2">
      <Checkbox id="story-taxable" {...args} />
      <Label htmlFor="story-taxable" tone="neutral">
        Taxable
      </Label>
    </div>
  ),
  args: {
    checked: true,
  },
};

/** Every state side by side, for visual QA. */
export const States: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked={false} aria-label="Unchecked" />
        <span className="text-xs text-text-secondary">unchecked</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked aria-label="Checked" />
        <span className="text-xs text-text-secondary">checked</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked="indeterminate" aria-label="Indeterminate" />
        <span className="text-xs text-text-secondary">indeterminate</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked={false} disabled aria-label="Disabled" />
        <span className="text-xs text-text-secondary">disabled</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Checkbox checked disabled aria-label="Disabled checked" />
        <span className="text-xs text-text-secondary">disabled checked</span>
      </div>
    </div>
  ),
};
