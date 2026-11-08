import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/ui-kit/lib/utils";

const avatarVariants = cva(
  "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-on-fill select-none",
  {
    variants: {
      size: {
        xs: "size-6.5 text-[10px]",
        sm: "size-7 text-[11px]",
        default: "size-8.5 text-xs",
        lg: "size-11.5 text-base",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * Muted, in-family tints. Bright generated colours next to solid status labels
 * turn a table into confetti, so these stay desaturated on purpose.
 */
const TINTS = [
  "rgb(var(--avatar-tint-1))", "rgb(var(--avatar-tint-2))", "rgb(var(--avatar-tint-3))",
  "rgb(var(--avatar-tint-4))", "rgb(var(--avatar-tint-5))", "rgb(var(--avatar-tint-6))",
] as const;

/** Same name always yields the same colour, across sessions and machines. */
function tintFor(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length];
}

function initialsFor(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export interface AvatarProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof avatarVariants> {
  /** Full name - drives the initials, the tint and the accessible label. */
  name: string;
  src?: string;
  /**
   * Draws the surface-coloured ring that separates overlapping avatars in an
   * AvatarGroup. A prop rather than a className at the call site: appearance
   * belongs to the component, and the layering guard counts every appearance
   * class a caller reaches past a shared component with.
   */
  ringed?: boolean;
}

function Avatar({ className, size, name, src, ringed, ...props }: AvatarProps) {
  const [failed, setFailed] = React.useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span
      data-slot="avatar"
      className={cn(avatarVariants({ size }), ringed && "ring-2 ring-kit-card", className)}
      style={showImage ? undefined : { backgroundColor: tintFor(name) }}
      role="img"
      aria-label={name}
      title={name}
      {...props}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initialsFor(name)
      )}
    </span>
  );
}

export interface AvatarGroupProps extends React.ComponentProps<"div"> {
  names: string[];
  /** Show at most this many, then a +N chip. */
  max?: number;
  size?: AvatarProps["size"];
}

/**
 * Overlapping stack for crews and assignees. The ring colour matches the
 * surface behind it, which is what creates the cut-out look.
 */
function AvatarGroup({
  className,
  names,
  max = 3,
  size = "xs",
  ...props
}: AvatarGroupProps) {
  const shown = names.slice(0, max);
  const overflow = names.length - shown.length;

  return (
    <div
      data-slot="avatar-group"
      className={cn("flex items-center -space-x-2", className)}
      {...props}
    >
      {shown.map((name) => (
        <Avatar key={name} name={name} size={size} ringed />
      ))}
      {overflow > 0 ? (
        <span
          className={cn(
            avatarVariants({ size }),
            "bg-muted text-muted-foreground ring-2 ring-kit-card",
          )}
          aria-label={`${overflow} more`}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

export { Avatar, AvatarGroup, avatarVariants, tintFor, initialsFor };
