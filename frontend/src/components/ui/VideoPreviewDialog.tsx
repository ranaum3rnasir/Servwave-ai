import { useRef } from 'react';
import { X } from 'lucide-react';
import { VideoPlayer } from '@/components/ui/VideoPlayer';
import { LightboxFrame } from '@/components/ui/lightbox-frame';

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
  const closeRef = useRef<HTMLButtonElement>(null);

  if (!url) return null;

  // On the dialog primitive (mobile slice 16): focus moves in, Tab stays inside, Escape closes,
  // and focus returns to the control that opened it. See LightboxFrame.
  return (
    <LightboxFrame label="Video preview" onClose={onClose} initialFocus={closeRef}>
      <div className="relative max-h-full max-w-5xl">
        <VideoPlayer
          src={url}
          mimeType={mimeType}
          onDownload={onDownload}
          onRefreshUrl={onRefreshUrl}
          autoPlay
          className="max-h-[85vh] w-auto rounded-md shadow-2xl"
        />
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="absolute -right-2 -top-2 rounded-full bg-surface-light p-1.5 text-text-secondary shadow-lg ring-1 ring-border hover:bg-background-light"
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </LightboxFrame>
  );
}
