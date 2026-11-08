import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { Upload, Trash2, FileText, Film, Image as ImageIcon, X, RotateCcw } from 'lucide-react';
import api from '@/lib/axios';
import { cn, extractApiError } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';
import { ACCEPTED_UPLOAD_TYPES, oversizeRefusalMessage } from '@/lib/uploadTypes';
import { AttachmentRowActions } from '@/components/attachments/AttachmentRowActions';
import {
  UploadNudge,
  UploadProgress,
  UploadRefusalList,
} from '@/components/attachments/UploadSelectionList';
import { describeSelection, probeVideoDuration } from '@/lib/attachments/uploadGuidance';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import { useAttachmentChangePermission } from '@/lib/attachments/useAttachmentChangePermission';
import {
  downloadAttachment,
  makeAttachmentUrlRefresher,
} from '@/lib/attachments/downloadAttachment';

interface AttachmentSectionProps {
  entityType: string;
  entityId: string;
  /** Called with the number of files once the list has LOADED - never a placeholder zero. */
  onCountChange?: (count: number) => void;
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

interface PendingUpload {
  id: string;
  file: File;
  displayName: string;
  description: string;
  /** Real bytes reported by the transport. S2 feeds the same two numbers. */
  loaded: number;
  total?: number;
  /** null until the browser volunteers one, and for anything it cannot measure. */
  durationSeconds: number | null;
  status: 'editing' | 'uploading' | 'done' | 'error';
  errorMessage?: string;
}

const ACCEPTED_TYPES = ACCEPTED_UPLOAD_TYPES;

function FileIcon({ fileType }: { fileType: string }) {
  if (fileType.startsWith('image/')) return <ImageIcon className="h-5 w-5" />;
  if (fileType.startsWith('video/')) return <Film className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
}

let uploadCounter = 0;

export function AttachmentSection({
  entityType,
  entityId,
  onCountChange,
}: AttachmentSectionProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  /** Picks refused before sending, as sentences to show. Replaced on each pick. */
  const [skipped, setSkipped] = useState<string[]>([]);
  // The whole record, not just the URL: the video overlay needs the stored MIME type for its
  // playability pre-check and the record itself to offer a correctly-named download when the
  // browser cannot play the file.
  const [videoAttachment, setVideoAttachment] = useState<Attachment | null>(null);
  /**
   * One abort controller per row that is uploading, so the row's Cancel can reach the
   * transfer. This surface runs its own pending model rather than `useUploadQueue`, so the
   * bookkeeping the queue does for the other three has to exist here too — otherwise Cancel
   * would be present on three surfaces out of four, which is worse than absent everywhere.
   */
  const uploadControllers = useRef(new Map<string, AbortController>());
  const { confirm, confirmDialog } = useConfirm();

  const entityTypeLower = entityType.toLowerCase();
  const mayChange = useAttachmentChangePermission(entityType);

  // Every attachment on the entity. This surface is the entity's single list — there is no
  // sub-bucket to filter to, and never was one a user could act on.
  const { data: loaded, isLoading } = useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: async () => {
      const { data } = await api.get(`/api/attachments/${entityTypeLower}/${entityId}`);
      return data.attachments as Attachment[];
    },
  });

  const attachments = loaded ?? [];

  // Report the count only once the list has actually loaded: while it is loading (or after a
  // failed read) the empty placeholder above is not a count, and a task card fed that zero
  // would lose its real one.
  const loadedCount = loaded?.length;
  useEffect(() => {
    if (loadedCount !== undefined) onCountChange?.(loadedCount);
  }, [loadedCount, onCountChange]);

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
   * Handle file selection.
   *
   * The cap is still enforced here, and still mirrors the server exactly — what changed is
   * that it now SAYS SO. The previous code dropped an oversized pick with a bare `continue`
   * and no message, so the file simply vanished and there was no way to tell "refused" from
   * "never read", which reads as data loss. `oversizeRefusalMessage` is the same wording
   * StageDetailDialog already uses for the same situation.
   *
   * Keeping the refusal (rather than posting and letting the API answer) is deliberate: the
   * server will certainly reject it, so sending it anyway costs a technician minutes of a
   * phone connection to earn an error. It also keeps the nudge honest — "You can upload it
   * as is." must never appear on a file that is about to be refused.
   *
   * Everything under the cap gets the S5 treatment instead: a row with its size, its clip
   * length and a nudge when the clip is long or large. Suggest, never obstruct.
   */
  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    setSkipped(
      list.map((file) => oversizeRefusalMessage(file)).filter((m): m is string => m !== null)
    );

    const newPending: PendingUpload[] = list
      .filter((file) => oversizeRefusalMessage(file) === null)
      .map((file) => ({
        id: `pending-${++uploadCounter}`,
        file,
        displayName: file.name.replace(/\.[^/.]+$/, ''),
        description: '',
        loaded: 0,
        total: undefined,
        durationSeconds: null,
        status: 'editing' as const,
      }));
    setPendingUploads((prev) => [...prev, ...newPending]);

    // Duration is a nicety patched in when the browser offers one; the row is already on
    // screen with its size and never waits on this. Nothing here gates the upload, so a probe
    // that fails costs only the clip length - but it is still caught, because an escaping
    // rejection is an unhandled one.
    for (const pending of newPending) {
      void probeVideoDuration(pending.file)
        .then((duration) => {
          if (duration === null) return;
          setPendingUploads((prev) =>
            prev.map((p) => (p.id === pending.id ? { ...p, durationSeconds: duration } : p))
          );
        })
        .catch(() => {
          /* no duration to show; the row keeps its size and stays uploadable */
        });
    }
  }, []);

  // Upload a single pending file
  const uploadFile = useCallback(
    async (pending: PendingUpload) => {
      setPendingUploads((prev) =>
        prev.map((p) =>
          p.id === pending.id ? { ...p, status: 'uploading', loaded: 0, total: undefined } : p
        )
      );

      const controller = new AbortController();
      uploadControllers.current.set(pending.id, controller);

      try {
        await uploadAttachment({
          entityType: entityTypeLower,
          entityId,
          file: pending.file,
          displayName: pending.displayName.trim(),
          description: pending.description.trim(),
          // Raw bytes, not a pre-rounded percentage: a missing `total` used to collapse to a
          // hard 0%, which reads as a stalled upload. The renderer decides what to say when
          // the total is unknown. S2 feeds these same two numbers, now for video too.
          onProgress: (loaded, total) => {
            setPendingUploads((prev) =>
              prev.map((p) => (p.id === pending.id ? { ...p, loaded, total } : p))
            );
          },
          signal: controller.signal,
        });

        // Remove from pending on success
        setPendingUploads((prev) => prev.filter((p) => p.id !== pending.id));
        queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
      } catch (err) {
        // A cancel is not a failure and must not leave an error row with a Retry beside it:
        // the user already decided. The row simply goes, exactly as a successful one does.
        if (controller.signal.aborted) {
          setPendingUploads((prev) => prev.filter((p) => p.id !== pending.id));
          return;
        }
        const message = extractApiError(err, 'Upload failed');
        setPendingUploads((prev) =>
          prev.map((p) =>
            p.id === pending.id ? { ...p, status: 'error', errorMessage: message } : p
          )
        );
      } finally {
        uploadControllers.current.delete(pending.id);
      }
    },
    [entityId, entityType, entityTypeLower, queryClient]
  );

  /** Stop one in-flight row. The transport terminates the partial upload; nothing is stored. */
  const cancelUpload = useCallback((pendingId: string) => {
    uploadControllers.current.get(pendingId)?.abort();
  }, []);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        ref={dropRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'rounded-lg border-2 border-dashed p-6 text-center transition-colors cursor-pointer',
          isDragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-background-light/50'
        )}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-6 w-6 text-text-secondary mx-auto mb-2" />
        <p className="text-sm text-text-secondary">
          Drag & drop files here, or <span className="text-primary font-medium">Browse</span>
        </p>
        {/* No format/size subtitle (Ran, 2026-09-20). It listed formats and caps that are
            neither complete nor stable — the accepted list is longer than the four it named
            and the video cap has moved twice — so it read as a rule while being wrong, and
            it charged every user for a constraint almost none of them meet. A file that does
            not fit is refused with a sentence naming its real size, the real limit and a next
            step (`oversizeRefusalMessage`), which is the honest place to spend that attention.
            `upload-dropzone-no-size-hint.test.tsx` is the guard. */}
        <Input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <UploadRefusalList messages={skipped} />

      {/* Pending uploads */}
      {pendingUploads.map((pending) => (
        <div
          key={pending.id}
          data-testid="upload-selection"
          className={cn(
            'rounded-lg border p-3 space-y-2',
            pending.status === 'error' ? 'border-danger bg-danger/5' : 'border-border'
          )}
        >
          <div className="flex items-center gap-2">
            <FileIcon fileType={pending.file.type} />
            <span className="text-xs text-text-secondary truncate flex-1">
              {pending.file.name}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-text-secondary">
              {describeSelection(pending.file, pending.durationSeconds)}
            </span>
            {/* Small close-X affordance, not Button-shaped - left raw. */}
            <button
              type="button"
              aria-label="Remove pending upload"
              className="text-text-secondary hover:text-danger"
              onClick={() =>
                setPendingUploads((prev) => prev.filter((p) => p.id !== pending.id))
              }
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Non-blocking: a sentence above a form whose Upload button it does not touch. */}
          <UploadNudge file={pending.file} durationSeconds={pending.durationSeconds} />

          {pending.status === 'editing' && (
            <>
              <Input
                placeholder="Display name *"
                value={pending.displayName}
                onChange={(e) =>
                  setPendingUploads((prev) =>
                    prev.map((p) =>
                      p.id === pending.id ? { ...p, displayName: e.target.value } : p
                    )
                  )
                }
                size="xs"
              />
              <Input
                placeholder={pending.file.type.startsWith('image/') ? 'Description (optional)' : 'Description *'}
                value={pending.description}
                onChange={(e) =>
                  setPendingUploads((prev) =>
                    prev.map((p) =>
                      p.id === pending.id ? { ...p, description: e.target.value } : p
                    )
                  )
                }
                size="xs"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={
                  !pending.displayName.trim() ||
                  (!pending.file.type.startsWith('image/') && !pending.description.trim())
                }
                onClick={() => uploadFile(pending)}
              >
                Upload
              </Button>
            </>
          )}

          {pending.status === 'uploading' && (
            <UploadProgress
              loaded={pending.loaded}
              total={pending.total}
              onCancel={() => cancelUpload(pending.id)}
            />
          )}

          {pending.status === 'error' && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-danger">{pending.errorMessage}</p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => uploadFile(pending)}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Retry
              </Button>
            </div>
          )}
        </div>
      ))}

      {/* Gallery */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : attachments.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="group relative rounded-lg border border-border overflow-hidden bg-surface-light"
            >
              {/* Thumbnail */}
              <a
                href={att.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
                title={att.file_type.startsWith('video/') ? 'Play video' : 'Open in new tab'}
                aria-label={
                  att.file_type.startsWith('video/')
                    ? `Play ${att.display_name}`
                    : `Open ${att.display_name}`
                }
                onClick={(e) => {
                  if (att.file_type.startsWith('video/')) {
                    e.preventDefault();
                    setVideoAttachment(att);
                  }
                }}
              >
                {att.file_type.startsWith('image/') ? (
                  <UploadedImage
                    src={att.file_url}
                    alt={att.display_name}
                    backdrop
                    className="w-full h-24"
                  />
                ) : (
                  <div className="w-full h-24 flex items-center justify-center bg-background-light text-text-secondary">
                    <FileIcon fileType={att.file_type} />
                  </div>
                )}
              </a>

              {/* Row actions cluster (#2047) — the row-actions trigger (always visible) and
                  Delete (unchanged hover-reveal) share ONE absolutely positioned flex cluster at
                  the tile's existing top-1/right-1 anchor, rather than a second absolute element
                  stacked on the same coordinates. */}
              <div className="absolute top-1 right-1 flex items-center gap-1">
                <AttachmentRowActions
                  attachment={att}
                  entityType={entityTypeLower as 'lead' | 'job' | 'invoice' | 'customer' | 'task'}
                  entityId={entityId}
                  uploaderId={att.uploader?.id}
                  onRenamed={() =>
                    queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] })
                  }
                />
                {/* Delete button - tiny thumbnail-overlay affordance with a group-hover:opacity
                    reveal, not Button-shaped - left raw. Offered only where the server would
                    allow it: the delete grant, or (on a task) a file the user uploaded. */}
                {mayChange('delete', att.uploader?.id) && (
                <button
                  type="button"
                  aria-label="Delete attachment"
                  className="flex items-center justify-center h-5 w-5 rounded bg-surface-light/80 text-text-secondary hover:text-danger hover:bg-surface-light opacity-0 group-hover:opacity-100 transition-all"
                  onClick={async () => {
                    if (await confirm(deleteAttachmentPrompt(att.display_name))) {
                      deleteMutation.mutate(att.id);
                    }
                  }}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                )}
              </div>

              {/* Info */}
              <div className="px-2 py-1.5">
                <p className="text-[11px] font-medium text-text-primary truncate">{att.display_name}</p>
                {att.description && (
                  <p className="text-[10px] text-text-secondary truncate" title={att.description}>
                    {att.description}
                  </p>
                )}
                <p className="text-[10px] text-text-secondary">
                  {formatDistanceToNow(new Date(att.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

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
      {confirmDialog}
    </div>
  );
}
