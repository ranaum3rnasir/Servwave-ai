/* =============================================================================
   FormField - Storybook stories, phase 12 composition-layer pass.

   ZERO APPEARANCE TOKENS IN THIS FILE, BY CONSTRAINT NOT BY STYLE.
   `DIR_CEILINGS['components/patterns'] = 0` and component-api-guard's
   `targetFiles()` does not exempt `.stories.tsx`, so every label and seam
   below is a primitive with props (`Text tone`, `Stack gap`), never a
   className. See .storybook/main.ts's header for the full asymmetry note.

   WHAT THESE STORIES ARE ACTUALLY DOCUMENTING. FormField's real subject is
   not markup - it is `id` / `htmlFor` WIRING. Its own header states the
   defect it closes: 316 unwired labels in the a11y backlog, where a call
   site hand-types a matching `id` on the label and on the control as two
   separate literals that can drift. So the stories that matter most are the
   ones you cannot see: `GeneratedId` and `ExplicitId` below both render
   visually ordinary fields whose POINT is the attribute wiring, and each one
   says in its description what to inspect in the DOM.

   THE `children` PROP HAS TWO SHAPES AND BOTH ARE COVERED.
     a single React element  -> cloneElement injects id/aria-* (SingleControl)
     (fieldProps) => node    -> the caller places the id itself (RenderProp)
   The render-prop escape hatch exists because `cloneElement` silently does
   nothing useful when handed a fragment, an array, or plain text - which is
   exactly the shape of the compound fields (multiple Inputs under one label,
   a radio group) this component deliberately does not try to absorb.

   `error` BEATS `hint`, AND THAT IS A RENDERED FACT NOT A DOC CLAIM.
   `HintAndErrorTogether` passes both at once so the precedence is visible
   rather than asserted - showing stale help text beside a live validation
   error is confusing, so only the error renders.
   ============================================================================= */
import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { Input } from '@/components/ui/input';
import { Stack } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';

import { FormField } from './FormField';

const meta = {
  title: 'Patterns/FormField',
  component: FormField,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Pairs a `Label` with its control and owns BOTH ends of the `id`/`htmlFor` wiring - it generates the id (or accepts one) and hands it to the control itself, rather than printing it into a label and trusting the call site to match. That is the difference between this and the hand-rolled `FieldLabel` helpers it replaces: those solve only the label half, leaving two literals that can drift apart.',
      },
    },
  },
  argTypes: {
    label: { control: 'text', description: 'The field label. Rendered through the `Label` primitive.' },
    htmlFor: {
      control: 'text',
      description:
        'Use an explicit id - e.g. to match an existing `form.register` field name. Generated via `React.useId()` when omitted.',
    },
    required: { control: 'boolean', description: 'Appends a danger-toned asterisk to the label.' },
    optional: { control: 'boolean', description: 'Appends a secondary-toned "(optional)" suffix.' },
    hint: { control: 'text', description: 'Help text below the control. Suppressed entirely when `error` is set.' },
    error: { control: 'text', description: 'Validation message below the control. Wins over `hint`.' },
    gap: {
      control: { type: 'select' },
      options: [0, 0.5, 1, 1.5, 2, 3, 4],
      description:
        'Space between label, control and hint/error, in Stack steps. Defaults to 1.5 (6px), the measured `mt-1` seam.',
    },
    children: {
      control: false,
      description:
        'The control. A single element receives `id`/`aria-describedby`/`aria-invalid` via `cloneElement`; a function receives them as an argument and places them itself.',
    },
  },
} satisfies Meta<typeof FormField>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The default shape - a label and a single control, nothing else set. */
export const Default: Story = {
  args: {
    label: 'First name',
    children: <Input placeholder="Jane" />,
  },
};

/**
 * `required` appends a danger-toned asterisk. It renders through `Text`, not
 * a raw `<span className="text-danger">` - `components/patterns` carries an
 * appearance ceiling of 0, so a hand-rolled span here would be a real guard
 * violation rather than a style preference.
 */
export const Required: Story = {
  args: {
    label: 'Email',
    required: true,
    children: <Input type="email" placeholder="jane@example.com" />,
  },
};

/** `optional` appends a secondary-toned suffix. Mirrors the one measured flag on `CustomerFormPage`'s Last Name field. */
export const Optional: Story = {
  args: {
    label: 'Last name',
    optional: true,
    children: <Input placeholder="Whitfield" />,
  },
};

/** `hint` renders below the control, at `size="xs" tone="secondary"`, and is wired into `aria-describedby`. */
export const WithHint: Story = {
  args: {
    label: 'Purchase order number',
    hint: 'Shown on the invoice PDF the customer receives.',
    children: <Input placeholder="PO-4471" />,
  },
};

