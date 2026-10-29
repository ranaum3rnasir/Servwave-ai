import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { setsLargeTextSize } from "@/ui-kit/lib/textEntry";
import { fieldKindProps, type FieldKind } from "@/ui-kit/lib/fieldKind";
import { useNumberField } from "@/ui-kit/lib/useNumberField";

export interface InputProps extends React.ComponentProps<"input"> {
  /** Icon rendered inside the left edge - search fields, email, etc. */
  startIcon?: React.ReactNode;
  /** Icon or control rendered inside the right edge - clear, reveal, unit. */
  endIcon?: React.ReactNode;
  /**
   * What the field holds (email, search, postal code...). Sets the type,
   * keyboard, autofill, capitalisation, spell-check and action key; callers
   * never set those by hand. See src/ui-kit/lib/fieldKind.ts (mobile slice 23).
   */
  kind?: FieldKind;
  /** False where staff record a third party's details. See fieldKind.ts. */
  personalAutofill?: boolean;
  /**
   * Number kinds (money, quantity, percent, count) only: the parsed number on
   * every change, or null for nothing. See src/ui-kit/lib/useNumberField.ts.
   */
  onValueChange?: (value: number | null) => void;
}

/**
 * The bare control. Label, hint and error messaging live in <FormField>
 * (components/form) so this stays usable inside toolbars and table filters
 * where a label would be wrong.
 *
 * Invalid styling keys off aria-invalid, so it lights up automatically when a
 * form library marks the field - no extra prop to keep in sync.
 */
function Input({ className, type, startIcon, endIcon, kind, personalAutofill, ref, value, onChange, onBlur, min, max, step, onValueChange, ...props }: InputProps) {
  const kindProps = fieldKindProps(kind, { personalAutofill });
  // Number kinds: a text input that cleans, keeps a half-typed "12." and keeps
  // min / max / step as validity. Any other kind passes these through.
  const numberProps = useNumberField(kind, { value, onChange, onBlur, min, max, step, onValueChange }, ref);
  const control = (
    <input
      {...kindProps}
      type={type ?? kindProps.type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-md border border-input bg-kit-card px-3 text-sm shadow-xs",
        "text-foreground placeholder:text-subtle-foreground",
        "transition-[border-color,box-shadow] duration-150",
        "[&:hover:not(:focus)]:border-input-hover",   // a real jump, not a shade
        "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:text-subtle-foreground",
        "aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/25",
        "file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium",
        startIcon && "pl-9",
        endIcon && "pr-9",
        // 16 px on a phone or tablet (iOS zooms a focused field under 16 px); a
        // desktop keeps the classes above. See src/ui-kit/lib/textEntry.ts (mobile slice 14).
        !setsLargeTextSize(className) && "mobile:!text-base",
        className,
      )}
      {...props}
      {...numberProps}
    />
  );

  if (!startIcon && !endIcon) return control;

  return (
    <div data-slot="input-wrapper" className="relative flex w-full items-center">
      {startIcon ? (
        <span className="text-subtle-foreground pointer-events-none absolute left-3 flex items-center [&_svg]:size-4">
          {startIcon}
        </span>
      ) : null}
      {control}
      {endIcon ? (
        // A button in the slot (the password eye) gets a 32x32 hit area: it sits
        // 4 px in, so its 16 px icon lands where a plain icon at right-3 would.
        <span className="text-subtle-foreground absolute right-3 flex items-center has-[button]:right-1 [&_svg]:size-4">
          {endIcon}
        </span>
      ) : null}
    </div>
  );
}

export { Input };
