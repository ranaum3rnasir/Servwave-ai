import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Optional max-width for reading-heavy pages - settings, a single record, a
 * form. Data tables deliberately skip it: a 1400px screen showing nine columns
 * inside a 900px column is wasted room.
 */
function Container({ className, size = "default", ...props }: React.ComponentProps<"div"> & {
  size?: "sm" | "default" | "lg" | "full";
}) {
  const sizes = {
    sm: "max-w-2xl",
    default: "max-w-5xl",
    lg: "max-w-7xl",
    full: "max-w-none",
  };
  return (
    <div
      data-slot="container"
      className={cn("mx-auto w-full", sizes[size], className)}
      {...props}
    />
  );
}

function Section({ className, ...props }: React.ComponentProps<"section">) {
  return <section data-slot="section" className={cn("mb-6 last:mb-0", className)} {...props} />;
}

export { Container, Section };
