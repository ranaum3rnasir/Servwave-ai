import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Briefcase,
  Calendar,
  Camera,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileText,
  Film,
  History,
  ImageIcon,
  Loader2,
  Mail,
  MapPin,
  Package,
  Pencil,
  Play,
  Plus,
  Printer,
  Save,
  Send,
  Trash2,
  Truck,
  Upload,
  User,
  Video,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { AttachmentLightbox } from "@/components/ui/AttachmentLightbox";
import { downloadFromUrl } from "@/lib/attachments/downloadAttachment";
import { UploadedImage } from "@/components/ui/uploaded-image";
import { SelectField } from "@/components/form/SelectField";
import { DateTimePicker } from "@/components/form/DateTimePicker";
import { EmptyState } from "@/components/ui/empty-state";
import { POPreviewDialog } from "./POPreviewDialog";
import { StagePreviewDialog } from "./StagePreviewDialog";
import { EmailComposeDialog } from "./EmailComposeDialog";
import {
  tradeColor,
  useVendors,
  useTechs,
  useUploadStageAttachment,
  useDeleteStageAttachment,
  type JobStage,
  type StageAttachment,
  type StageAuditEntry,
  type Location,
} from "@/lib/api/inventory";
import { useAuthStore } from "@/stores/auth.store";
import { useAppAbility } from "@/contexts/AbilityContext";
import { extractApiError } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/data/status-badge";
import { useConfirm } from "@/hooks/useConfirm";
import {
  UploadSelectionList,
  type UploadSelectionView,
} from "@/components/attachments/UploadSelectionList";
import { probeVideoDuration } from "@/lib/attachments/uploadGuidance";
import { oversizeRefusalMessage } from "@/lib/uploadTypes";
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue, formatInstant } from "@/lib/schedule-tz";

// Only a UUID is a real server row (mock/legacy local attachments synthesize
// `att_*` ids) — only those round-trip DELETE to the attachments endpoint.
const SERVER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * P5 §5.4 — upload rasterized PDF pages (PNG data-URLs from pdf.js) to the
 * stage-attachments endpoint, one POST per page with `source='pdf-page'`
 * provenance. The server never parses PDFs. Extracted from the dialog so the
 * FormData contract is unit-testable without pdf.js.
 */
export async function uploadPdfPages(
  uploadOne: (args: { stageId: string; form: FormData }) => Promise<{ attachment: StageAttachment }>,
  stageId: string,
  fileName: string,
  pages: { num: number; dataUrl: string }[],
): Promise<{ uploaded: StageAttachment[]; failed: number; lastError?: string }> {
  const uploaded: StageAttachment[] = [];
  let failed = 0;
  let lastError: string | undefined;
  const baseName = fileName.replace(/\.pdf$/i, "");
  for (const p of pages) {
    try {
      const blob = await (await fetch(p.dataUrl)).blob();
      const fd = new FormData();
      fd.append("file", new File([blob], `${baseName} - page ${p.num}.png`, { type: "image/png" }));
      fd.append("source", "pdf-page");
      fd.append("pdfFileName", fileName);
      fd.append("pdfPageNumber", String(p.num));
      fd.append("caption", `${fileName} · page ${p.num}`);
      const res = await uploadOne({ stageId, form: fd });
      uploaded.push(res.attachment);
    } catch (err) {
      failed += 1;
      lastError = extractApiError(err, "upload failed");
    }
  }
  return { uploaded, failed, lastError };
}

// `StagingStatus` is not separately re-exported by the seam; derive it from the
// JobStage shape so we depend only on the seam, never `_mock`.
type StagingStatus = JobStage["status"];

// Pure progress helper. Emanuel exports this from `data/staging.ts`, but the
// data-seam rule forbids importing runtime values from `_mock/*` and the seam
// does not (yet) re-export it - see `concerns`. It is tiny and pure, so it is
// inlined here. (Status badge rendering now goes through the shared
// StatusBadge/status-registry instead of a local helper.)
function stageProgress(s: JobStage): {
  received: number;
  ordered: number;
  pct: number;
} {
  const received = s.items.reduce((sum, i) => sum + i.qtyReceived, 0);
  const ordered = s.items.reduce((sum, i) => sum + i.qtyOrdered, 0);
  return {
    received,
    ordered,
    pct: ordered === 0 ? 0 : Math.round((received / ordered) * 100),
  };
}

type Props = {
  open: boolean;
  onClose: () => void;
  stage: JobStage | null;
  locations: Location[];
  onSave: (updated: JobStage, audit: StageAuditEntry[]) => void;
  onReceiveOne: (stageId: string, lineId: string) => void;
  onEmailSent?: (stage: JobStage, recipients: string[]) => void;
};

let selectionSeq = 0;

