import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-19 w-full rounded-md border border-input bg-kit-card px-3 py-2.5 text-sm shadow-xs",
        // [field-sizing:content] as an arbitrary property: field-sizing-content
        // is a Tailwind v4 utility and emits nothing on v3, which is what makes
        // this textarea auto-grow.
        "text-foreground placeholder:text-subtle-foreground leading-relaxed [field-sizing:content]",
        "transition-[border-color,box-shadow] duration-150",
        "[&:hover:not(:focus)]:border-input-hover",   // a real jump, not a shade
        "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:text-subtle-foreground",
        "aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
