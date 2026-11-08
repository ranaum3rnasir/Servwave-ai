/**
 * AttachmentRowActions — the ONE shared per-row actions control for #2047, used by
 * `AttachmentsPanel` (invoices), `AttachmentSection` (leads), `AttachmentsTabBody` and
 * `JobFilesCard` (jobs — both tabs), plus Download inside `AttachmentLightbox`. See
 * `md_files/plans/agents/runs/issue-2047/spec.md` Design (2), OQ2-OQ4, R2, R6, R7, R9.
 *
 * Trigger is a real `ui/dropdown-menu` (Radix), not a row of icon buttons — prior art
 * `components/workflows/StepNode.tsx`'s per-row kebab. Items: Download (always, anyone who can
 * see the list) and Rename (only when `renamable !== false && ability.can('update',
 * 'Attachment')` — ability-gated only, never a role name, OQ4). Delete is NOT rendered here —
 * it stays exactly where and as it is on every call site (Design (2)).
 *
 * The trigger renders at full opacity at all times (R9): no `opacity-0` start, no
 * `group-hover` gate, always tab-reachable with the primitive's own focus-visible ring, at
 * least 24x24 CSS px. It must always be a SIBLING of the row's own link/anchor, never nested
 * inside it (the interactive-nesting rule `AttachmentsTabBody.tsx` already records).
 *
 * The trigger's own rest-state backdrop (a small rounded pill) lives HERE, in the shared
 * component's default className, not in any call site's wrapper (round 2, D1/D2). It used to be
 * missing on the lead tile (a bare glyph over the photo, D2) and, on the two job surfaces,
 * supplied by an outer wrapper that ALSO reserved space for the hover-only Delete control next
 * to it - so at rest the pill read as twice the visible glyph's width with an empty right half
 * (D1). Giving the trigger its own tightly-fit backdrop by default makes every surface's rest
 * state identical with zero call-site styling, and each surface's Delete keeps its own
 * separately-sized, separately hover-gated pill (unchanged behaviour).
 */
import { useState } from 'react';
import { Download, MoreVertical, Pencil } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { useAttachmentChangePermission } from '@/lib/attachments/useAttachmentChangePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadAttachment, type DownloadAttachmentInput } from '@/lib/attachments/downloadAttachment';

export type AttachmentRowActionsAttachment = DownloadAttachmentInput;

export interface AttachmentRowActionsProps {
  attachment: AttachmentRowActionsAttachment;
  /** Lower-case — the route's own param (`/api/attachments/<entityType>/<entityId>/...`). */
  entityType: 'lead' | 'job' | 'invoice' | 'customer' | 'task';
  entityId: string;
  /** Who uploaded the file. On a task, the uploader may rename it without the grant. */
  uploaderId?: string;
  /** Omit (or pass `true`) to allow Rename when the ability holds it. `false` hides Rename
   * regardless of ability — used for lead-sourced tiles rendered on a job. */
  renamable?: boolean;
  /** The caller's own invalidation, fired after a successful rename. */
  onRenamed?: () => void;
  align?: 'end' | 'start';
  className?: string;
}

export function AttachmentRowActions({
  attachment,
  entityType,
  entityId,
  uploaderId,
  renamable = true,
  onRenamed,
  align = 'end',
  className,
}: AttachmentRowActionsProps) {
  const mayChange = useAttachmentChangePermission(entityType);
  const canRename = renamable !== false && mayChange('update', uploaderId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [value, setValue] = useState(attachment.display_name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== attachment.display_name;

  const openRename = () => {
    setValue(attachment.display_name);
    setError(null);
    setRenameOpen(true);
  };

  const closeRename = () => {
    if (saving) return;
    setRenameOpen(false);
  };

  // R4: a direct re-read of the list, not a cache invalidation — the download closure has
  // already captured the (possibly stale) file_url, so an invalidated query cannot hand a
  // fresh one to an in-flight call. The list route re-mints the signed URL on every read.
  const refresh = async (): Promise<string | null> => {
    try {
      const { data } = await api.get(`/api/attachments/${entityType}/${entityId}`);
      const rows = (data?.attachments ?? []) as Array<{ id: string; file_url: string }>;
      return rows.find((r) => r.id === attachment.id)?.file_url ?? null;
    } catch {
      return null;
    }
  };

  const handleDownload = () => {
    void downloadAttachment(attachment, { refresh });
  };

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Exactly `{ display_name }` — never the whole form state (R7): `description` is written
      // by the controller whenever the key is present at all, so sending it (even as `''`)
      // would silently wipe it.
      await api.patch(`/api/attachments/${entityType}/${entityId}/${attachment.id}`, {
        display_name: trimmed,
      });
      setRenameOpen(false);
      onRenamed?.();
    } catch (err) {
      setError(extractApiError(err, 'Could not rename this file. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        {/* The pill chrome lives on THIS wrapper, not on the Button's className: per the
            layering guard, a primitive's appearance is decided inside the primitive, never at
            a call site (Button is a components/ui export). Wrapping the trigger keeps Radix's
            asChild contract intact -- asChild clones props onto its single child, the Button --
            while still giving the trigger its own always-visible backdrop (round 2, D1/D2). */}
        <div className={className ?? 'inline-flex shrink-0 overflow-hidden rounded-full bg-surface-light/90 shadow ring-1 ring-border'}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              tone="subtle"
              size="icon"
              aria-label={`Actions for ${attachment.display_name}`}
              className="h-6 w-6"
            >
              <MoreVertical className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align={align}>
          <DropdownMenuItem onClick={handleDownload}>
            <Download className="mr-2 h-4 w-4" aria-hidden />
            Download
          </DropdownMenuItem>
          {canRename && (
            <DropdownMenuItem onClick={openRename}>
              <Pencil className="mr-2 h-4 w-4" aria-hidden />
              Rename
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Modal
        open={renameOpen}
        onClose={closeRename}
        title="Rename file"
        width="xs"
        footer={
          <>
            <Button variant="outline" onClick={closeRename} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={!canSave || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Input
            aria-label="File name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={255}
            autoFocus
          />
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
