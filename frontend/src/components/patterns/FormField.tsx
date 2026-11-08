import * as React from 'react';

import { Label } from '@/components/ui/label';
import { Stack, type StackGap } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';

/* =============================================================================
   FormField - phase 10. The label-plus-control half of the composition
   layer (program plan section "Phase 10 - Complete the composition layer":
   "FormField (label + control + hint + error) - collapses the Label/Input
   pairing, 190 + 236 sites").

   THE REAL DEFECT THIS CLOSES IS NOT MISSING MARKUP, IT IS MISSING `id`/
   `htmlFor` WIRING. The plan's own framing: "FormField is also the real fix
   for the 316 unwired labels in the a11y backlog: wiring htmlFor/id once in
   the pattern fixes most of them as a side effect, rather than 316 hand
   edits." Re-measured 2026-07-30 against `pages/CustomerFormPage.tsx`, which
   already independently invented half of this fix as a local `FieldLabel`
   helper (`required`/`optional` asterisk handling) - but `FieldLabel` only
   solves the LABEL half; every call site still has to type a matching `id`
   on its own control by hand (`<FieldLabel htmlFor="first_name">` next to
   `<Input id="first_name">`, two separate literals that can drift). For the
   wiring to actually retire itself as a side effect rather than staying a
   convention someone can forget, this component has to own BOTH ends: it
   generates the id (`React.useId()`, or accepts one explicitly) and hands it
   to the control itself, not just prints it into a label's `htmlFor`.

   WHY THE CONTROL IS `children`, NOT A DEDICATED `input`/`onChange` PROP
   SURFACE. Measured call sites pair a Label with an `Input`, a `Textarea`,
   or (unmeasured by this pass but structurally identical) a `Select` -
   forking the API by control type would either triple it or force every
   future control through this file. `children` matches how every real site
   already shapes the JSX (`<FieldLabel>...</FieldLabel><Input ... />` as two
   siblings today, an element and its neighbour), so adoption is a wrapping
   move, not a re-authoring of the control's own props
   (`{...form.register('first_name')}` etc. keep working untouched).

   HOW `id` REACHES THE CONTROL: `React.cloneElement` FOR THE COMMON CASE,
   A RENDER-PROP ESCAPE HATCH FOR THE REST. `cloneElement` only works on a
   single React element and silently does nothing useful if handed a
   fragment, an array, or plain text - which is exactly the shape of the
   compound fields this component is NOT trying to cover this pass
   (CustomerFormPage's own Phone/Email sections render multiple `<Input>`s
   under one `FieldLabel`, and its "Home or Business?" section is a
   `RadioRow` group, not a single control at all - none of those are
   converted by this validation pass; `FieldLabel` stays live for them,
   see the CustomerFormPage diff). For a caller with a compound control,
   `children` may instead be a function `(fieldProps) => ReactNode` that
   receives `{ id, 'aria-describedby', 'aria-invalid' }` and decides for
   itself which element the id belongs on - the id is data, not something
   `cloneElement` needs to guess a shape for.

   `hint` AND `error` RENDER THROUGH `Text`, NOT A RAW `<p>`. Same reasoning
   PageHeader's own description slot already established: `components/
   patterns` is ratcheted to a directory-wide appearance ceiling of 0, so a
   bare `<p className="text-xs text-danger">` authored here would be a
   real violation, not a style preference. `error` wins over `hint` when
   both are given - showing stale help text next to a live validation error
   is confusing, not additive.

   `required`/`optional` MIRROR `FieldLabel`'S OWN TWO FLAGS EXACTLY (measured
   demand: `CustomerFormPage.tsx` passes `optional` on Last Name, and no
   other flag). The asterisk/suffix render through `Text`, not a raw
   `<span className="text-danger">`, for the same directory-ceiling reason
   as `hint`/`error`.

   ZERO APPEARANCE TOKENS AUTHORED HERE, CHECKED AGAINST THE GUARD, NOT
   ASSUMED. Every element this file creates is a primitive invoked with
   props (`Stack gap`, `Label`, `Text as/size/tone`) - none of them carries a
   raw `className`, so `components/patterns`'s directory-wide appearance
   ceiling of 0 is inherited on the day this file is added, the same way
   `DetailPageShell.tsx` and `Toolbar.tsx` already do.
   ============================================================================= */

