import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

export interface InputProps extends React.ComponentProps<"input"> {
  /** Icon rendered inside the left edge - search fields, email, etc. */
  startIcon?: React.ReactNode;
  /** Icon or control rendered inside the right edge - clear, reveal, unit. */
  endIcon?: React.ReactNode;
}

/**
 * The bare control. Label, hint and error messaging live in <FormField>
 * (components/form) so this stays usable inside toolbars and table filters
 * where a label would be wrong.
 *
 * Invalid styling keys off aria-invalid, so it lights up automatically when a
 * form library marks the field - no extra prop to keep in sync.
 */
function Input({ className, type, startIcon, endIcon, ...props }: InputProps) {
  const control = (
    <input
      type={type}
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
        className,
      )}
      {...props}
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
        <span className="text-subtle-foreground absolute right-3 flex items-center [&_svg]:size-4">
          {endIcon}
        </span>
      ) : null}
    </div>
  );
}

export { Input };
