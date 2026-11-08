/**
 * downloadAttachment — the ONE download behaviour shared by every attachment row (invoices,
 * leads, jobs — both the Attachments tab and the Overview card) and the invoice lightbox
 * (#2047). See `md_files/plans/agents/runs/issue-2047/spec.md`, OQ1 and Design (1)/(R3)-(R6).
 *
 * The signed `file_url` (this app's storage backend, 1h TTL — `backend/src/lib/attachment-access.ts`)
 * serves inline with no `content-disposition`, so a plain `<a href>` opens the file instead of
 * saving it. OQ1 proved (an executed cross-origin `fetch`/`OPTIONS` probe against the storage
 * host, recorded in spec.md) that the storage host's CORS policy allows a same-app-origin
 * `fetch()` to read the response body, so the mechanism here is fetch -> blob -> the shared
 * `downloadBlob` anchor-click-revoke helper (`@/lib/utils`, reused per R3 rather than
 * re-implemented) — never `window.open`, never a page navigation.
 */
import api from '@/lib/axios';
import { downloadBlob } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';

export interface DownloadableAttachment {
  file_name?: string | null;
  display_name: string;
}

export interface DownloadAttachmentInput extends DownloadableAttachment {
  id: string;
  file_url: string;
}

export interface DownloadAttachmentOptions {
  /**
   * Re-reads a fresh signed URL for this attachment (a direct list re-read, not a cache
   * invalidation — the caller's closure already holds the stale string, so invalidating a
   * react-query cache cannot hand a new one to an in-flight call). Returns `null` when none is
   * found.
   */
  refresh?: () => Promise<string | null>;
}

/**
 * The save-as filename. Upload strips the extension off the display name
 * (`AttachmentSection.tsx`, `AttachmentsTabBody.tsx`, both
 * `file.name.replace(/\.[^/.]+$/, '')`), so a rename must not produce an extension-less save:
 * the extension always comes from the stored `file_name` (sanitised server-side at upload,
 * `backend/src/lib/attachment-access.ts` `sanitizeAttachmentFilename`) — `display_name` is free
 * text a user can rename to anything and never gets to decide the extension, only the base name
 * (R6: a `display_name` of `report.pdf` on a stored `photo.png` saves as `report.pdf.png` — the
 * real extension always wins).
 */
export function downloadFileName(a: DownloadableAttachment): string {
  const storedExt = (a.file_name ?? '').match(/\.[^./\\]+$/)?.[0] ?? '';
  const base = sanitizeForFilename(a.display_name) || sanitizeForFilename(a.file_name ?? '');
  if (!base) return 'download';
  if (storedExt && base.toLowerCase().endsWith(storedExt.toLowerCase())) return base;
  return storedExt ? `${base}${storedExt}` : base;
}

/**
 * `display_name` is unsanitised free text (`z.string().min(1).max(255)`, no charset
 * restriction — `backend/src/controllers/attachment.controller.ts`) turned straight into a
 * saved filename (R6). Strip any path prefix, drop control characters, strip leading dots and
 * cap the length — spaces and ordinary punctuation are kept, this is a save-as name, not a
 * storage bucket key (the backend's own `sanitizeAttachmentFilename` is stricter for exactly
 * that reason, and is not reused here on purpose).
 *
 * Exported since the unplayable-video fallback (`components/ui/VideoPlayer.tsx`) has to name a
 * save-as file from a bare URL, with no attachment record behind it. It must not hand-roll a
 * second, weaker version of this: a legacy staging attachment's `dataUrl` is a base64 payload,
 * so an unbounded "last path segment" name is the whole blob.
 */
