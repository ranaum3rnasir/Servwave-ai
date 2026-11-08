/**
 * ProductThumb — the product photo tile for an invoice line.
 *
 * - With a photo: a square tile that contains the whole picture (blurred fill behind it,
 *   see `UploadedImage`); hovering reveals a zoom button, and clicking opens the shared
 *   `AttachmentLightbox` showing the full frame.
 * - Without a photo (custom lines, or catalog items with no image): a dashed placeholder
 *   with a type glyph (Package for materials, Wrench for services) and an optional caption.
 */
import { useRef, useState } from 'react';
import { Package, Wrench, Maximize2, Plus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
import { UploadedImage } from '@/components/ui/uploaded-image';

// #2045 — the backend allowlist verbatim (estimate-photos.controller.ts's exported
// ESTIMATE_PHOTO_MIMES / MAX_ESTIMATE_PHOTO_BYTES): both the narrow catalog-fill endpoint and the
// per-line photo route accept exactly these four, at up to 8MB.
const ADD_IMAGE_ACCEPT = 'image/jpeg,image/png,image/heic,image/heif';

export interface ProductThumbProps {
  /** Photo URL, or null/undefined for the placeholder. */
  src?: string | null;
  alt: string;
  itemType?: 'SERVICE' | 'MATERIAL';
  /** Caption under the placeholder glyph (e.g. "Custom"). Omit for icon-only. */
  placeholderLabel?: string;
  /**
   * Square tile size in px. Default 112. Pass `null` to emit NO inline width/height at all and
   * size the tile from `className` instead — what the line-items row does, so its tile can be
   * driven by a CSS variable (see LineItemRow) rather than a hard-coded number.
   */
  size?: number | null;
  className?: string;
  /**
   * #2045 — present only for an editable, image-less estimate line (LineItemRow's
   * `canEdit && !photo && !!line.estimate_id`). When set, the empty-thumb placeholder becomes a
   * real `<button type="button" aria-label="Add image">` covering the whole tile (≥44px at every
   * density this component renders) that opens a hidden file input; picking a file calls this
   * with it. Omitted (the default), the placeholder stays byte-equivalent to the plain inert
   * `<div>` it always was — every other caller (Job/Invoice grids, the AddLineDialog picker
   * preview) is untouched.
   */
  onAddImage?: (file: File) => void;
  /** True while the upload triggered by `onAddImage` is in flight — disables the button so a slow
   * upload can't be double-fired. */
  uploading?: boolean;
}

export function ProductThumb({
  src,
  alt,
  itemType = 'MATERIAL',
  placeholderLabel,
  size = 112,
  className,
  onAddImage,
  uploading = false,
}: ProductThumbProps) {
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // `undefined` (not `{}`) when size is null — React omits the style attribute entirely, so a
  // className-supplied h-/w- wins instead of losing to an inline rule.
  const dim = size == null ? undefined : { width: size, height: size };
  const Icon = itemType === 'SERVICE' ? Wrench : Package;

  if (!src) {
    if (!onAddImage) {
      return (
        <div
          style={dim}
          className={cn(
            'flex flex-none flex-col items-center justify-center gap-1.5 rounded-[13px]',
            'border border-dashed border-border bg-background-light/40',
            className,
          )}
        >
          <Icon className="h-7 w-7 text-text-secondary/35" />
          {placeholderLabel && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-secondary/40">
              {placeholderLabel}
            </span>
          )}
        </div>
      );
    }

    // The "+" tile — the whole placeholder IS the button (R11: at least the size of the row's
    // existing controls, ≥44px at 375; the dense 64px / card 112px tiles both clear that easily).
    return (
      <div style={dim} className={cn('relative flex-none', className)}>
        <button
          type="button"
          aria-label="Add image"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            'flex h-full w-full min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-1.5 rounded-[13px]',
            'border border-dashed border-border bg-background-light/40 transition-colors',
            'hover:border-primary hover:bg-primary-subtle',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
            uploading && 'opacity-60',
          )}
        >
          {uploading ? (
            <Loader2 className="h-6 w-6 animate-spin text-text-secondary/50" aria-hidden />
          ) : (
            <Plus className="h-6 w-6 text-text-secondary/60" aria-hidden />
          )}
          {placeholderLabel && !uploading && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-secondary/40">
              {placeholderLabel}
            </span>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ADD_IMAGE_ACCEPT}
          capture="environment"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onAddImage(file);
          }}
        />
      </div>
    );
  }

  return (
    <>
      {/* Left raw: a variable-dimension photo tile (size prop drives inline style) with
          its own overlay zoom affordance and an arbitrary rounded-[13px] radius - not
          Button-shaped. */}
      <button
        type="button"
        style={dim}
        onClick={() => setOpen(true)}
        aria-label={`View photo of ${alt}`}
        className={cn(
          'group relative flex-none cursor-zoom-in overflow-hidden rounded-[13px] border border-border',
          className,
        )}
      >
        <UploadedImage src={src} alt={alt} backdrop className="h-full w-full" />
        <span className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ocean-900/55 text-on-fill opacity-0 transition-opacity group-hover:opacity-100">
          <Maximize2 className="h-3.5 w-3.5" />
        </span>
      </button>

      <AttachmentLightbox url={open ? src ?? null : null} caption={alt} onClose={() => setOpen(false)} />
    </>
  );
}
