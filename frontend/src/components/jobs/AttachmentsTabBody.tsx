import { useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, FileText as FileTextIcon, Film, Trash2, Upload } from 'lucide-react';

import { cn, extractApiError } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { SectionCard, SectionLabel } from '@/components/jobs/overview/SectionCard';
import { useDeleteJobAttachment } from '@/hooks/useDeleteJobAttachment';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';
import { ACCEPTED_UPLOAD_TYPES } from '@/lib/uploadTypes';
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

/**
 * The Job detail page's Attachments tab body.
 *
 * Lifted out of `pages/JobDetailPage.tsx` verbatim so the /v2 job page can
 * render it without importing a legacy page. The tiles need a raw `<a>`,
 * `<img>`, `<input type="file">` and `<label>` - the raw-tag ratchet in
 * component-api-guard sits at its floor for all four, so this markup must be
 * MOVED rather than re-authored anywhere.
 */

interface AttachmentItem {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  display_name: string;
  description?: string | null;
  source?: string | null;
}

function AttachmentTile({
  att,
  jobId,
  onDelete,
  deleting,
  onRenamed,
}: {
  att: AttachmentItem;
  jobId: string;
  onDelete?: (att: AttachmentItem) => void;
  deleting?: boolean;
  onRenamed?: () => void;
}) {
  const isImage = att.file_type.startsWith('image/');
  const isVideo = att.file_type.startsWith('video/');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  return (
    <>
      {/* `group` + `relative` live on this wrapper, not on the `<a>`, so the delete control is a
          SIBLING of the link rather than a button nested inside an anchor (invalid interactive
          nesting, and its click would have to fight the link's own navigation). */}
      <div className="group relative overflow-hidden rounded-xl border border-border bg-surface-light transition-all hover:border-primary/40 hover:shadow-card">
        <a
          href={att.file_url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
          onClick={(e) => {
            if (isVideo) {
              e.preventDefault();
              setVideoUrl(att.file_url);
            }
          }}
        >
          {isImage ? (
            <UploadedImage
              src={att.file_url}
              alt={att.display_name}
              backdrop
              className="h-28 w-full"
              imgClassName="transition-transform duration-200 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex h-28 w-full items-center justify-center bg-background-light text-text-secondary">
              {isVideo ? <Film className="h-6 w-6" /> : <FileTextIcon className="h-6 w-6" />}
            </div>
          )}
          {att.source === 'LEAD' && (
            <span className="absolute left-1 top-1 rounded-full bg-info/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-info">
              Lead
            </span>
          )}
          <div className="px-2 py-1.5">
            <p className="text-[11px] font-medium text-text-primary truncate">{att.display_name}</p>
            {att.description && (
              <p className="text-[10px] text-text-secondary truncate" title={att.description}>
                {att.description}
              </p>
            )}
          </div>
        </a>
        {/* Actions cluster (#2047) — rendered unconditionally (row actions must reach
            From-lead tiles too, which get no `onDelete`), Delete kept as its own guarded
            child so its hover-reveal is unchanged. `renamable` is derived from `att.source`,
            never threaded through props - the same discriminator `isDeletableFromJob` uses, so
            a From-lead tile can never accidentally offer Rename on a route that can only 404.
            No shared backdrop on this wrapper (round 2, D1): the trigger's pill is always
            visible and lives on the trigger itself; Delete's own pill is hover-gated and lives
            on ITS OWN wrapper, so nothing renders an oversized half-empty backdrop at rest. */}
        <div className="absolute right-1 top-1 flex items-center gap-1">
          <AttachmentRowActions
            attachment={att}
            entityType="job"
            entityId={jobId}
            renamable={att.source !== 'LEAD'}
            onRenamed={onRenamed}
          />
          {onDelete && (
            // The pill chrome and the hover-reveal live on this WRAPPER, not in the Button's
            // className: per the layering guard, a primitive's appearance is decided inside the
            // primitive.
            <div className="overflow-hidden rounded-full bg-surface-light/90 opacity-0 shadow ring-1 ring-border transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <Button
                variant="ghost"
                tone="danger"
                revealOnHover
                size="icon"
                disabled={deleting}
                onClick={() => onDelete(att)}
                aria-label={`Delete ${att.display_name}`}
                title="Delete attachment"
                className="h-6 w-6"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>
      {/* `att` is already this tile's own record, so the overlay gets a correctly-named download
          and a re-mint of the 1h signed URL when it has timed out. */}
      <VideoPreviewDialog
        url={videoUrl}
        mimeType={att.file_type}
        onDownload={() =>
          void downloadAttachment(att, { refresh: makeAttachmentUrlRefresher('job', jobId, att.id) })
        }
        onRefreshUrl={makeAttachmentUrlRefresher('job', jobId, att.id)}
        onClose={() => setVideoUrl(null)}
      />
    </>
  );
}

export function AttachmentsTabBody({
  jobId,
  attachments,
}: {
  jobId: string;
  attachments: AttachmentItem[] | undefined;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const deleteAttachment = useDeleteJobAttachment(jobId);
  const { confirm, confirmDialog } = useConfirm();

  const handleDelete = async (att: AttachmentItem) => {
    if (await confirm(deleteAttachmentPrompt(att.display_name))) {
      deleteAttachment.mutate(att.id);
    }
  };

  // The pair every other job-attachment mutation already invalidates (`useDeleteJobAttachment`
  // above): both surfaces (this tab and `JobFilesCard` on the Overview tab) render the same
  // `['job-attachments-wt', jobId]` query.
  const handleRenamed = () => {
    queryClient.invalidateQueries({ queryKey: ['job-attachments-wt', jobId] });
    queryClient.invalidateQueries({ queryKey: ['attachments', 'JOB', jobId] });
  };

  /**
   * Still per file, not all-or-nothing: the loop used to abort on the first rejection, so a
   * single unsupported file silently swallowed every file queued behind it and never said
   * which one failed (#1605). `useUploadQueue` keeps that property — it walks the batch
   * serially and collects failures — and adds the S5 guidance: each file is rendered with its
   * size (and clip length, when the browser offers one) BEFORE its bytes go out, and whatever
   * byte counts the transport reports are fed back through `onProgress`.
   *
   * Which transport that is, is `uploadAttachment`'s business and not this file's — which is
   * why nothing here names one. Video currently reports no byte counts, so its row sits in
   * the indeterminate state rather than showing an invented number.
   *
   * The file handed to the seam is the object the picker produced, untouched. Nothing on this
   * path re-encodes, trims or compresses it.
   */
  const uploads = useUploadQueue({
    upload: (file, onProgress, signal) =>
      uploadAttachment({
        entityType: 'job',
        entityId: jobId,
        file,
        onProgress,
        signal,
      }),
    describeError: (err) => extractApiError(err, 'Upload failed.'),
    onSettled: (failures) => {
      queryClient.invalidateQueries({ queryKey: ['job-attachments-wt', jobId] });
      queryClient.invalidateQueries({ queryKey: ['attachments', 'JOB', jobId] });
      if (failures.length) {
        toast({
          variant: 'destructive',
          title: failures.length === 1 ? 'Upload failed' : `${failures.length} uploads failed`,
          description: failures.map((f) => `${f.name}: ${f.reason}`).join('\n'),
        });
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (dropZoneInputRef.current) dropZoneInputRef.current.value = '';
    },
  });
  const uploading = uploads.isUploading;

  const handleUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    uploads.enqueue(files);
  };

  const handleDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files);
  };

  const all = attachments ?? [];

  // `source` is the ONLY discriminator. It used to be OR'd with context==='WALKTHROUGH', which
  // worked only because that was the single context the API forwarded; once every lead file
  // travelled, context said nothing about where a file came from. `context` is now retired.
  const isFromLead = (a: { source?: string | null }) => a.source === 'LEAD';

  const photos = all.filter((a) => a.file_type.startsWith('image/') && !isFromLead(a));
  const leadPhotos = all.filter((a) => a.file_type.startsWith('image/') && isFromLead(a));
  const docs = all.filter((a) => !a.file_type.startsWith('image/') && !isFromLead(a));
  const leadDocs = all.filter((a) => !a.file_type.startsWith('image/') && isFromLead(a));

  const fromLead = [...leadPhotos, ...leadDocs];

  const uploadControl = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_UPLOAD_TYPES}
        className="hidden"
        id="attachments-tab-upload"
        onChange={(e) => handleUpload(e.target.files)}
      />
      {/* Not a FormField target: this label wraps a Button trigger for a hidden
          file input, not description text for a visible field - no hint/error/
          required concept applies, same shape as the drop-zone label below. */}
      <label htmlFor="attachments-tab-upload">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          className="cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
      </label>
    </>
  );

  if (all.length === 0) {
    return (
      <SectionCard
        title="Attachments"
        icon={<ImageIcon className="h-4 w-4 text-text-secondary" />}
        meta={uploadControl}
      >
        {/* Size, clip length and the nudge for anything picked but not yet finished. Rendered
            above the drop zone so the cost is the first thing on screen, not a footnote. */}
        <UploadRefusalList messages={uploads.refusals} className="mb-3" />
        <UploadSelectionList items={uploads.items} onCancel={uploads.cancel} className="mb-3" />
        {/* Self-contained drop-zone: its own hidden input (implicit label
            association — no htmlFor) so the header Upload button + its input
            keep working independently, with no duplicate DOM ids. */}
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed py-12 text-center transition-colors',
            isDragging
              ? 'border-primary bg-primary-subtle'
              : 'border-border hover:border-primary/50 hover:bg-background-light'
          )}
        >
          <input
            ref={dropZoneInputRef}
            type="file"
            multiple
            accept={ACCEPTED_UPLOAD_TYPES}
            className="hidden"
            id="attachments-empty-drop-zone-upload"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <ImageIcon className="mb-2 h-8 w-8 text-text-secondary/30" />
          <p className="text-sm font-medium text-text-primary">
            Drag &amp; drop files here, or click to upload
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {uploading ? 'Uploading…' : 'No attachments yet'}
          </p>
        </label>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Attachments"
      icon={<ImageIcon className="h-4 w-4 text-text-secondary" />}
      meta={uploadControl}
      bodyClassName="space-y-6"
    >
      <UploadRefusalList messages={uploads.refusals} />
      <UploadSelectionList items={uploads.items} onCancel={uploads.cancel} />
      {photos.length > 0 && docs.length > 0 ? (
        // Both present → Photos and Documents sit side-by-side to save vertical
        // space (instead of two stacked full-width rows). Each column scrolls the
        // whole set — nothing is capped, so 20+ items all render.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <SectionLabel>Photos ({photos.length})</SectionLabel>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {photos.map((a) => (
                <AttachmentTile key={a.id} att={a} jobId={jobId} onDelete={handleDelete} deleting={deleteAttachment.isPending} onRenamed={handleRenamed} />
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>Documents ({docs.length})</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {docs.map((a) => (
                <AttachmentTile key={a.id} att={a} jobId={jobId} onDelete={handleDelete} deleting={deleteAttachment.isPending} onRenamed={handleRenamed} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {photos.length > 0 && (
            <div>
              <SectionLabel>Photos ({photos.length})</SectionLabel>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {photos.map((a) => (
                  <AttachmentTile key={a.id} att={a} jobId={jobId} onDelete={handleDelete} deleting={deleteAttachment.isPending} onRenamed={handleRenamed} />
                ))}
              </div>
            </div>
          )}
          {docs.length > 0 && (
            <div>
              <SectionLabel>Documents ({docs.length})</SectionLabel>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {docs.map((a) => (
                  <AttachmentTile key={a.id} att={a} jobId={jobId} onDelete={handleDelete} deleting={deleteAttachment.isPending} onRenamed={handleRenamed} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {fromLead.length > 0 && (
        <div>
          <SectionLabel>From lead ({fromLead.length})</SectionLabel>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {/* No `onDelete`: these rows belong to the LEAD and are only forwarded in.
                The delete route is scoped to entity_type=JOB, so removing one here
                could only ever 404 - and if it did work it would strip the file off
                the lead as well. Deleting happens on the lead. */}
            {fromLead.map((a) => (
              <AttachmentTile key={a.id} att={a} jobId={jobId} onRenamed={handleRenamed} />
            ))}
          </div>
        </div>
      )}
      {confirmDialog}
    </SectionCard>
  );
}