/** `error` renders at `tone="danger"` and also sets `aria-invalid` on the control. */
export const WithError: Story = {
  args: {
    label: 'Email',
    required: true,
    error: 'Enter a valid email address.',
    children: <Input type="email" defaultValue="jane@" />,
  },
};

/**
 * Both `hint` and `error` passed at once. Only the error renders - stale help
 * text beside a live validation error is confusing rather than additive.
 * Rendered rather than asserted so the precedence is visible.
 */
export const HintAndErrorTogether: Story = {
  args: {
    label: 'Email',
    hint: 'We only use this to send receipts.',
    error: 'That address is already on another customer.',
    children: <Input type="email" defaultValue="jane@example.com" />,
  },
};

/**
 * No `htmlFor`, so the id comes from `React.useId()`. Inspect the DOM: the
 * `<label for="...">` and the `<input id="...">` carry the same generated
 * value, with no literal typed at the call site to keep in sync.
 */
export const GeneratedId: Story = {
  args: {
    label: 'Generated id',
    hint: 'Inspect this field - label[for] and input[id] match a useId() value.',
    children: <Input placeholder="No htmlFor passed" />,
  },
};

/**
 * An explicit `htmlFor`, the shape a `react-hook-form` call site uses so the
 * id matches its registered field name. Inspect the DOM: both ends read
 * `first_name`, and the hint's id is derived from it (`first_name-hint`).
 */
export const ExplicitId: Story = {
  args: {
    label: 'First name',
    htmlFor: 'first_name',
    hint: 'Both ends read "first_name", and this hint is "first_name-hint".',
    children: <Input placeholder="Jane" />,
  },
};

/** Any single element works, not just `Input` - here a `Textarea`. */
export const WithTextarea: Story = {
  args: {
    label: 'Scope of work',
    hint: 'Appears on the estimate the customer approves.',
    children: <Textarea rows={4} placeholder="Replace condenser fan motor..." />,
  },
};

/**
 * The render-prop escape hatch. `cloneElement` cannot place an id inside a
 * fragment, an array, or a group of sibling controls - so `children` may be
 * a function receiving `{ id, 'aria-describedby', 'aria-invalid' }` and
 * deciding for itself which element the id belongs on. Here it goes on the
 * first of two inputs, which is the shape a compound phone/extension field
 * needs.
 */
export const RenderProp: Story = {
  args: {
    label: 'Phone and extension',
    hint: 'The id is placed on the first input by the render prop, not by cloneElement.',
    children: (fieldProps) => (
      <Stack direction="horizontal" gap={2} align="center">
        <Input {...fieldProps} placeholder="(555) 010-4471" />
        <Input placeholder="ext." />
      </Stack>
    ),
  },
};

/**
 * The `aria-describedby` MERGE, not overwrite. This control arrives with its
 * own `aria-describedby`, and FormField appends the hint id to it rather
 * than replacing it - which is what keeps adoption a wrapping move instead
 * of a silent strip of the caller's own wiring.
 */
export const PreservesCallerAria: Story = {
  args: {
    label: 'Serial number',
    hint: 'This hint id is appended to the caller\'s own aria-describedby.',
    children: <Input aria-describedby="external-help" placeholder="SN-00231" />,
  },
};

/**
 * `gap` in a realistic form column. The default is 1.5 (6px); a denser form
 * can drop to 1, a roomier one to 3, without either the label or the control
 * knowing about it.
 */
export const GapScale: Story = {
  args: { label: 'Gap', children: <Input /> },
  render: () => (
    <Stack gap={6}>
      {([1, 1.5, 3] as const).map((gap) => (
        <Stack key={gap} gap={1}>
          <Text size="xs" tone="secondary">
            gap={gap}
            {gap === 1.5 ? ' (default)' : ''}
          </Text>
          <FormField label="Job title" hint="Shown on the dispatch board." gap={gap}>
            <Input placeholder="Senior technician" />
          </FormField>
        </Stack>
      ))}
    </Stack>
  ),
};

/**
 * A realistic composition - the shape `CustomerFormPage` ships, where the
 * local `FieldLabel` helper used to sit. Every field's wiring is generated;
 * none of it is typed twice.
 */
export const FormExample: Story = {
  args: { label: 'Example', children: <Input /> },
  render: () => (
    <Stack gap={4} className="max-w-md">
      <FormField label="First name" required>
        <Input placeholder="Jane" />
      </FormField>
      <FormField label="Last name" optional>
        <Input placeholder="Whitfield" />
      </FormField>
      <FormField label="Email" required error="That address is already on another customer.">
        <Input type="email" defaultValue="jane@example.com" />
      </FormField>
      <FormField label="Notes" hint="Internal only - never shown to the customer.">
        <Textarea rows={3} placeholder="Gate code 4471, dog in yard." />
      </FormField>
    </Stack>
  ),
};