export function sanitizeForFilename(name: string): string {
  return name
    .replace(/^.*[\\/]/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
}

/**
 * Fetches the signed URL into a blob and saves it via `downloadBlob`. Signed URLs carry a 1h
 * TTL and are re-minted on every list read (R4), so "the tab was open over lunch" is the
 * ordinary failure case, not an edge one: a failed first attempt tries `opts.refresh` once, and
 * only a second failure surfaces the toast. Handles both `!res.ok` and a rejected `fetch`
 * (offline/DNS) in the same path (R5.1). Never rethrows, never rejects, never navigates and
 * never logs the signed URL — only the attachment id may appear in any diagnostic (R5.2-R5.4),
 * so callers can `void` this without a `.catch`.
 */
export async function downloadAttachment(
  a: DownloadAttachmentInput,
  opts?: DownloadAttachmentOptions,
): Promise<void> {
  const name = downloadFileName(a);

  const attempt = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const blob = await res.blob();
      downloadBlob(blob, name);
      return true;
    } catch {
      return false;
    }
  };

  if (await attempt(a.file_url)) return;

  if (opts?.refresh) {
    const refreshed = await opts.refresh().catch(() => null);
    if (refreshed && refreshed !== a.file_url && (await attempt(refreshed))) return;
  }

  toast({
    variant: 'destructive',
    title: 'Download failed',
    description: 'Could not download this file. Please try again.',
  });
}

/** Extension for the container types this app accepts (`lib/uploadTypes.ts`). */
const EXTENSION_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

/**
 * A save-as name when all we have is a URL, and optionally a caption and a container type —
 * the unplayable-video fallback's case, where no attachment record is in scope.
 *
 * `data:` and `blob:` URLs have no meaningful path, and a legacy staging attachment stores its
 * whole base64 payload in `dataUrl`, so those are never mined for a name. Everything that does
 * come from user-controlled text goes through `sanitizeForFilename`, which caps the length and
 * strips control characters.
 */
export function downloadFileNameFromUrl(
  url: string,
  opts?: { name?: string | null; mimeType?: string | null },
): string {
  const ext = opts?.mimeType ? (EXTENSION_BY_MIME[opts.mimeType.toLowerCase()] ?? '') : '';

  const fromPath = /^(data|blob):/i.test(url)
    ? ''
    : (() => {
        const path = url.split(/[?#]/)[0] ?? url;
        const last = path.split('/').pop() ?? '';
        try {
          return decodeURIComponent(last);
        } catch {
          return last;
        }
      })();

  const base = sanitizeForFilename(opts?.name ?? '') || sanitizeForFilename(fromPath) || 'video';
  if (!ext || base.toLowerCase().endsWith(ext)) return base;
  return `${base}${ext}`;
}

/**
 * Save a file we only have a URL for.
 *
 * The HTML `download` attribute is ignored on a cross-origin `href`, and stored files are served
 * from a different origin than the app, so a plain anchor opens the video instead of saving it.
 * The mechanism that works is the one `downloadAttachment` above already uses: read the bytes
 * with `fetch` (the storage host's CORS policy lets the app origin read the body), wrap them in a
 * `blob:` URL — which is SAME-origin, so `download` is honoured there — and click an anchor at
 * that.
 *
 * Opens the file in a new tab if the read fails, so the control is never a no-op. Prefer
 * `downloadAttachment` whenever an attachment record is in scope: it names the file from the
 * stored extension and can re-mint an expired link.
 */
export async function downloadFromUrl(
  url: string,
  opts?: { name?: string | null; mimeType?: string | null },
): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    downloadBlob(await res.blob(), downloadFileNameFromUrl(url, opts));
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Builds the `refresh` callback `downloadAttachment` and the unplayable-video fallback both take:
 * a DIRECT re-read of the attachment list that returns a newly-minted signed URL for one row.
 *
 * A direct read, never a react-query invalidation — the caller's closure already holds the stale
 * string, so invalidating a cache cannot hand a fresh URL to an in-flight call. The list route
 * re-mints on every read. (`AttachmentRowActions.tsx` still carries its own identical inline copy;
 * folding that one in is a separate change, not this one's business.)
 */
export function makeAttachmentUrlRefresher(
  entityType: string,
  entityId: string,
  attachmentId: string,
): () => Promise<string | null> {
  return async () => {
    try {
      const { data } = await api.get(`/api/attachments/${entityType}/${entityId}`);
      const rows = (data?.attachments ?? []) as Array<{ id: string; file_url: string }>;
      return rows.find((r) => r.id === attachmentId)?.file_url ?? null;
    } catch {
      return null;
    }
  };
}
