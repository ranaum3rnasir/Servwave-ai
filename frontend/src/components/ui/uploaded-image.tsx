import { cn } from "@/lib/utils";

/**
 * Renders a user-uploaded picture whole, never cropped.
 *
 * Uploads arrive at every aspect ratio (a square brand logo, a 4:3 phone photo,
 * a wide banner), so `object-cover` in a fixed frame silently slices off the
 * part the user cared about - a logo loses its wordmark, a product photo loses
 * the product. This contains the image inside the frame instead.
 *
 * `backdrop` fills the leftover space with a blurred, cover-scaled copy of the
 * same image so large frames (hero banners, the item preview tile) still read
 * as full-bleed rather than as letterboxed bars.
 *
 * APPEARANCE LIVES HERE, NOT AT THE CALL SITE (layering-guard). The 20-odd
 * sites this replaced each spelled their own `rounded-md ring-1 ring-border`
 * onto a raw image element, where the guard could not see them. Routing them
 * through a governed `components/ui` primitive makes those decisions visible,
 * so they move inside as the closed `radius` / `edge` vocabularies below.
 * `className` carries LAYOUT only - size, aspect ratio, flex behaviour.
 */

/** The four corner treatments the real call sites use. */
const RADIUS = {
  none: "",
  sm: "rounded",
  md: "rounded-md",
  lg: "rounded-lg",
} as const;

/** The two edge treatments the real call sites use. */
const EDGE = {
  none: "",
  ring: "ring-1 ring-border",
  border: "border border-border",
} as const;

export function UploadedImage({
  src,
  alt = "",
  backdrop = false,
  radius = "none",
  edge = "none",
  className,
  imgClassName,
  loading,
  style,
}: {
  src: string;
  alt?: string;
  backdrop?: boolean;
  radius?: keyof typeof RADIUS;
  edge?: keyof typeof EDGE;
  /** Layout only - size, aspect, flex. Appearance belongs to `radius`/`edge`. */
  className?: string;
  /** Extra classes for the visible image itself - hover transforms, mostly. */
  imgClassName?: string;
  loading?: "lazy" | "eager";
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        "relative block overflow-hidden bg-background-light",
        RADIUS[radius],
        EDGE[edge],
        className,
      )}
      style={style}
    >
      {backdrop && (
        <img
          src={src}
          alt=""
          aria-hidden="true"
          loading={loading}
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-lg"
        />
      )}
      <img
        src={src}
        alt={alt}
        loading={loading}
        className={cn("relative h-full w-full object-contain", imgClassName)}
      />
    </span>
  );
}
