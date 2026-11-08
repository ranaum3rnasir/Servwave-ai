import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { VideoPlayer } from '@/components/ui/VideoPlayer';

interface VideoPreviewDialogProps {
  url: string | null;
  /**
   * The stored container MIME type, when the caller has it. Additive, and it does NOT gate
   * playback (see `VideoPlayer`'s header on why a container type cannot): it only gives a
   * downloaded file the right extension.
   */
  mimeType?: string | null;
  /**
   * Optional attachment-aware download, handed to the unplayable-video fallback so it can save
   * the file under its real name. Omitted, the fallback downloads off the URL itself.
   */
  onDownload?: () => void;
  /**
   * Optional re-mint of an expired signed URL. Supplied, a link that timed out while the tab sat
   * open is rescued silently instead of being reported.
   */
  onRefreshUrl?: () => Promise<string | null>;
  onClose: () => void;
}

export function VideoPreviewDialog({
  url,
  mimeType,
  onDownload,
  onRefreshUrl,
  onClose,
}: VideoPreviewDialogProps) {
  useEffect(() => {
    if (!url) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [url, onClose]);

  if (!url) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-scrim/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Video preview"
    >
      <div className="relative max-h-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <VideoPlayer
          src={url}
          mimeType={mimeType}
          onDownload={onDownload}
          onRefreshUrl={onRefreshUrl}
          autoPlay
          className="max-h-[85vh] w-auto rounded-md shadow-2xl"
        />
        <button
          type="button"
          onClick={onClose}
          className="absolute -right-2 -top-2 rounded-full bg-surface-light p-1.5 text-text-secondary shadow-lg ring-1 ring-border hover:bg-background-light"
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>,
    document.body
  );
}
