/* =============================================================================
   Switch - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every real prop is a live control in the Storybook UI,
   matching checkbox.stories.tsx (Switch's own sibling in program-plan step
   8g: "Calendar, Separator, Checkbox, Switch, Badge - size where demand
   exists").

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in switch.tsx's cva() block needs at least
   one story that renders it.

     switch.tsx ships NO cva() block - it is a single fixed className string
     on `SwitchPrimitives.Root` (plus a second fixed string on `Thumb`), with
     no `variant` / `tone` / `size` / `gap` / `pad` axis, so this requirement
     has zero keys and zero values to satisfy. That is a deliberate,
     evidenced decision, not an oversight this pass should correct:

     - Switch does not appear in the program plan's measured-demand tables
       at all (section 1b's top-15-by-site-count list bottoms out at
       Avatar's 9 sites; section 1c's >=3-occurrence signature list has no
       Switch row either). Step 8g itself only hedges "size where demand
       exists" for the Calendar/Separator/Checkbox/Switch/Badge cluster - it
       does not mandate a prop where none is measured.
     - A grep of every real call site (32 sites across 19 files: LocationFormDialog.tsx,
       SendEstimateDialog.tsx, MarkSentDialog.tsx, PublishControl.tsx,
       TextingView.tsx (4), CallMaskingView.tsx (2), AddLineDialog.tsx (4),
       LineItemRow.tsx, JobFormPage.tsx,
       LeadFormPage.tsx (2), CustomerFormPage.tsx (2),
       CompanyProfilePage.tsx (2), SecurityPage.tsx, InventorySettingsPage.tsx,
       UsersTeamsPage.tsx (2), RolesPage.tsx (2), WorkflowsHome.tsx,
       InventoryPage.tsx, CustomerFormMockupPage.tsx (2)) turned up zero
       className overrides of Switch's own geometry or colour - every real
       site passes only `checked`, `onCheckedChange`, `disabled`, `id`, or
       `aria-label`. Matches checkbox.stories.tsx's own documented "no
       demand" finding for the same reason. (LeadDetailPage.tsx's own
       walkthrough-toggle Switch, previously cited here, was removed along
       with the rest of the walkthrough_needed feature in #1053 - re-grepped
       and dropped from this count rather than left stale.)

   What this file covers instead: every real prop Switch exposes today (all
   inherited from `@radix-ui/react-switch`'s `Root`, since switch.tsx adds
   none of its own) - `checked`, `defaultChecked`, `disabled`, `required`,
   `name`, `value`, and the `onCheckedChange` callback - plus the real
   call-site composition shape (a settings row: label text on the left,
   `Switch` on the right; see CompanyProfilePage.tsx:210-213,
   RolesPage.tsx:249, and TextingView.tsx:917 for three of the many sites
   that use it).
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Switch } from './switch';

const meta = {
  title: 'UI/Switch',
  component: Switch,
  tags: ['autodocs'],
  argTypes: {
    checked: { control: 'boolean' },
    defaultChecked: { control: 'boolean' },
    disabled: { control: 'boolean' },
    required: { control: 'boolean' },
    name: { control: 'text' },
    value: { control: 'text' },
    onCheckedChange: { action: 'onCheckedChange' },
    className: { control: false },
  },
} satisfies Meta<typeof Switch>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Off - the default state every call site starts from. */
export const Default: Story = {
  args: {
    checked: false,
    'aria-label': 'Default switch',
  },
};

/** `checked={true}` - the filled, thumb-slid-right state. */
export const Checked: Story = {
  args: {
    checked: true,
    'aria-label': 'Checked switch',
  },
};

/** `disabled` while off - matches RolesPage.tsx's per-permission rows for a locked-down role. */
export const Disabled: Story = {
  args: {
    checked: false,
    disabled: true,
    'aria-label': 'Disabled switch',
  },
};

/** `disabled` while on. */
export const DisabledChecked: Story = {
  args: {
    checked: true,
    disabled: true,
    'aria-label': 'Disabled checked switch',
  },
};

/**
 * Uncontrolled via `defaultChecked` rather than `checked` - exercises the
 * other half of Radix's controlled/uncontrolled prop pair. No real call site
 * currently uses it (every site controls the value), but it is part of the
 * shipped prop type and worth a designer seeing.
 */
export const DefaultChecked: Story = {
  args: {
    defaultChecked: true,
    'aria-label': 'Uncontrolled switch, starts on',
  },
};

/** `required` plus the form-participation props (`name`/`value`). */
export const Required: Story = {
  args: {
    checked: false,
    required: true,
    name: 'notifications',
    value: 'enabled',
    'aria-label': 'Required switch',
  },
};

/**
 * The real call-site shape - a settings row with descriptive text on the
 * left and the switch on the right (CompanyProfilePage.tsx:210-213,
 * TextingView.tsx:911-917, RolesPage.tsx:249, and most of the other 20-odd
 * sites all follow this pattern). Args stay wired through so the Controls
 * panel still drives it live.
 */
export const WithLabel: Story = {
  render: (args) => (
    <div className="flex items-center justify-between gap-6 w-80">
      <div>
        <span className="text-sm text-text-primary">Send emails to customers and staff</span>
        <p className="text-xs text-text-secondary">
          When turned off, no emails will be sent.
        </p>
      </div>
      <Switch {...args} />
    </div>
  ),
  args: {
    checked: true,
    'aria-label': 'Send emails to customers and staff',
  },
};

/**
 * The compact row shape used by simple toggle lists with no helper text
 * (RolesPage.tsx's `Row` helper, UsersTeamsPage.tsx).
 */
export const CompactRow: Story = {
  render: (args) => (
    <div className="flex items-center justify-between w-64">
      <span className="text-sm text-text-primary">Can create invoices</span>
      <Switch {...args} />
    </div>
  ),
  args: {
    checked: false,
  },
};

/** Every state side by side, for visual QA. */
export const States: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <Switch checked={false} aria-label="Off" />
        <span className="text-xs text-text-secondary">off</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Switch checked aria-label="On" />
        <span className="text-xs text-text-secondary">on</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Switch checked={false} disabled aria-label="Disabled off" />
        <span className="text-xs text-text-secondary">disabled off</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Switch checked disabled aria-label="Disabled on" />
        <span className="text-xs text-text-secondary">disabled on</span>
      </div>
    </div>
  ),
};