export interface FormFieldRenderProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export interface FormFieldProps {
  label: React.ReactNode;
  /** Use an explicit id (e.g. to match an existing `form.register` field name). Generated via `useId()` if omitted. */
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
  hint?: React.ReactNode;
  /** Wins over `hint` when both are given. */
  error?: React.ReactNode;
  /** Space between label, control, and hint/error. Defaults to 1.5 (6px), matching the measured `mt-1` seam. */
  gap?: StackGap;
  /**
   * The control - a single element (gets `id`/`aria-*` via `cloneElement`),
   * or a render prop for a compound control that needs to decide where the
   * id belongs itself.
   */
  children: React.ReactElement | ((fieldProps: FormFieldRenderProps) => React.ReactNode);
}

/**
 * `<FormField label="First Name"><Input placeholder="Jane" {...form.register('first_name')} /></FormField>`
 * renders the exact `<div><Label htmlFor="x">First Name</Label><Input id="x"
 * .../></div>` shape CustomerFormPage.tsx already hand-wires today, minus
 * the chance of the label and control ids drifting apart.
 */
const FormField = ({
  label,
  htmlFor,
  required,
  optional,
  hint,
  error,
  gap = 1.5,
  children,
}: FormFieldProps) => {
  const generatedId = React.useId();
  const id = htmlFor ?? generatedId;
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  // The control may already carry its own aria wiring, and this component's
  // contract is that adoption WRAPS a control rather than re-authoring it. So
  // read what the caller put there and build on it: `aria-describedby` is a
  // space-separated id LIST, so the hint/error ids are appended to the
  // caller's rather than replacing it, and `aria-invalid` falls back to the
  // caller's own value when this field has no error of its own.
  const childProps: Record<string, unknown> =
    typeof children === 'function' || !React.isValidElement(children)
      ? {}
      : (children.props as Record<string, unknown>);
  const childDescribedBy =
    typeof childProps['aria-describedby'] === 'string'
      ? (childProps['aria-describedby'] as string)
      : undefined;
  const childInvalid =
    typeof childProps['aria-invalid'] === 'boolean'
      ? (childProps['aria-invalid'] as boolean)
      : undefined;

  const describedBy = [childDescribedBy, hintId, errorId].filter(Boolean).join(' ') || undefined;
  const fieldProps: FormFieldRenderProps = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : childInvalid,
  };

  // `cloneElement` MERGES this object into the child's own props, and a key
  // whose value is `undefined` OVERWRITES rather than being skipped - it only
  // falls back to the element type's `defaultProps`, which modern function
  // components do not have. Handing it only the keys that carry a value is
  // what keeps adoption a wrapping move instead of a silent strip, and keeps
  // that true if another key is ever added to `fieldProps`.
  const clonedProps = Object.fromEntries(
    Object.entries(fieldProps).filter(([, value]) => value !== undefined)
  );

  return (
    <Stack gap={gap}>
      <Label htmlFor={id}>
        {label}
        {required && <Text as="span" tone="danger"> *</Text>}
        {optional && <Text as="span" tone="secondary"> (optional)</Text>}
      </Label>
      {typeof children === 'function' ? children(fieldProps) : React.cloneElement(children, clonedProps)}
      {error ? (
        <Text as="p" id={errorId} size="xs" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text as="p" id={hintId} size="xs" tone="secondary">
          {hint}
        </Text>
      ) : null}
    </Stack>
  );
};
FormField.displayName = 'FormField';

export { FormField };
