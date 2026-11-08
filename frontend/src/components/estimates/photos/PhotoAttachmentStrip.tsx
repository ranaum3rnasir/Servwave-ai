/**
 * PhotoAttachmentStrip — R5f. Compact thumbnail-strip + upload trigger shared by
 * `LineItemPhotoStrip` and `ScopePhotoStrip`, small enough to sit inline in a single line-item
 * row / scope-of-work block (unlike `StageDetailDialog.tsx`'s full staging-attachments panel).
 *
 * Mirrors `StageDetailDialog.tsx`'s upload pattern — this app's only established upload UI —
 * scaled down: a hidden native file input triggered by a small styled button, a client-side
 * size pre-check BEFORE uploading (oversize files never POST), one `uploading`/`error` pair of
 * state (no per-file granularity, no progress bar), and a thumbnail grid of `<button>` tiles
 * (never links/anchors) that open the shared `AttachmentLightbox` on click, each with a
 * hover-reveal delete icon. Delete confirms via the app's own `ConfirmDialog` (`useConfirm`) -
 * attachment-delete convention (`AttachmentSection.tsx`/`AttachmentsPanel.tsx`), not a bespoke
 * two-step inline confirm.
 *
 * Deliberately parameterized by plain `onUpload`/`onDelete` async callbacks rather than owning
 * any API/react-query logic itself — `LineItemPhotoStrip`/`ScopePhotoStrip` supply those, wired to
 * their own endpoint + cache-invalidation. Keeps this component reusable without importing
 * anything estimate-endpoint-specific beyond the shared `EstimatePhoto` shape.
 */
import { useRef, useState } from 'react';
import { Camera, Loader2, Trash2, AlertTriangle } from 'lucide-react';
import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { extractApiError } from '@/lib/utils';
import { normaliseImageForUpload } from '@/lib/image-normalise';
import type { EstimatePhoto } from '@/lib/api/estimates';

/**
 * What the salesperson may PICK. Wider than what the backend accepts on purpose (#2029): the
 * phone has nothing but HEIC to offer, and `normaliseImageForUpload` converts every pick to a
 * document-sized JPEG before it is posted. The 8 MB cap and the format check both live in that
 * module now, so this component no longer keeps a second copy of either.
 */
const ACCEPTED_TYPES = 'image/jpeg,image/png,image/heic,image/heif';

export interface PhotoAttachmentStripProps {
  photos: EstimatePhoto[];
  /** Gates the upload trigger + per-thumbnail delete affordance. Read-only strip when false. */
  canManage: boolean;
  onUpload: (file: File) => Promise<unknown>;
  onDelete: (photoId: string) => Promise<unknown>;
  /** Used in the upload button's title/aria-label, e.g. "photo" or "scope photo". */
  itemLabel: string;
  /**
   * How many photos the whole document already holds, and the hard cap. #2029 — the cap is per
   * ESTIMATE, across every scope block, so a strip cannot answer it from its own `photos`. Both
   * come from the server (the upload response carries them), and the server enforces the cap
   * regardless of what this component does with them.
   */
  photoCount?: number;
  photoCap?: number;
  /** Where the warning starts. Well before the cap, so there is room to act. */
  photoWarnAt?: number;
}

export function PhotoAttachmentStrip({
  photos, canManage, onUpload, onDelete, itemLabel,
  photoCount, photoCap, photoWarnAt = 16,
}: PhotoAttachmentStripProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<EstimatePhoto | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0]!;
    setError(null);
    setUploading(true);
    try {
      // Convert and downscale BEFORE posting: what reaches storage is always a document-sized
      // JPEG, whatever the phone handed over. A file that cannot be read never leaves the device.
      const normalised = await normaliseImageForUpload(file);
      await onUpload(normalised.file);
    } catch (err) {
      setError(extractApiError(err, 'Upload failed'));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(photo: EstimatePhoto) {
    if (!(await confirm({
      title: `Remove this ${itemLabel}?`,
      description: 'This cannot be undone.',
      confirmLabel: 'Remove',
      tone: 'danger',
    }))) return;
    setError(null);
    try {
      await onDelete(photo.id);
      setLightboxPhoto((cur) => (cur?.id === photo.id ? null : cur));
    } catch (err) {
      setError(extractApiError(err, 'Delete failed'));
    }
  }

  if (photos.length === 0 && !canManage) return null;

  // The cap is a document-level fact, so it is only known when the caller supplies it.
  const atCap = photoCap != null && photoCount != null && photoCount >= photoCap;
  const nearCap = photoCap != null && photoCount != null && photoCount >= photoWarnAt;
  const canAdd = canManage && !atCap;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {photos.map((photo) => (
          <div key={photo.id} className="group relative">
            {/* variable-fill photo thumbnail tile (image, not text) - not Button-shaped, left raw. */}
            <button
              type="button"
              onClick={() => setLightboxPhoto(photo)}
              className="block h-11 w-11 overflow-hidden rounded-md border border-border bg-background-light"
              title={`View ${itemLabel}`}
            >
              <UploadedImage src={photo.url} alt={photo.caption ?? itemLabel} className="h-full w-full" />
            </button>
            {canManage && (
              // hover-reveal close-X affordance on a thumbnail overlay - not Button-shaped, left raw.
              <button
                type="button"
                onClick={() => void handleDelete(photo)}
                aria-label={`Remove ${itemLabel}`}
                title={`Remove ${itemLabel}`}
                className="absolute -right-1 -top-1 rounded-full bg-surface-light p-0.5 text-danger opacity-0 shadow ring-1 ring-danger/20 transition group-hover:opacity-100 hover:bg-danger/10"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}

        {canAdd && (
          // dashed "add new" CTA tile - no matching Button cell (dashed border, square
          // icon-only, hover recolours both border and icon) - left raw.
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            aria-label={`Add ${itemLabel}`}
            title={`Add ${itemLabel}`}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-dashed border-border text-text-secondary transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />}
          </button>
        )}
        <Input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          disabled={!canManage || uploading}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.currentTarget.value = '';
          }}
          className="hidden"
        />
      </div>

      {/* #2029 — the cap warning. It informs, it does not block: a salesperson mid-walkthrough
          finds out with room left rather than at the moment an upload is refused. Once the cap IS
          reached the add tile is gone above, and this says why. */}
      {nearCap && (
        <p role="status" className="text-[10px] text-warning-text">
          {atCap
            ? `${photoCount} of ${photoCap} photos — remove one to add another.`
            : `${photoCount} of ${photoCap} photos used.`}
        </p>
      )}

      {uploading && <p className="text-[10px] text-text-secondary">Uploading…</p>}

      {error && (
        <div className="flex items-start gap-1 text-[10px] text-warning">
          <AlertTriangle className="mt-0.5 h-2.5 w-2.5 flex-shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {/* `handleDelete` already confirms, and already clears `lightboxPhoto` when the deleted
          photo is the one on screen - so the overlay closes on success and stays open on
          failure (with the error rendered behind it), with no extra wiring here. */}
      <AttachmentLightbox
        url={lightboxPhoto?.url ?? null}
        caption={lightboxPhoto?.caption}
        uploadedBy={lightboxPhoto?.uploaded_by}
        uploadedAt={lightboxPhoto?.uploaded_at}
        onDelete={canManage && lightboxPhoto ? () => void handleDelete(lightboxPhoto) : undefined}
        onClose={() => setLightboxPhoto(null)}
      />
      {confirmDialog}
    </div>
  );
}