export function StageDetailDialog({
  open,
  onClose,
  stage,
  locations,
  onSave,
  onReceiveOne,
  onEmailSent,
}: Props) {
  const { confirm, confirmDialog } = useConfirm();
  // A stage's scheduled time is the COMPANY's clock. Both ends were wrong here: the picker
  // was seeded by slicing the raw ISO (so it showed UTC) and saved via `new Date(...)` (so it
  // stored the browser's), which is the same pairing that mis-stored the walkthrough times.
  const timezone = useScheduleTimezone();
  // Live mock data via the seam (Emanuel read these as module-scope arrays).
  const { data: allVendors = [] } = useVendors();
  const { data: allTechs = [] } = useTechs();
  // P5 §5.4 — attachments persist through the Storage-backed endpoints; the
  // ['inventory','job-stages'] invalidation re-seeds StagingView afterwards.
  const uploadAttachment = useUploadStageAttachment();
  const deleteAttachment = useDeleteStageAttachment();
  // Actor identity for audit entries comes from the ALPHA auth store.
  const authUser = useAuthStore((s) => s.user);
  const actorName = authUser
    ? `${authUser.first_name} ${authUser.last_name}`.trim()
    : "Unknown user";

  // In-progress stages (work not yet done) open in always-edit mode so the
  // operator can update fields without clicking "Edit Stage" first. Finished
  // stages (complete / ready_for_pickup / delivered) open read-only with an
  // "Edit Stage" button for occasional corrections.
  const isInProgress =
    stage?.status === "awaiting" || stage?.status === "partial";

  // #2043 R4 - `editing` gates its own state, not only the buttons: a
  // read-only requester can never land in edit mode, in-progress stage or
  // not, so the per-line qtyReceived inputs (which render under `editing`)
  // never appear for them either.
  const ability = useAppAbility();
  const canUpdate = ability.can("update", "Inventory");

  const [editing, setEditing] = useState(isInProgress && canUpdate);
  const [form, setForm] = useState<JobStage | null>(stage);
  const [pendingAudit, setPendingAudit] = useState<StageAuditEntry[]>([]);
  const [previewPONumber, setPreviewPONumber] = useState<string | null>(null);
  const [showStagePreview, setShowStagePreview] = useState(false);
  const [showEmailCompose, setShowEmailCompose] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState<StageAttachment | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // S5 — what each picked file will cost, shown before and during its upload.
  const [uploadSelections, setUploadSelections] = useState<UploadSelectionView[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pdfPicker, setPdfPicker] = useState<{
    fileName: string;
    pages: { num: number; dataUrl: string }[];
    selected: Set<number>;
  } | null>(null);

  // Hidden input refs for the three capture modes (take photo, record video,
  // generic upload). Each input is configured with the right accept + capture
  // attributes so phones surface the correct UI (camera vs gallery vs files).
  const takePhotoInputRef = useRef<HTMLInputElement | null>(null);
  const recordVideoInputRef = useRef<HTMLInputElement | null>(null);
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setForm(stage);
    setEditing(isInProgress && canUpdate);
    setPendingAudit([]);
    setPhotoError(null);
    setLightboxPhoto(null);
    setPdfPicker(null);
    setUploading(false);
    // isInProgress is derived from stage.status, so re-running on stage?.id
    // covers it; intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage?.id, open]);

  /**
   * The four headed sections, flattened onto the option type's `group`. The
   * IIFE this replaces hand-composed <SelectGroup>/<SelectLabel>, which put the
   * option count where §4.2's primitive could not read it. Section order is
   * first-seen, so it is the order of the `TYPES` list below; a type with no
   * locations contributes nothing and its heading never renders.
   */
  const stagedLocationOptions = useMemo(() => {
    const TYPES: [string, string][] = [
      ["warehouse", "Warehouses"],
      ["staging", "Job-site Staging"],
      ["counter", "Counter / Shop"],
      ["truck", "Trucks / Vans (direct-to-van staging)"],
    ];
    return [
      { value: "NONE", label: "—" },
      ...TYPES.flatMap(([type, group]) =>
        locations
          .filter((l) => l.type === type)
          .map((l) => ({
            value: l.id,
            label:
              type === "truck"
                ? `${l.name}${l.primaryTech ? ` · ${l.primaryTech}` : ""}${l.vehicle ? ` · ${l.vehicle}` : ""}`
                : `${l.name} · ${l.branch}`,
            group,
          }))
      ),
    ];
  }, [locations]);

  const auditEntries = useMemo(() => {
    const merged = [
      ...((stage?.auditLog ?? []) as StageAuditEntry[]),
      ...pendingAudit,
    ];
    return [...merged].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [stage?.auditLog, pendingAudit]);

  if (!stage || !form) return null;

  function addAudit(
    field: string,
    oldValue: string | undefined,
    newValue: string,
    comment?: string,
  ) {
    setPendingAudit((prev) => [
      ...prev,
      {
        id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        actorName,
        field,
        oldValue,
        newValue,
        comment,
      },
    ]);
  }

  function update<K extends keyof JobStage>(key: K, value: JobStage[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  // The duration probe used to base64 the WHOLE file through a FileReader just to hand the
  // resulting data URI to a <video>. On a 100MB clip that is 100MB of file plus ~133MB of
  // base64 string held in the tab, to read a header. The shared probe points the element at
  // an object URL instead, reads metadata only, and releases it - and it is the same probe
  // the other four attachment surfaces use, so "how long is this clip" has one answer.

  // Renders every page of a PDF File into PNG data URLs via pdf.js. The
  // worker is loaded from /node_modules which Vite serves natively as ESM —
  // simpler and more reliable than Vite's ?worker / ?url suffixes in this
  // project's config.
  async function renderPdfPages(file: File): Promise<{ num: number; dataUrl: string }[]> {
    // Load pdfjs via the served node_modules path. The /* @vite-ignore */ tells
    // Vite to leave the import string alone (its dep-optimizer hangs for
    // pdfjs-dist in this project's config). The specifier is held in a
    // string-typed const so tsc treats it as a runtime path (no type-only
    // module resolution) and the namespace is cast to the small slice of the
    // pdf.js API actually used here.
    type PdfjsLike = {
      GlobalWorkerOptions: { workerSrc?: string };
      getDocument: (opts: Record<string, unknown>) => {
        promise: Promise<{
          numPages: number;
          getPage: (n: number) => Promise<{
            getViewport: (o: { scale: number }) => { width: number; height: number };
            render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
          }>;
        }>;
      };
    };
    const pdfjsPath: string = "/node_modules/pdfjs-dist/build/pdf.min.mjs";
    const pdfjs = (await import(/* @vite-ignore */ pdfjsPath)) as unknown as PdfjsLike;
    const opts = pdfjs.GlobalWorkerOptions;
    opts.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs";

    const arrayBuffer = await file.arrayBuffer();
    // pdfjs v4 stalls during render if these aren't set — it waits for
    // standard font data that's never delivered.
    const loadingTask = pdfjs.getDocument({
      data: arrayBuffer,
      cMapUrl: "/node_modules/pdfjs-dist/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/node_modules/pdfjs-dist/standard_fonts/",
      useSystemFonts: false,
    });
    const pdf = await raceTimeout(
      loadingTask.promise,
      30_000,
      "PDF parse timed out after 30 s",
    );

    // Canvas needs to be in DOM during render — pdfjs v4 waits on font face
    // events that never fire for detached canvases.
    const offscreen = document.createElement("div");
    offscreen.style.cssText =
      "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
    document.body.appendChild(offscreen);
    try {
      const pages: { num: number; dataUrl: string }[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        offscreen.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await raceTimeout(
          page.render({ canvasContext: ctx, viewport }).promise,
          20_000,
          `PDF page ${i} render timed out after 20 s`,
        );
        pages.push({ num: i, dataUrl: canvas.toDataURL("image/png") });
      }
      return pages;
    } finally {
      offscreen.remove();
    }
  }

  async function uploadFiles(
    files: FileList | null,
    source: StageAttachment["source"],
  ) {
    if (!files || files.length === 0 || !form) return;
    setPhotoError(null);
    setUploading(true);
    try {
      const accepted: StageAttachment[] = [];
      let pdfToPick: { file: File; pages: { num: number; dataUrl: string }[] } | null = null;

      for (const file of Array.from(files)) {
        const isImage = file.type.startsWith("image/");
        const isVideo = file.type.startsWith("video/");
        const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

        // Size caps: 8 MB images, 100 MB videos, 25 MB PDFs
        const cap = isVideo ? 100 * 1024 * 1024 : isPdf ? 25 * 1024 * 1024 : 8 * 1024 * 1024;
        // Same refusal copy as the attachment surfaces, with this route's own cap: names the
        // real size, the limit, and what to do next. "skipped" said none of those.
        const refusal = oversizeRefusalMessage(file, cap);
        if (refusal) {
          setPhotoError(refusal);
          continue;
        }

        if (isImage || isVideo) {
          // P5 §5.4 — persist through the Storage-backed endpoint (the pre-P5
          // flow stashed base64 data-URIs in local state and lost them on
          // refresh). Sequential per-file POSTs, matching the existing loop;
          // a server rejection surfaces in photoError without killing the batch.
          // One probe, used twice: it is shipped as metadata AND shown to the user. The row
          // goes on screen with its size first, then gains the clip length and any nudge,
          // and only then do the bytes move - so the guidance precedes the upload rather
          // than narrating it.
          const key = `stage-upload-${file.name}-${file.size}-${String(selectionSeq++)}`;
          setUploadSelections((prev) => [
            ...prev,
            { key, file, durationSeconds: null, status: 'selected', loaded: 0, total: undefined },
          ]);
          // `.catch` for the same reason as the other probe call sites: a duration is a
          // nicety and must not be able to take the upload down with it. Here the await sits
          // inside uploadFiles' outer try, so a rejection would abort the whole BATCH - every
          // remaining file in the pick - and strand this row at 'selected'.
          const probed = isVideo ? await probeVideoDuration(file).catch(() => null) : null;
          const durationSeconds = probed ?? undefined;
          setUploadSelections((prev) =>
            prev.map((sel) =>
              sel.key === key
                ? { ...sel, durationSeconds: probed, status: 'uploading' }
                : sel,
            ),
          );
          const fd = new FormData();
          fd.append("file", file);
          fd.append("caption", file.name);
          if (source) fd.append("source", source);
          if (durationSeconds != null) {
            fd.append("durationSeconds", String(Math.round(durationSeconds)));
          }
          try {
            const res = await uploadAttachment.mutateAsync({
              stageId: form.id,
              form: fd,
              onUploadProgress: (e) =>
                setUploadSelections((prev) =>
                  prev.map((sel) =>
                    sel.key === key ? { ...sel, loaded: e.loaded, total: e.total } : sel,
                  ),
                ),
            });
            accepted.push(res.attachment);
          } catch (err) {
            setPhotoError(`"${file.name}": ${extractApiError(err, "upload failed")}`);
          } finally {
            setUploadSelections((prev) => prev.filter((sel) => sel.key !== key));
          }
        } else if (isPdf) {
          // Only one PDF picker at a time — if multiple PDFs are selected,
          // queue the first and warn for the rest.
          if (pdfToPick) {
            setPhotoError(
              `Multiple PDFs selected — only "${pdfToPick.file.name}" will open the page picker. Upload the others separately.`,
            );
            continue;
          }
          const pages = await renderPdfPages(file);
          pdfToPick = { file, pages };
        } else {
          setPhotoError(
            `"${file.name}" is not an image, video, or PDF — skipped.`,
          );
        }
      }

      if (accepted.length > 0) {
        setForm((f) =>
          f ? { ...f, photos: [...(f.photos ?? []), ...accepted] } : f,
        );
        const imgs = accepted.filter((a) => a.kind === "image").length;
        const vids = accepted.filter((a) => a.kind === "video").length;
        const desc = [
          imgs ? `${imgs} photo${imgs === 1 ? "" : "s"}` : null,
          vids ? `${vids} video${vids === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" + ");
        addAudit(
          "attachments",
          String(form.photos?.length ?? 0),
          String((form.photos?.length ?? 0) + accepted.length),
          `${desc} added · source: ${source ?? "unknown"}`,
        );
      }

      if (pdfToPick) {
        // Default selection: all pages selected — picker is opt-OUT.
        setPdfPicker({
          fileName: pdfToPick.file.name,
          pages: pdfToPick.pages,
          selected: new Set(pdfToPick.pages.map((p) => p.num)),
        });
      }
    } catch (err) {
      setPhotoError(
        `Upload failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    } finally {
      setUploading(false);
    }
  }

  async function commitPdfSelection() {
    if (!pdfPicker || !form) return;
    const selectedPages = pdfPicker.pages.filter((p) =>
      pdfPicker.selected.has(p.num),
    );
    if (selectedPages.length === 0) {
      setPdfPicker(null);
      return;
    }
    // P5 §5.4 — each selected page's PNG uploads as its own attachment with
    // pdf-page provenance; the server only ever sees images.
    setPhotoError(null);
    setUploading(true);
    const { uploaded, failed, lastError } = await uploadPdfPages(
      (args) => uploadAttachment.mutateAsync(args),
      form.id,
      pdfPicker.fileName,
      selectedPages,
    );
    setUploading(false);
    if (failed > 0) {
      setPhotoError(
        `${failed} PDF page${failed === 1 ? "" : "s"} failed to upload${lastError ? ` — ${lastError}` : ""}.`,
      );
    }
    if (uploaded.length > 0) {
      setForm((f) =>
        f ? { ...f, photos: [...(f.photos ?? []), ...uploaded] } : f,
      );
      addAudit(
        "attachments",
        String(form.photos?.length ?? 0),
        String((form.photos?.length ?? 0) + uploaded.length),
        `${uploaded.length} PDF page${uploaded.length === 1 ? "" : "s"} from "${pdfPicker.fileName}" added`,
      );
    }
    setPdfPicker(null);
  }

  /**
   * Resolves true only once the attachment is actually gone, so the lightbox caller can close the
   * overlay on success and leave it open - with `photoError` visible behind it - on failure.
   */
  async function removePhoto(photoId: string): Promise<boolean> {
    if (!form) return false;
    const target = form.photos?.find((p) => p.id === photoId);
    if (!target) return false;
    // Server rows (uuid ids) round-trip the DELETE; mock/legacy local `att_*`
    // rows only exist client-side. On failure keep the thumbnail — the server
    // row still exists, pruning it would lie.
    if (SERVER_ID_RE.test(photoId)) {
      try {
        await deleteAttachment.mutateAsync({ stageId: form.id, attachmentId: photoId });
      } catch (err) {
        setPhotoError(
          `Couldn't remove "${target.caption ?? target.id}": ${extractApiError(err, "delete failed")}`,
        );
        return false;
      }
    }
    setForm((f) =>
      f ? { ...f, photos: (f.photos ?? []).filter((p) => p.id !== photoId) } : f,
    );
    addAudit(
      "attachments",
      String(form.photos?.length ?? 0),
      String((form.photos?.length ?? 1) - 1),
      `Removed ${target.kind}: ${target.caption ?? target.id}`,
    );
    return true;
  }

  function handleSave() {
    if (!form) return;
    const merged: JobStage = {
      ...form,
      updatedAt: new Date().toISOString(),
      auditLog: [...(stage?.auditLog ?? []), ...pendingAudit],
    };
    onSave(merged, pendingAudit);
    setEditing(false);
    setPendingAudit([]);
    onClose();
  }

  function cancel() {
    setForm(stage);
    setEditing(false);
    setPendingAudit([]);
  }

  const { received, ordered, pct } = stageProgress(form);
  const tradeTint =
    form.trade === "multi"
      ? "bg-info/10 text-info ring-info/20"
      : tradeColor[form.trade];

  const driverTechs = allTechs.filter(
    (t) => t.role === "field_tech" || t.role === "subcontractor",
  );

  const isDirty = pendingAudit.length > 0;

  // Photo gate — a stage cannot be flipped to "ready_for_pickup" without at
  // least one staging photo. The gate also blocks emailing the pickup ticket
  // once the stage is already in ready_for_pickup with no photos (data drift).
  const photoCount = form.photos?.length ?? 0;
  const needsPhotosToBeReady = form.status === "ready_for_pickup";
  const photoBlock = needsPhotosToBeReady && photoCount === 0;

  return (
    <>
    <Modal
      open={open}
      onClose={async () => {
        // Awaiting here is safe: `open` is parent-controlled, so the Modal stays up while the
        // prompt is answered and only closes once `onClose()` below actually runs.
        if (
          isDirty &&
          !(await confirm({
            title: "Discard your unsaved changes?",
            confirmLabel: "Discard",
            tone: "danger",
          }))
        )
          return;
        cancel();
        onClose();
      }}
      title={`${form.jobNumber} · ${form.customer}`}
      subtitle={`Staging entry · ${received}/${ordered} units received · ${pct}% complete`}
      size="xl"
      footer={
        editing && isInProgress ? (
          // In-progress stage: always-edit mode. Keep the full doc toolbar
          // (Preview / Email / Print) so the operator can still ship or print
          // the ticket while working, and surface Save Changes only when
          // there's something to save. No Cancel button — the Close button +
          // dirty-prompt handles abandonment.
          <>
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Close
            </Button>
            <Button variant="outline" tone="neutral" size="sm"
              type="button"
              onClick={() => setShowStagePreview(true)}
              title="Preview pickup ticket · print · save as PDF"
            >
              <Eye className="h-3.5 w-3.5 text-primary" />
              Preview
            </Button>
            <Button variant="outline" tone="neutral" size="sm"
              type="button"
              onClick={() => setShowEmailCompose(true)}
              disabled={photoBlock}
              title={
                photoBlock
                  ? "This stage is Ready for pickup but has no staging photos — add at least one before emailing the tech."
                  : "Email this pickup ticket"
              }
            >
              <Mail className="h-3.5 w-3.5 text-primary" />
              Email
            </Button>
            <Button variant="outline" tone="neutral" size="sm"
              type="button"
              onClick={() => setShowStagePreview(true)}
              title="Open preview · then click Save as PDF / Print"
            >
              <Printer className="h-3.5 w-3.5 text-primary" />
              Print / PDF
            </Button>
            <Button size="sm"
              onClick={handleSave}
              disabled={!isDirty || photoBlock}
              title={
                photoBlock
                  ? "Upload at least one staging photo before marking this stage Ready for pickup."
                  : isDirty
                    ? undefined
                    : "No changes to save yet"
              }
            >
              <Save className="h-3.5 w-3.5" />
              Save Changes{isDirty ? ` (${pendingAudit.length})` : ""}
            </Button>
          </>
        ) : editing ? (
          // Finished stage that the user opted into editing via "Edit Stage".
          <>
            <Button variant="outline" size="sm"
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button size="sm"
              onClick={handleSave}
              disabled={!isDirty || photoBlock}
              title={
                photoBlock
                  ? "Upload at least one staging photo before marking this stage Ready for pickup."
                  : undefined
              }
            >
              <Save className="h-3.5 w-3.5" />
              Save Changes ({pendingAudit.length})
            </Button>
          </>
        ) : (
          // Finished stage, read mode (default).
          <>
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Close
            </Button>
            <Button variant="outline" tone="neutral" size="sm"
              type="button"
              onClick={() => setShowStagePreview(true)}
              title="Preview pickup ticket · print · save as PDF"
            >
              <Eye className="h-3.5 w-3.5 text-primary" />
              Preview
            </Button>
            {/* #2043 R4.4 - Email compose POSTs /job-stages/email, update
                Inventory. The other two footer branches (editing) are only
                reachable once canUpdate is true, so this is the one branch a
                read-only requester can land on with an Email button. */}
            {canUpdate && (
              <Button variant="outline" tone="neutral" size="sm"
                type="button"
                onClick={() => setShowEmailCompose(true)}
                disabled={photoBlock}
                title={
                  photoBlock
                    ? "This stage is Ready for pickup but has no staging photos — add at least one before emailing the tech."
                    : "Email this pickup ticket"
                }
              >
                <Mail className="h-3.5 w-3.5 text-primary" />
                Email
              </Button>
            )}
            <Button variant="outline" tone="neutral" size="sm"
              type="button"
              onClick={() => setShowStagePreview(true)}
              title="Open preview · then click Save as PDF / Print"
            >
              <Printer className="h-3.5 w-3.5 text-primary" />
              Print / PDF
            </Button>
            {canUpdate && (
              <Button size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit Stage
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {/* Status bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background-light/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${tradeTint}`}
            >
              {form.trade === "multi" ? "Multi-trade" : form.trade}
            </span>
            {editing ? (
              <SelectField
                aria-label="Stage status"
                value={form.status}
                onValueChange={(v) => {
                  const next = v as StagingStatus;
                  if (next === "ready_for_pickup" && photoCount === 0) {
                    setPhotoError(
                      "Add at least one staging photo before marking this stage Ready for pickup.",
                    );
                    return;
                  }
                  addAudit("status", form.status, next);
                  update("status", next);
                }}
                className="rounded-md border border-border bg-surface-light px-2 py-0.5 text-xs"
                options={[
                  { value: "awaiting", label: "Awaiting all parts" },
                  { value: "partial", label: "Partial — items pending" },
                  { value: "complete", label: "All parts in" },
                  {
                    value: "ready_for_pickup",
                    label: `Ready for pickup ${photoCount === 0 ? "— photo required" : ""}`.trim(),
                    disabled: photoCount === 0,
                  },
                  { value: "delivered", label: "Delivered to tech" },
                ]}
              />
            ) : (
              <StatusBadge domain="stage" status={form.status} />
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-sm font-semibold text-text-primary">
                {received}
              </span>
              <span className="text-xs text-text-secondary">/ {ordered}</span>
              <span className="text-[10px] text-text-secondary">received</span>
            </div>
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
              <div
                className={[
                  "h-full transition-all",
                  pct === 100
                    ? "bg-success"
                    : pct >= 50
                      ? "bg-warning"
                      : pct > 0
                        ? "bg-warning/15"
                        : "bg-secondary-dark",
                ].join(" ")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] font-medium text-text-secondary">
              {pct}%
            </span>
          </div>
        </div>

        {/* Three-column overview */}
        <div className="grid grid-cols-12 gap-3">
          {/* Job + Site */}
          <div className="col-span-5 rounded-md border border-success/20 bg-success/10 p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success">
              <Briefcase className="h-3 w-3" />
              Job
            </p>
            <p className="font-mono text-xs font-semibold text-text-primary">
              {form.jobNumber}
            </p>
            <p className="text-sm font-semibold text-text-primary">{form.customer}</p>
            <p className="mt-1 flex items-start gap-1 text-xs text-text-secondary">
              <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" />
              {form.site}
            </p>
            <div className="mt-2 flex items-center gap-1.5 text-xs">
              <Calendar className="h-3 w-3 text-text-secondary" />
              {editing ? (
                <DateTimePicker
                  value={isoToPickerValue(form.scheduledFor, timezone)}
                  onChange={(val) => {
                    const v = pickerValueToIso(val, timezone) ?? "";
                    addAudit(
                      "scheduledFor",
                      form.scheduledFor ?? "—",
                      v || "—",
                    );
                    update("scheduledFor", v || undefined);
                  }}
                  inputClassName="h-7 px-2 py-0.5 text-xs"
                />
              ) : form.scheduledFor ? (
                <span className="text-text-secondary">
                  {formatInstant(form.scheduledFor, timezone, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              ) : (
                <span className="text-text-secondary">Not scheduled</span>
              )}
            </div>
          </div>

          {/* Assigned tech */}
          <div className="col-span-4 rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              <User className="h-3 w-3" />
              Assigned Tech
            </p>
            {editing ? (
              <SelectField
                aria-label="Assigned tech"
                value={form.assignedTechId ?? "NONE"}
                onValueChange={(v) => {
                  const t = v === "NONE" ? undefined : driverTechs.find((x) => x.id === v);
                  addAudit(
                    "assignedTech",
                    form.assignedTech ?? "Unassigned",
                    t?.name ?? "Unassigned",
                  );
                  setForm((f) =>
                    f
                      ? {
                          ...f,
                          assignedTechId: t?.id,
                          assignedTech: t?.name,
                        }
                      : f,
                  );
                }}
                className="w-full rounded-md border border-border bg-surface-light px-2 py-1 text-sm"
                options={[
                  { value: "NONE", label: "Unassigned" },
                  ...driverTechs.map((t) => ({
                    value: t.id,
                    label: `${t.name} · ${t.primaryTrade}`,
                  })),
                ]}
              />
            ) : (
              <p className="text-sm font-semibold text-text-primary">
                {form.assignedTech ?? "Unassigned"}
              </p>
            )}
            {(() => {
              const tech = allTechs.find((t) => t.id === form.assignedTechId);
              if (!tech) return null;
              return (
                <>
                  <p className="text-[11px] text-text-secondary">
                    {tech.branch}
                    {tech.primaryTrade ? ` · ${tech.primaryTrade}` : ""}
                  </p>
                  {tech.vehicle && (
                    <p className="text-[11px] text-text-secondary">🚐 {tech.vehicle}</p>
                  )}
                </>
              );
            })()}
          </div>

          {/* Location / Pickup */}
          <div className="col-span-3 rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              <Package className="h-3 w-3" />
              Staged At
            </p>
            {editing ? (
              <SelectField
                value={form.stagedLocationId || "NONE"}
                onValueChange={(v) => {
                  const val = v === "NONE" ? "" : v;
                  const oldName =
                    locations.find((l) => l.id === form.stagedLocationId)
                      ?.name ?? "—";
                  const newName =
                    locations.find((l) => l.id === val)?.name ?? "—";
                  addAudit("stagedLocation", oldName, newName);
                  update("stagedLocationId", val || undefined);
                }}
                aria-label="Staged at"
                className="w-full border px-2 py-1 text-sm"
                options={stagedLocationOptions}
              />
            ) : (
              <p className="text-sm font-semibold text-text-primary">
                {locations.find((l) => l.id === form.stagedLocationId)?.name ??
                  "—"}
              </p>
            )}
            {form.pickupVendorId && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-primary">
                <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" />
                Pickup:{" "}
                {allVendors.find((v) => v.id === form.pickupVendorId)?.name}
              </p>
            )}
          </div>
        </div>

        {/* Staging attachments — required before status can flip to Ready for pickup */}
        <div
          className={[
            "rounded-md border p-3",
            photoBlock
              ? "border-danger/20 bg-danger/10"
              : photoCount > 0
                ? "border-success/20 bg-success/10"
                : "border-border bg-surface-light",
          ].join(" ")}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                <Camera className="h-3 w-3" />
                Staging attachments ({photoCount})
                <span className="ml-1 rounded-full bg-danger/10 px-1.5 py-0 text-[9px] font-bold text-danger ring-1 ring-danger/20">
                  required before "Ready for pickup"
                </span>
              </p>
            </div>
            {/* #2043 R4.3 - attachment upload rides POST /job-stages/:id/
                attachments (update Inventory). A writer with an un-started
                edit still sees these disabled with the "Click Edit Stage"
                hint (unchanged); a read-only requester has no Edit Stage
                button to click, so the whole row - buttons, hidden inputs,
                and their now-inapplicable hint - is gated instead of merely
                disabled. */}
            {canUpdate && (
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Take photo — opens rear camera on phone via capture="environment".
                    Button's own disabled:opacity-50 replaces the raw's manual
                    disabled look (bg-background-light text-text-secondary);
                    shadow-sm dropped (HARD, banned in className). */}
                <Button variant="solid" tone="brand" size="3xs"
                  type="button"
                  disabled={!editing || uploading}
                  onClick={() => takePhotoInputRef.current?.click()}
                  title={
                    editing
                      ? "Take a photo with your camera (phone: rear camera; desktop: webcam or file picker)"
                      : "Click Edit Stage to add attachments"
                  }
                  className="gap-1"
                >
                  <Camera className="h-3 w-3" />
                  Take photo
                </Button>
                {/* Record video — opens camera in video mode on phone */}
                <Button variant="solid" tone="brand" size="3xs"
                  type="button"
                  disabled={!editing || uploading}
                  onClick={() => recordVideoInputRef.current?.click()}
                  title={
                    editing
                      ? "Record a video with your camera (phone: opens video mode)"
                      : "Click Edit Stage to add attachments"
                  }
                  className="gap-1"
                >
                  <Video className="h-3 w-3" />
                  Record video
                </Button>
                {/* Upload from files — accepts photo / video / PDF.
                    Deferred: no outline+brand tone is minted (only
                    outline/neutral and outline/danger exist). */}
                <button
                  type="button"
                  disabled={!editing || uploading}
                  onClick={() => uploadFileInputRef.current?.click()}
                  title={
                    editing
                      ? "Upload from your device: photos, videos, or PDFs (PDFs open a page picker so you can attach individual pages)"
                      : "Click Edit Stage to add attachments"
                  }
                  className={[
                    "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold shadow-sm transition",
                    editing && !uploading
                      ? "border-primary/30 bg-surface-light text-primary hover:bg-primary-subtle"
                      : "cursor-not-allowed border-border bg-background-light text-text-secondary",
                  ].join(" ")}
                >
                  {uploading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Upload className="h-3 w-3" />
                  )}
                  {uploading ? "Processing…" : "Upload file"}
                </button>
                <Input
                  ref={takePhotoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  disabled={!editing}
                  onChange={(e) => {
                    void uploadFiles(e.target.files, "camera");
                    e.currentTarget.value = "";
                  }}
                  className="hidden"
                />
                <Input
                  ref={recordVideoInputRef}
                  type="file"
                  accept="video/*"
                  capture="environment"
                  disabled={!editing}
                  onChange={(e) => {
                    void uploadFiles(e.target.files, "camera");
                    e.currentTarget.value = "";
                  }}
                  className="hidden"
                />
                <Input
                  ref={uploadFileInputRef}
                  type="file"
                  accept="image/*,video/*,application/pdf"
                  multiple
                  disabled={!editing}
                  onChange={(e) => {
                    void uploadFiles(e.target.files, "upload");
                    e.currentTarget.value = "";
                  }}
                  className="hidden"
                />
              </div>
            )}
          </div>

          {/* #2043 Lead UI-pass residual - these capture instructions describe
              the Take photo / Record video / Upload file buttons, which are
              already gated on canUpdate just above; without the buttons the
              instructions have nothing to point at, so hide them too. */}
          {canUpdate && (
            <p className="mb-2 text-[10px] text-text-secondary">
              Photos, videos, and PDF pages all count. From phone: tap{" "}
              <strong>Take photo</strong> or <strong>Record video</strong> to use the
              camera directly. From desktop: drop in a PDF and pick which pages to attach.
            </p>
          )}

          {photoBlock && (
            <div className="mb-2 flex items-start gap-1.5 rounded-md border border-danger/20 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span>
                This stage is marked <strong>Ready for pickup</strong> but has no
                attachments. Upload at least one photo, video, or PDF page before
                saving or emailing the tech.
              </span>
            </div>
          )}

          <UploadSelectionList items={uploadSelections} className="mb-2" />
          {photoError && (
            <div className="mb-2 flex items-start gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span>{photoError}</span>
              {/* Deferred: small close-X affordance inside an alert banner. */}
              <button
                type="button"
                onClick={() => setPhotoError(null)}
                className="ml-auto rounded p-0.5 text-warning hover:bg-warning/10"
                aria-label="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {photoCount === 0 ? (
            <EmptyState density="flush"
              title={
                editing
                  ? "No attachments yet. Snap a photo, record a short clip, or attach a PDF (e.g. packing slip) so the tech knows what they're picking up."
                  : "No attachments yet."
              }
             
            />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {(form.photos ?? []).map((p) => (
                <div
                  key={p.id}
                  className="group relative overflow-hidden rounded-md border border-border bg-surface-light"
                >
                  {/* Deferred: photo-gallery grid tile — a list/gallery click
                      target, not Button-shaped. */}
                  <button
                    type="button"
                    onClick={() => setLightboxPhoto(p)}
                    className="relative block aspect-[4/3] w-full overflow-hidden bg-text-primary/5"
                    title={p.kind === "video" ? "Play video" : "View full size"}
                  >
                    {p.kind === "video" ? (
                      <>
                        <video
                          src={p.dataUrl}
                          className="h-full w-full object-contain"
                          muted
                          preload="metadata"
                        />
                        <span className="absolute inset-0 flex items-center justify-center bg-scrim/30 transition group-hover:bg-scrim/40">
                          <Play className="h-8 w-8 fill-on-fill text-on-fill drop-shadow" />
                        </span>
                      </>
                    ) : (
                      <UploadedImage
                        src={p.dataUrl}
                        alt={p.caption ?? "Staging attachment"}
                        backdrop
                        className="h-full w-full"
                        imgClassName="transition group-hover:scale-105"
                      />
                    )}
                    {p.source === "pdf-page" && (
                      <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-primary/90 px-1.5 py-0 text-[9px] font-bold uppercase text-on-fill">
                        <FileText className="h-2.5 w-2.5" />
                        PDF p.{p.pdfPageNumber}
                      </span>
                    )}
                    {p.kind === "video" && p.durationSeconds != null && (
                      <span className="absolute bottom-1 right-1 rounded bg-scrim/70 px-1 py-0 font-mono text-[9px] text-on-fill">
                        {formatDuration(p.durationSeconds)}
                      </span>
                    )}
                  </button>
                  <div className="border-t border-border px-1.5 py-1">
                    <p className="truncate text-[10px] font-medium text-text-secondary">
                      {p.caption ?? p.id}
                    </p>
                    <p className="truncate text-[9px] text-text-secondary">
                      {p.uploadedBy} ·{" "}
                      {new Date(p.uploadedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                      {p.poNumber ? ` · ${p.poNumber}` : ""}
                    </p>
                  </div>
                  {/* Deferred: small close-X affordance overlaid on a thumbnail card. */}
                  {editing && (
                    <button
                      type="button"
                      onClick={() => void removePhoto(p.id)}
                      className="absolute right-1 top-1 rounded-md bg-surface-light/90 p-1 text-danger opacity-0 shadow ring-1 ring-danger/20 transition group-hover:opacity-100 hover:bg-danger/10"
                      title="Remove attachment"
                      aria-label="Remove attachment"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notes */}
        <div className="rounded-md border border-border bg-surface-light p-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            Notes
          </p>
          {editing ? (
            <Textarea
              value={form.notes ?? ""}
              onChange={(e) => {
                update("notes", e.target.value);
              }}
              onBlur={() => {
                if ((form.notes ?? "") !== (stage.notes ?? "")) {
                  addAudit(
                    "notes",
                    stage.notes ?? "—",
                    form.notes?.slice(0, 60) ?? "—",
                  );
                }
              }}
              rows={2}
              className="w-full resize-none px-2 py-1.5"
            />
          ) : (
            <p className="text-sm italic text-text-secondary">
              {form.notes ?? "No notes."}
            </p>
          )}
        </div>

        {/* Line items */}
        <div className="rounded-md border border-border bg-surface-light p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            Line items ({form.items.length})
          </p>
          <div className="space-y-1.5">
            {form.items.map((it, idx) => {
              const remaining = it.qtyOrdered - it.qtyReceived;
              const done = remaining === 0;
              return (
                <div
                  key={it.id}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-md border border-border bg-background-light/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-[10px] text-text-secondary">
                        {it.itemSku}
                      </code>
                      {it.serialized && (
                        <span className="rounded-full bg-primary-subtle px-1.5 py-0 text-[9px] font-medium text-primary ring-1 ring-primary/20">
                          serialized
                        </span>
                      )}
                    </div>
                    <p className="truncate text-sm font-medium text-text-primary">
                      {it.itemName}
                    </p>
                    <p className="text-[10px] text-text-secondary">
                      {it.vendor} ·{" "}
                      {/* Deferred: font-mono (SOFT) signals "this is a code" —
                          the frozen SOFT ratchet has no slack to restore it
                          after conversion, and dropping it would silently lose
                          the PO-number data-typography cue. Left raw. */}
                      <button
                        type="button"
                        onClick={() => setPreviewPONumber(it.poNumber)}
                        className="inline-flex items-center gap-0.5 rounded px-1 py-0 font-mono font-semibold text-primary hover:bg-primary-subtle hover:underline"
                        title="Preview PO as PDF · print"
                      >
                        <Eye className="h-2.5 w-2.5" />
                        {it.poNumber}
                      </button>
                      {it.expectedDate && !done && (
                        <span className="ml-1 text-warning">
                          · ETA{" "}
                          {formatExactDay(it.expectedDate, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    {editing ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min="0"
                          max={it.qtyOrdered}
                          value={it.qtyReceived}
                          onChange={(e) => {
                            const newVal = Math.max(
                              0,
                              Math.min(
                                it.qtyOrdered,
                                parseInt(e.target.value, 10) || 0,
                              ),
                            );
                            if (newVal !== it.qtyReceived) {
                              addAudit(
                                `items[${idx}].qtyReceived`,
                                String(it.qtyReceived),
                                String(newVal),
                                `${it.itemSku}`,
                              );
                              setForm((f) =>
                                f
                                  ? {
                                      ...f,
                                      items: f.items.map((x, i) =>
                                        i === idx
                                          ? { ...x, qtyReceived: newVal }
                                          : x,
                                      ),
                                    }
                                  : f,
                              );
                            }
                          }}
                          className="w-14 px-1 py-0.5 text-right"
                        />
                        <span className="font-mono text-xs text-text-secondary">
                          / {it.qtyOrdered}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1 font-mono text-xs">
                        <span
                          className={
                            done ? "text-success" : "text-warning"
                          }
                        >
                          {it.qtyReceived}
                        </span>
                        <span className="text-text-secondary">
                          / {it.qtyOrdered}
                        </span>
                        <span className="text-[10px] text-text-secondary">
                          {it.uom}
                        </span>
                      </div>
                    )}
                    {!done && (
                      <p className="mt-0.5 flex items-center justify-end gap-0.5 text-[10px] text-warning">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {remaining} backordered
                      </p>
                    )}
                    {done && (
                      <p className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-success">
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        Complete
                      </p>
                    )}
                  </div>
                  {/* Deferred: no outline+success cell is minted, and this is
                      a small inline table-row action. #2043 R4.2 - !editing
                      is also the read-only requester's state, so this needs
                      its own update Inventory gate or it flips INTO existence
                      for them. */}
                  {!editing && !done && canUpdate && (
                    <button
                      onClick={() => onReceiveOne(form.id, it.id)}
                      className="rounded-md border border-success/20 bg-success/10 px-2 py-1 text-xs font-semibold text-success hover:bg-success/10"
                    >
                      Receive +1
                    </button>
                  )}
                  {(editing || done || !canUpdate) && <span />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Activity / Audit feed */}
        <div className="rounded-md border border-border bg-background-light/40 p-3">
          <p className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            <History className="h-3 w-3" />
            Activity ({auditEntries.length})
          </p>
          {auditEntries.length === 0 ? (
            <p className="text-xs text-text-secondary">
              No changes recorded yet. Edits made here are timestamped + logged
              to the hash-chain audit log on save.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {auditEntries.map((entry) => {
                const isPending = pendingAudit.some((p) => p.id === entry.id);
                return (
                  <li
                    key={entry.id}
                    className={[
                      "flex gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                      isPending
                        ? "border-primary/20 bg-primary-subtle/40"
                        : "border-border bg-surface-light",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "mt-0.5 inline-block h-2 w-2 flex-shrink-0 rounded-full",
                        isPending
                          ? "bg-primary"
                          : entry.field === "status"
                            ? "bg-success"
                            : "bg-text-secondary",
                      ].join(" ")}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-text-primary">
                        <strong>{entry.actorName}</strong>
                        {entry.field === "stage" ? (
                          <> {entry.newValue} the stage</>
                        ) : (
                          <>
                            {" "}
                            changed{" "}
                            <code className="rounded bg-background-light px-1 py-0.5 font-mono text-[10px]">
                              {entry.field}
                            </code>
                            {entry.oldValue !== undefined && (
                              <>
                                {" "}from <em className="text-text-secondary">
                                  "{entry.oldValue}"
                                </em>
                              </>
                            )}{" "}
                            to{" "}
                            <em className="text-text-secondary">
                              "{entry.newValue}"
                            </em>
                          </>
                        )}
                        {isPending && (
                          <span className="ml-1 rounded-full bg-primary px-1.5 py-0 text-[9px] font-bold text-on-fill">
                            unsaved
                          </span>
                        )}
                      </p>
                      {entry.comment && (
                        <p className="text-[10px] text-text-secondary">
                          {entry.comment}
                        </p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[10px] text-text-secondary">
                      {formatRelative(entry.at)}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </Modal>

    <POPreviewDialog
      open={!!previewPONumber}
      onClose={() => setPreviewPONumber(null)}
      poNumber={previewPONumber}
      lockEscape
    />

    <StagePreviewDialog
      open={showStagePreview}
      onClose={() => setShowStagePreview(false)}
      stage={form}
      lockEscape
      onSendEmail={() => {
        setShowStagePreview(false);
        setShowEmailCompose(true);
      }}
    />

    <EmailComposeDialog
      open={showEmailCompose}
      onClose={() => setShowEmailCompose(false)}
      stage={form}
      lockEscape
      onSent={({ to }) => {
        if (stage && onEmailSent) onEmailSent(stage, to);
      }}
    />

    <AttachmentLightbox
      url={lightboxPhoto?.dataUrl ?? null}
      kind={lightboxPhoto?.kind}
      mimeType={lightboxPhoto?.mimeType}
      caption={lightboxPhoto?.caption}
      // The original inline lightbox packed poNumber/pdf provenance into the same
      // metadata line as uploadedBy + date — AttachmentLightbox's `uploadedBy` slot
      // is a free-form string, so that provenance is folded in here rather than
      // growing the shared component's prop surface for staging-specific detail.
      uploadedBy={
        lightboxPhoto
          ? [
              lightboxPhoto.uploadedBy,
              lightboxPhoto.poNumber,
              lightboxPhoto.source === "pdf-page" && lightboxPhoto.pdfFileName
                ? `${lightboxPhoto.pdfFileName} (p.${lightboxPhoto.pdfPageNumber})`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      uploadedAt={lightboxPhoto?.uploadedAt}
      // A staging attachment is not a generic Attachment row - it has no `file_url`/`file_name`,
      // and `dataUrl` is either a short-lived signed URL or, for legacy rows, the whole base64
      // payload. So the download goes through the URL-only helper, named from the caption and
      // given its extension by `mimeType`; `downloadFileNameFromUrl` refuses to mine a `data:`
      // URL for a name, which would otherwise make the save-as name the entire payload.
      onDownload={
        lightboxPhoto
          ? () =>
              void downloadFromUrl(lightboxPhoto.dataUrl, {
                name: lightboxPhoto.caption,
                mimeType: lightboxPhoto.mimeType,
              })
          : undefined
      }
      // Gated on `editing`, matching the thumbnail's own trash button, and no confirm for the
      // same reason: this dialog's convention is that edit mode IS the guard. Adding a prompt
      // only in the lightbox would make the two controls behave differently on one surface.
      onDelete={
        editing && lightboxPhoto
          ? () => {
              const id = lightboxPhoto.id;
              void removePhoto(id).then((removed) => {
                if (removed) setLightboxPhoto((cur) => (cur?.id === id ? null : cur));
              });
            }
          : undefined
      }
      deleting={deleteAttachment.isPending}
      onClose={() => setLightboxPhoto(null)}
    />

    {pdfPicker && (
      // Raw Dialog/DialogContent (not <Modal lockEscape>) because this picker must ALSO
      // block backdrop-click-to-dismiss, matching its original inline-overlay behavior
      // (no onClick-backdrop handler, no Escape listener — Cancel is the only way out).
      // Modal's `lockEscape` only guards `onEscapeKeyDown`; it has no equivalent for
      // Radix's default click-outside dismiss, so that guard is added here directly.
      // `onOpenChange` is a no-op for the same reason — open state is fully controlled by
      // `pdfPicker`/`setPdfPicker`, never by Radix's own dismiss plumbing.
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          className="flex max-h-[90vh] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 [&>button]:hidden"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
            <div>
              <DialogTitle asChild>
                <Heading level={3} className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  Pick pages from "{pdfPicker.fileName}"
                </Heading>
              </DialogTitle>
              <DialogDescription asChild>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {pdfPicker.pages.length} page{pdfPicker.pages.length === 1 ? "" : "s"} ·{" "}
                  {pdfPicker.selected.size} selected. Selected pages are attached as
                  images.
                </p>
              </DialogDescription>
            </div>
            {/* Deferred: icon-only dialog close-X affordance. */}
            <button
              type="button"
              onClick={() => setPdfPicker(null)}
              className="rounded-md p-1 text-text-secondary hover:bg-background-light"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center justify-between border-b border-border bg-background-light/50 px-4 py-2 text-xs">
            <div className="flex gap-2">
              {/* outline/neutral's idle text inherits ambient (this toolbar
                  sets no text colour) rather than the raw's explicit
                  text-secondary — the primitive's established trade-off. */}
              <Button variant="outline" tone="neutral" size="3xs"
                type="button"
                onClick={() =>
                  setPdfPicker((p) =>
                    p
                      ? { ...p, selected: new Set(p.pages.map((x) => x.num)) }
                      : p,
                  )
                }
              >
                Select all
              </Button>
              <Button variant="outline" tone="neutral" size="3xs"
                type="button"
                onClick={() =>
                  setPdfPicker((p) => (p ? { ...p, selected: new Set() } : p))
                }
              >
                Clear
              </Button>
            </div>
            <span className="text-[11px] text-text-secondary">
              Click a page to toggle.
            </span>
          </div>

          <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3 md:grid-cols-4">
            {pdfPicker.pages.map((pg) => {
              const isSelected = pdfPicker.selected.has(pg.num);
              return (
                // Deferred: selectable page-grid tile (toggle state, image +
                // caption) — not Button-shaped.
                <button
                  key={pg.num}
                  type="button"
                  onClick={() =>
                    setPdfPicker((p) => {
                      if (!p) return p;
                      const next = new Set(p.selected);
                      if (next.has(pg.num)) next.delete(pg.num);
                      else next.add(pg.num);
                      return { ...p, selected: next };
                    })
                  }
                  className={[
                    "group relative overflow-hidden rounded-md border-2 bg-surface-light text-left transition",
                    isSelected
                      ? "border-primary ring-2 ring-primary/20"
                      : "border-border hover:border-primary/40",
                  ].join(" ")}
                >
                  <img
                    src={pg.dataUrl}
                    alt={`Page ${pg.num}`}
                    className="aspect-[1/1.3] w-full object-contain"
                  />
                  <div
                    className={[
                      "flex items-center justify-between border-t px-2 py-1 text-[11px] font-medium",
                      isSelected
                        ? "border-primary/20 bg-primary-subtle text-primary"
                        : "border-border bg-background-light text-text-secondary",
                    ].join(" ")}
                  >
                    <span>Page {pg.num}</span>
                    {isSelected ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-full border border-border" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border bg-background-light/40 px-4 py-3">
            <Button variant="outline" size="sm"
              type="button"
              onClick={() => setPdfPicker(null)}
            >
              Cancel
            </Button>
            <Button size="sm"
              type="button"
              onClick={() => void commitPdfSelection()}
              disabled={pdfPicker.selected.size === 0 || uploading}
            >
              <Plus className="h-3.5 w-3.5" />
              Attach {pdfPicker.selected.size} page
              {pdfPicker.selected.size === 1 ? "" : "s"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )}
    {confirmDialog}
    </>
  );
}

function raceTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
