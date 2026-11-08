import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { Trash2, FileText, Film, Image as ImageIcon, Upload } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { ACCEPTED_UPLOAD_TYPES } from '@/lib/uploadTypes';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/use-toast';
import { AttachmentRowActions } from '@/components/attachments/AttachmentRowActions';
import {
  UploadRefusalList,
  UploadSelectionList,
} from '@/components/attachments/UploadSelectionList';
import { useUploadQueue } from '@/hooks/useUploadQueue';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import {
  downloadAttachment,
  makeAttachmentUrlRefresher,
} from '@/lib/attachments/downloadAttachment';

interface AttachmentsPanelProps {
  entityType: string;
  entityId: string;
}

interface Attachment {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  file_size: number;
  display_name: string;
  description: string;
  created_at: string;
  uploader: { id: string; first_name: string; last_name: string };
}

// This panel is the rail's attachment list. It is mounted on the INVOICE pages only — the lead
// and the job both pass `panels={['activity']}`, because each already owns a full attachment
// surface and a second list gave them two competing ones (#1834).
//
// It used to split its rows into four `context` accordions, each of which both listed a context
// and uploaded into it. That split was the defect generator: mounted on an entity, the panel
// offered every bucket indiscriminately, so which one a file landed in recorded nothing but
// which button the user happened to click. `context` is now retired — one flat list, one upload
// target, and every row on the entity is shown whatever it was historically stamped with.

const ACCEPTED_TYPES = ACCEPTED_UPLOAD_TYPES;

