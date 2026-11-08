/**
 * AttachmentLightbox — this app's first REUSABLE full-screen photo/video viewer. Synthesizes two
 * existing precedents rather than copying either:
 *  - `VideoPreviewDialog.tsx` (this folder) — reusable, `createPortal(..., document.body)`, an
 *    `Escape`-key `useEffect` listener. Video-only.
 *  - `StageDetailDialog.tsx`'s inline `lightboxPhoto` overlay (bespoke, not extracted) — the
 *    image-display branch (full-size `<img>`, click-outside-to-close, an explicit close `X`
 *    button, a caption/uploader/date footer) that `VideoPreviewDialog` lacks.
 *
 * This feature (R5f, Estimate line-item + scope photos) is image-only, so the image-display path
 * was the first one implemented — but the component was named/shaped generally
 * (`AttachmentLightbox`, not `PhotoLightbox`) anticipating a future video caller. That caller
 * arrived with the overlay-consolidation pass on `StageDetailDialog.tsx`'s `lightboxPhoto`
 * (staging attachments can be `kind: 'video'`), which is why `kind` exists below — it renders a
 * `<VideoPlayer>` in place of the `<img>`, mirroring `VideoPreviewDialog`. Every other
 * existing caller only ever passes images, so `kind` defaults to `'image'` and is fully
 * backward-compatible.
 *
 * `url: string | null` (not a `photo` object) mirrors `VideoPreviewDialog`'s own prop shape: the
 * caller keeps this mounted unconditionally and simply passes `selectedPhoto?.url ?? null` —
 * `null` renders nothing, exactly like `VideoPreviewDialog`.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Download } from 'lucide-react';
import { VideoPlayer } from '@/components/ui/VideoPlayer';

export interface AttachmentLightboxProps {
  url: string | null;
  /** 'image' (default) renders `<img>`; 'video' renders `<VideoPlayer>`. */
  kind?: 'image' | 'video';
  /**
   * The stored container MIME type, used only by the `'video'` branch, and only to give a
   * downloaded file the right extension. It does NOT gate playback: a container type cannot
   * answer whether the codec inside it is decodable, and treating it as if it could hid working
   * `.mov` footage behind an error. See `VideoPlayer`'s header. Additive, ignored for images.
   */
  mimeType?: string | null;
  caption?: string | null;
  uploadedBy?: string | null;
  uploadedAt?: string | null;
  /**
   * Optional. When present, a delete control appears beside the close X. Callers that omit it
   * render exactly what they rendered before, so this is additive for every existing call site.
   *
   * The lightbox deliberately does NOT confirm, and does NOT close itself afterwards. Each caller
   * already owns a confirm with its own wording ("Remove this photo?" vs "Delete this
   * attachment?"), and only the caller knows whether the delete actually succeeded - a lightbox
   * that closed optimistically would hide a failed delete behind a dismissed overlay, and one that
   * confirmed here would double-prompt. So the handler does the whole job: confirm, delete, close.
   */
  onDelete?: () => void;
  /** Disables the delete control while a delete is in flight. */
  deleting?: boolean;
  /**
   * Optional (#2047, OQ5). When present, a Download control joins the corner cluster to the
   * LEFT of Delete, so the destructive control keeps its position and the X keeps the corner.
   * Additive exactly like `onDelete` — omitted, the overlay renders byte-identically to today.
   */
  onDownload?: () => void;
  onClose: () => void;
}

export function AttachmentLightbox({
  url,
  kind = 'image',
  mimeType,
  caption,
  uploadedBy,
  uploadedAt,
  onDelete,
  deleting,
  onDownload,
  onClose,
}: AttachmentLightboxProps) {
  useEffect(() => {
    if (!url) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [url, onClose]);

  if (!url) return null;

  const hasFooter = Boolean(caption || uploadedBy || uploadedAt);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-scrim/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={kind === 'video' ? 'Video preview' : 'Attachment preview'}
    >
      <div className="relative max-h-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        {kind === 'video' ? (
          /* `onDownload` does double duty: it is the corner-cluster Download below, and it is the
             download the unplayable-video fallback offers in place of the dead player. One
             handler, so the two controls can never disagree about how this file is saved. */
          <VideoPlayer
            src={url}
            mimeType={mimeType}
            onDownload={onDownload}
            autoPlay
            className="max-h-[85vh] w-auto rounded-md shadow-2xl"
          />
        ) : (
          <img src={url} alt={caption ?? 'Attachment'} className="max-h-[85vh] w-auto rounded-md shadow-2xl" />
        )}
        {/* Delete sits to the LEFT of the close X with a gap between them, never in the corner
            the X has always occupied - muscle memory for "dismiss this" must not land on a
            destructive control. The cluster keeps the X at its original -right-2/-top-2 spot.

            Both are raw <button>s. The X always was one, and these two read as a matched pair of
            corner pills; building one from the Button primitive and its twin from a raw element
            would be a worse inconsistency than the lint warning it clears. Same reasoning
            PhotoAttachmentStrip records for its own overlay affordances. */}
        <div className="absolute -right-2 -top-2 flex items-center gap-1.5">
          {onDownload && (
            <button
              type="button"
              onClick={onDownload}
              className="rounded-full bg-surface-light p-1.5 text-text-secondary shadow-lg ring-1 ring-border hover:bg-background-light"
              aria-label="Download attachment"
              title="Download attachment"
            >
              <Download className="h-4 w-4" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="rounded-full bg-surface-light p-1.5 text-danger shadow-lg ring-1 ring-danger/20 hover:bg-danger/10 disabled:opacity-50"
              aria-label="Delete attachment"
              title="Delete attachment"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-surface-light p-1.5 text-text-secondary shadow-lg ring-1 ring-border hover:bg-background-light"
            aria-label="Close preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {hasFooter && (
          <div className="mt-2 rounded-md bg-surface-light/95 px-3 py-2 text-xs text-text-secondary shadow">
            {caption && <p className="font-medium">{caption}</p>}
            {(uploadedBy || uploadedAt) && (
              <p className="text-[10px] text-text-secondary">
                {uploadedBy}
                {uploadedBy && uploadedAt ? ' · ' : ''}
                {uploadedAt ? new Date(uploadedAt).toLocaleString('en-US') : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
