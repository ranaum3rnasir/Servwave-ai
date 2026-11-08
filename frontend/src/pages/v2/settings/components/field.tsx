import type { ReactNode } from 'react';

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
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
        {required && (
          <span className="text-destructive ms-0.5" aria-hidden>
            *
          </span>
        )}
      </Label>
      {children}
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