function FileIcon({ fileType }: { fileType: string }) {
  if (fileType.startsWith('image/')) return <ImageIcon className="h-4 w-4" />;
  if (fileType.startsWith('video/')) return <Film className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsPanel({ entityType, entityId }: AttachmentsPanelProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  // Mirrors `pendingPreview` so the URL can be released from places that must not read render
  // state: the settle callback, and unmount.
  const pendingPreviewRef = useRef<string | null>(null);

  /**
   * Release whatever preview URL is currently held (#33).
   *
   * Every object URL pins its Blob for the lifetime of the document, so a preview that is
   * never revoked leaks a whole image file. The original code got this right with a per-call
   * local and a `finally`; routing uploads through the queue moved it to a single ref, which
   * reintroduced two leaks the `finally` had covered - a second pick overwriting the ref
   * while the first upload is still in flight (the Upload control is not disabled during an
   * upload, so this is reachable), and an unmount before the transport resolves. Calling this
   * on BOTH of those paths as well as on settle restores the original guarantee: every URL
   * created is released exactly once, whatever happens to the upload.
   *
   * Deliberately does not touch React state, so it is safe to call during cleanup.
   */
  const releasePendingPreview = useCallback(() => {
    if (!pendingPreviewRef.current) return;
    URL.revokeObjectURL(pendingPreviewRef.current);
    pendingPreviewRef.current = null;
  }, []);

  useEffect(() => releasePendingPreview, [releasePendingPreview]);
  // The whole record, not just the URL (it used to be `videoUrl: string | null`): the video
  // overlay now needs the stored MIME type for its playability pre-check, and the record itself
  // to offer a correctly-named download when the browser cannot play the file.
  const [videoAttachment, setVideoAttachment] = useState<Attachment | null>(null);
  const [lightboxAttachment, setLightboxAttachment] = useState<Attachment | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const entityTypeLower = entityType.toLowerCase();

  // Fetch attachments
  const { data: attachments, isLoading } = useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: async () => {
      const { data } = await api.get(`/api/attachments/${entityTypeLower}/${entityId}`);
      return data.attachments as Attachment[];
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (attachmentId: string) => {
      await api.delete(`/api/attachments/${entityTypeLower}/${entityId}/${attachmentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
    },
  });

  /**
   * Shared by the row trash button and the lightbox's delete control, so both prompt with the
   * same wording. The lightbox variant additionally closes the overlay, but only after the
   * request resolves - closing on click would dismiss the viewer even when the delete failed.
   */
  const confirmDelete = async (attachment: Attachment, onDeleted?: () => void) => {
    if (!(await confirm(deleteAttachmentPrompt(attachment.display_name)))) return;
    deleteMutation.mutate(attachment.id, { onSuccess: onDeleted });
  };

  /**
   * S5: the picked file is rendered with its size (and clip length, when the browser offers
   * one) before its bytes go out, and progress comes from real reported bytes rather than an
   * open-ended spinner, for any transport that reports them. The file is forwarded
   * untouched — no re-encode on this path.
   */
  const uploads = useUploadQueue({
    upload: (file, onProgress, signal) =>
      uploadAttachment({
        entityType: entityTypeLower,
        entityId,
        file,
        onProgress,
        signal,
      }),
    describeError: (err) => extractApiError(err, 'Please try again.'),
    onSettled: (failures) => {
      queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
      // A rejected upload (wrong type, too large, no permission) has to say so: nothing else
      // renders the failure, and a silent catch reads to the user as "the file uploaded and
      // then vanished".
      for (const failure of failures) {
        toast({ title: 'Upload failed', description: failure.reason, variant: 'destructive' });
      }
      releasePendingPreview();
      setPendingPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
  });
  const uploading = uploads.isUploading;

  const handleUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0] as File;

    // Generate client-side preview for images (#33). Release the previous one first: a second
    // pick while the first upload is still running would otherwise strand it.
    releasePendingPreview();
    if (file.type.startsWith('image/')) {
      const previewUrl = URL.createObjectURL(file);
      pendingPreviewRef.current = previewUrl;
      setPendingPreview(previewUrl);
    } else {
      setPendingPreview(null);
    }

    uploads.enqueue([file]);
  };

  if (isLoading) {
    return (
      <div className="p-3 space-y-4">
        {[1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    );
  }

  const items = attachments ?? [];
  const totalCount = items.length;

  return (
    <div className="p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold">
          {totalCount} attachment{totalCount !== 1 ? 's' : ''}
        </p>
        {totalCount > 0 && (
          <Button type="button" size="3xs" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            Upload
          </Button>
        )}
      </div>

      <Input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={(e) => handleUpload(e.target.files)}
      />

      <div className="space-y-2">
        <UploadRefusalList messages={uploads.refusals} />
        {(totalCount > 0 || uploading) && (
          <div className="rounded-lg border border-border overflow-hidden">
            {/* The open-ended "Uploading..." spinner that used to sit here said nothing about
                what was being sent or how far along it was. The selection row carries the
                thumbnail (for an image), the name, the size, the clip length, the nudge and
                real byte progress instead. */}
            {uploads.items.length > 0 && (
              <div className="flex items-start gap-2 bg-primary/5 px-3 py-2">
                {pendingPreview && (
                  <UploadedImage
                    src={pendingPreview}
                    alt="Preview"
                    radius="sm"
                    edge="border"
                    className="h-10 w-10 shrink-0"
                  />
                )}
                <UploadSelectionList items={uploads.items} onCancel={uploads.cancel} className="min-w-0 flex-1" />
              </div>
            )}
            {items.map((att) => (
              <div
                key={att.id}
                className="group flex items-start gap-2 px-3 py-2 hover:bg-background-light/50 transition-colors border-b border-border/50 last:border-b-0"
              >
                {/* Thumbnail or icon */}
                <a
                  href={att.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                  onClick={(e) => {
                    if (att.file_type.startsWith('video/')) {
                      e.preventDefault();
                      setVideoAttachment(att);
                    } else if (att.file_type.startsWith('image/')) {
                      e.preventDefault();
                      setLightboxAttachment(att);
                    }
                  }}
                >
                  {att.file_type.startsWith('image/') ? (
                    <UploadedImage
                      src={att.file_url}
                      alt={att.display_name}
                      radius="sm"
                      edge="border"
                      className="h-10 w-10"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-10 w-10 rounded bg-background-light border border-border text-text-secondary">
                      <FileIcon fileType={att.file_type} />
                    </div>
                  )}
                </a>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <a
                    href={att.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-text-primary hover:text-primary truncate block"
                    onClick={(e) => {
                      if (att.file_type.startsWith('video/')) {
                        e.preventDefault();
                        setVideoAttachment(att);
                      } else if (att.file_type.startsWith('image/')) {
                        e.preventDefault();
                        setLightboxAttachment(att);
                      }
                    }}
                  >
                    {att.display_name}
                  </a>
                  {att.description && (
                    <p className="text-[10px] text-text-secondary truncate">{att.description}</p>
                  )}
                  <p className="text-[10px] text-text-secondary">
                    {att.uploader.first_name} {att.uploader.last_name} &middot;{' '}
                    {formatDistanceToNow(new Date(att.created_at), { addSuffix: true })} &middot;{' '}
                    {formatFileSize(att.file_size)}
                  </p>
                </div>

                {/* Row actions (#2047) — Download (always) + Rename (ability-gated). Rendered
                    immediately before Delete, always visible (never hover-gated) so it is
                    reachable at 375 and by keyboard, per the row menu's own visibility rule. */}
                <AttachmentRowActions
                  attachment={att}
                  entityType={entityTypeLower as 'lead' | 'job' | 'invoice' | 'customer'}
                  entityId={entityId}
                  onRenamed={() =>
                    queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] })
                  }
                />

                {/* Delete button - small row-action icon with a group-hover:opacity
                    reveal, not Button-shaped - left raw. */}
                <button
                  type="button"
                  aria-label="Delete attachment"
                  className="shrink-0 flex items-center justify-center h-6 w-6 rounded text-text-secondary hover:text-danger hover:bg-danger/10 opacity-0 group-hover:opacity-100 transition-all"
                  onClick={() => void confirmDelete(att)}
                  title="Delete attachment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Empty state (#25 — show a real upload button) */}
        {totalCount === 0 && !uploading && (
          <EmptyState density="compact"
            title="No attachments yet"
            description="Upload your first file to get started."
           
            action={
              <Button
                type="button"
                size="3xs"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload file
              </Button>
            }
          />
        )}
      </div>

      {/* The signed URL carries a 1h TTL, so an expired link is ordinary, not exceptional. The
          refresher lets the overlay re-mint it and just play the video, and hands `downloadAttachment`
          the same rescue the row menu already has. */}
      <VideoPreviewDialog
        url={videoAttachment?.file_url ?? null}
        mimeType={videoAttachment?.file_type}
        onDownload={
          videoAttachment
            ? () =>
                void downloadAttachment(videoAttachment, {
                  refresh: makeAttachmentUrlRefresher(entityTypeLower, entityId, videoAttachment.id),
                })
            : undefined
        }
        onRefreshUrl={
          videoAttachment
            ? makeAttachmentUrlRefresher(entityTypeLower, entityId, videoAttachment.id)
            : undefined
        }
        onClose={() => setVideoAttachment(null)}
      />
      <AttachmentLightbox
        url={lightboxAttachment?.file_url ?? null}
        caption={lightboxAttachment?.display_name}
        uploadedBy={
          lightboxAttachment
            ? `${lightboxAttachment.uploader.first_name} ${lightboxAttachment.uploader.last_name}`.trim()
            : undefined
        }
        uploadedAt={lightboxAttachment?.created_at}
        onDelete={
          lightboxAttachment
            ? () => void confirmDelete(lightboxAttachment, () => setLightboxAttachment(null))
            : undefined
        }
        onDownload={
          lightboxAttachment ? () => void downloadAttachment(lightboxAttachment) : undefined
        }
        deleting={deleteMutation.isPending}
        onClose={() => setLightboxAttachment(null)}
      />
      {confirmDialog}
    </div>
  );
}
