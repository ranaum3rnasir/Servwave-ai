import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

import { Label } from '@/ui-kit/components/ui/label';

/**
 * Label above control, the three-part row every settings form repeats.
 *
 * The kit's own `FormField` needs a `FormProvider` plus a per-field
 * `Controller`; these forms register most fields directly (and several are not
 * RHF at all), so the row is assembled from the kit `Label` here instead - the
 * same call the leads and customers modules make.
 *
 * The kit `Label`, never a raw `<label>`: the design-system raw-tag ratchet
 * sits at its floor for `<label>`.
 *
 * The label is BOUND to its control (mobile slice 24, rubric KB-10): a screen
 * reader reads the label with the field, and tapping the label focuses it.
 * - The control as the first element child (`<Field label="City"><Input /></Field>`,
 *   optionally followed by its error line): bound automatically. The control
 *   keeps an `id` it already has, or gets a generated one; the caller passes
 *   nothing.
 * - Anything else (a phone number with its extension beside it, in a wrapper
 *   div): pass `htmlFor`, and the same `id` on the control the label names.
 */
export function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const generatedId = useId();
  // The control is the first element child; what follows it (an error line) is not.
  const nodes = Children.toArray(children);
  const at = htmlFor ? -1 : nodes.findIndex((n) => isValidElement(n));
  const first = at >= 0 ? (nodes[at] as ReactElement<{ id?: string }>) : null;
  const controlId = htmlFor ?? (first ? first.props.id ?? generatedId : undefined);
  const control =
    first && !first.props.id
      ? nodes.map((n, i) => (i === at ? cloneElement(first, { id: generatedId }) : n))
      : children;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={controlId} className="text-xs">
        {label}
        {required && (
          <span className="text-destructive ms-0.5" aria-hidden>
            *
          </span>
        )}
      </Label>
      {control}
    </div>
  );
}

/**
 * A setting row: copy on the left, control on the right. The legacy pages
 * hand-roll this shape five times over; here it is one component so the spacing
 * cannot drift between Company Profile, Security and Roles.
 *
 * Named `SettingRow`, not `ToggleRow`/`SwitchRow`: the design-system
 * duplicate-implementation guard treats an exported name containing Toggle or
 * Switch as a claim to BE that primitive and then requires an import from
 * `@/components/ui/switch`, a path a v2 file may not use. This row is a layout,
 * not a control - the caller passes the kit Switch in.
 */
export function SettingRow({
  title,
  hint,
  control,
}: {
  title: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <span className="text-sm">{title}</span>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {control}
    </div>
  );
}
