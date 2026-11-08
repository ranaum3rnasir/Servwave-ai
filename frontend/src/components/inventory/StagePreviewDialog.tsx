import { useEffect, useMemo, useState } from "react";
import { Building2, Camera, CheckCircle2, Clock, Download, FileText, MapPin, Package, Play, Printer, Truck } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { UploadedImage } from "@/components/ui/uploaded-image";
import { formatCurrency } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import {
  useBranches,
  useInventoryItems,
  useLocations,
  useVendors,
  useTechs,
  type JobStage,
} from "@/lib/api/inventory";

// The seam re-exports `JobStage` but not the `StagingStatus` union directly,
// so derive the status type from the JobStage shape (identical union).
type StagingStatus = JobStage["status"];
import { useAuthStore } from "@/stores/auth.store";
import { SignatureField } from "@/components/inventory/SignatureField";
import type { SignatureValue } from "@/lib/inventory/signatures";
import { formatPhone } from "@/lib/utils";
import { useOrganization } from "@/lib/api/organization";
import { Button } from "@/components/ui/button";
import {
  STATUS_INTENT_CLASSES,
  STATUS_REGISTRY,
} from "@/design-system/status-registry";

type Props = {
  open: boolean;
  onClose: () => void;
  stage: JobStage | null;
  shipToBranchId?: string;
  lockEscape?: boolean;
  onSendEmail?: () => void;
};

// Colour comes from STATUS_REGISTRY.stage via STATUS_INTENT_CLASSES; the local
// tone map is gone.
// The labels below still differ from the registry's stage labels ("Awaiting all
// parts" / "Partial - items pending" / "All parts in" / "Ready for pickup" /
// "Delivered to tech"). Adopting the registry wording is a user-facing copy
// change held on escalations E4 (which of the competing vocabularies wins) and
// E2 (the registry's `stage.partial` label still carries an em dash), so this
// map stays until those are adjudicated.
const statusLabel: Record<StagingStatus, string> = {
  awaiting: "Awaiting parts",
  partial: "Partially received",
  complete: "Complete · ready to stage",
  ready_for_pickup: "Ready for tech pickup",
  delivered: "Delivered to job",
};

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// expectedDate is a calendar day, not an instant, so it is read in UTC.
function fmtDay(iso?: string): string {
  if (!iso) return "—";
  return formatExactDay(iso, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const fmtMoney = formatCurrency;

export function StagePreviewDialog({
  open,
  onClose,
  stage,
  shipToBranchId,
  lockEscape,
  onSendEmail,
}: Props) {
  // ─── Seam data ───
  const { data: branches = [] } = useBranches();
  const { data: allItems = [] } = useInventoryItems();
  const { data: allLocations = [] } = useLocations();
  const { data: allVendors = [] } = useVendors();
  const { data: allTechs = [] } = useTechs();
  const { data: org } = useOrganization();
  const brand = org?.name ?? "ServWave";

  // ─── Current user (ALPHA auth store) ───
  // Replaces Emanuel's `currentUser` mock; identity for the signature blocks
  // (tech pickup sign-out + counter manager) comes from the logged-in user.
  const authUser = useAuthStore((s) => s.user);
  const currentUser = useMemo(
    () => ({
      id: authUser?.id ?? "",
      name: authUser ? `${authUser.first_name} ${authUser.last_name}`.trim() : "",
    }),
    [authUser],
  );

  const branch = useMemo(
    () => branches.find((b) => b.id === shipToBranchId) ?? branches[0],
    [shipToBranchId, branches],
  );

  const tech = useMemo(
    () => (stage?.assignedTechId ? allTechs.find((t) => t.id === stage.assignedTechId) : undefined),
    [stage?.assignedTechId, allTechs],
  );

  const pickupVendor = useMemo(
    () => (stage?.pickupVendorId ? allVendors.find((v) => v.id === stage.pickupVendorId) : undefined),
    [stage?.pickupVendorId, allVendors],
  );

  const enrichedLines = useMemo(() => {
    if (!stage) return [];
    return stage.items.map((it) => {
      const itm = allItems.find((i) => i.sku === it.itemSku);
      const unitCost = itm?.unitCost ?? 0;
      return {
        ...it,
        unitCost,
        ext: unitCost * it.qtyOrdered,
        backorder: it.qtyOrdered - it.qtyReceived,
        itemPhoto: itm?.photoUrl,
      };
    });
  }, [stage, allItems]);

  const subtotal = enrichedLines.reduce((s, l) => s + l.ext, 0);

  // Signature state — keyed by stage.id so re-opening the same ticket within
  // a session preserves the signatures. In production these persist on the
  // pickup-ticket record server-side.
  const [techSig, setTechSig] = useState<SignatureValue | null>(null);
  const [mgrSig, setMgrSig] = useState<SignatureValue | null>(null);
  useEffect(() => {
    // Reset when navigating to a different stage.
    setTechSig(null);
    setMgrSig(null);
  }, [stage?.id]);

  // Inject scoped print CSS only while this dialog is open
  useEffect(() => {
    if (!open) return;
    const style = document.createElement("style");
    style.id = "stage-print-style";
    style.textContent = `
      @media print {
        body * { visibility: hidden !important; }
        .stage-print-root, .stage-print-root * { visibility: visible !important; }
        .stage-print-root {
          position: fixed !important;
          inset: 0 !important;
          margin: 0 !important;
          padding: 14mm 16mm !important;
          background: white !important;
          box-shadow: none !important;
          ring-width: 0 !important;
          overflow: visible !important;
          color: rgb(var(--text-primary)) !important;
        }
        .stage-print-hide { display: none !important; }
        @page { size: Letter; margin: 0; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById("stage-print-style");
      if (el) el.remove();
    };
  }, [open]);

  if (!stage) return null;

  function handlePrint() {
    window.print();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Pickup Ticket · ${stage.jobNumber}`}
      subtitle={`${stage.customer} · ${stage.items.length} line${stage.items.length === 1 ? "" : "s"} · ${stage.items.reduce((s, i) => s + i.qtyReceived, 0)}/${stage.items.reduce((s, i) => s + i.qtyOrdered, 0)} units received`}
      size="xl"
      lockEscape={lockEscape}
      footer={
        <div className="stage-print-hide flex w-full items-center justify-between">
          <p className="text-[11px] text-text-secondary">
            Browser print dialog includes <span className="font-medium text-text-primary">"Save as PDF"</span> as a destination.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Close
            </Button>
            {onSendEmail && (
              <Button variant="outline" tone="neutral" size="sm"
                onClick={onSendEmail}
                title="Email this pickup ticket to the tech / customer"
              >
                <FileText className="h-4 w-4 text-primary" />
                Email Ticket
              </Button>
            )}
            <Button variant="outline" tone="neutral" size="sm"
              onClick={handlePrint}
              title="Save as PDF via browser print dialog"
            >
              <Download className="h-4 w-4" />
              Save as PDF
            </Button>
            <Button size="sm"
              onClick={handlePrint}
            >
              <Printer className="h-4 w-4" />
              Print
            </Button>
          </div>
        </div>
      }
    >
      <div className="stage-print-root rounded-md border border-border bg-surface-light p-6 text-[13px] leading-snug text-text-primary">
        {/* Document header */}
        <div className="flex items-start justify-between gap-6 border-b border-secondary-dark pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-on-fill">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                {brand} · {branch?.name ?? "—"}
              </div>
              <div className="text-sm font-semibold text-text-primary">
                {branch?.address ?? "—"}
              </div>
              <div className="text-[11px] text-text-secondary">
                {branch?.phone ? formatPhone(branch.phone) : ""}
                {branch?.managerName ? ` · Manager: ${branch.managerName}` : ""}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Pickup Ticket
            </div>
            <div className="font-mono text-2xl font-bold text-text-primary">
              {stage.jobNumber}
            </div>
            <span
              className={[
                // `border` (width) is required here: STATUS_INTENT_CLASSES supplies
                // only the border COLOUR, and Tailwind preflight zeroes the width.
                // The previous `ring-1` is gone with the tone map that coloured it.
                "mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                STATUS_INTENT_CLASSES[
                  // every StagingStatus has a registry entry; the fallback is
                  // unreachable and exists only for noUncheckedIndexedAccess
                  STATUS_REGISTRY.stage[stage.status]?.intent ?? "neutral"
                ],
              ].join(" ")}
            >
              {statusLabel[stage.status]}
            </span>
          </div>
        </div>

        {/* Job + Tech + Pickup */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="rounded-md border border-border bg-background-light/40 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Job
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-text-primary">
              {stage.jobNumber}
            </div>
            <div className="text-[13px] font-semibold text-text-primary">
              {stage.customer}
            </div>
            <div className="mt-1 flex items-start gap-1 text-[11px] text-text-secondary">
              <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span>{stage.site}</span>
            </div>
            {stage.scheduledFor && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-text-secondary">
                <Clock className="h-3 w-3" />
                <span>{fmtDateTime(stage.scheduledFor)}</span>
              </div>
            )}
            <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-surface-light px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary ring-1 ring-border">
              {stage.trade}
            </div>
          </div>

          <div className="rounded-md border border-border bg-background-light/40 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Assigned Tech
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-text-secondary">
                {(tech?.name ?? stage.assignedTech ?? "??")
                  .split(" ")
                  .map((s) => s[0] ?? "")
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-semibold text-text-primary">
                  {tech?.name ?? stage.assignedTech ?? "Unassigned"}
                </div>
                {tech?.branch && (
                  <div className="text-[11px] text-text-secondary">{tech.branch}</div>
                )}
              </div>
            </div>
            {tech?.vehicle && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-text-secondary">
                <Truck className="h-3 w-3" />
                <span>{tech.vehicle}</span>
              </div>
            )}
            {tech?.primaryTrade && (
              <div className="mt-0.5 text-[11px] text-text-secondary capitalize">
                Primary trade: {tech.primaryTrade}
              </div>
            )}
          </div>

          <div className="rounded-md border border-border bg-background-light/40 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              {pickupVendor ? "Pickup From Vendor" : "Staged At"}
            </div>
            {pickupVendor ? (
              <>
                <div className="mt-0.5 text-sm font-semibold text-text-primary">
                  {pickupVendor.name}
                </div>
                <div className="mt-0.5 text-[11px] text-text-secondary">
                  {stage.pickupAddress ?? pickupVendor.pickupAddress ?? "—"}
                </div>
              </>
            ) : (
              <>
                <div className="mt-0.5 text-sm font-semibold text-text-primary">
                  {allLocations.find((l) => l.id === stage.stagedLocationId)?.name ??
                    "Main Warehouse"}
                </div>
                <div className="mt-0.5 text-[11px] text-text-secondary">
                  {branch?.address ?? "—"}
                </div>
                {stage.stagedArea && (
                  <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-primary-subtle px-1.5 py-0.5 text-[11px] font-semibold text-primary ring-1 ring-primary/30">
                    <MapPin className="h-3 w-3" />
                    {stage.stagedArea}
                  </div>
                )}
              </>
            )}
            <div className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              <FileText className="h-3 w-3" />
              Created {fmtDate(stage.createdAt)}
            </div>
          </div>
        </div>

        {/* Notes */}
        {stage.notes && (
          <div className="mt-4 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              Notes for the picker / driver
            </div>
            <p className="mt-1 text-[12px] italic text-text-secondary">{stage.notes}</p>
          </div>
        )}

        {/* Staging attachments (photos / videos / PDF pages) */}
        {stage.photos && stage.photos.length > 0 && (
          <div className="mt-4 rounded-md border border-border bg-surface-light p-3">
            <div className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              <Camera className="h-3 w-3" />
              Staging attachments ({stage.photos.length})
              {(() => {
                const imgs = stage.photos.filter((p) => p.kind === "image").length;
                const vids = stage.photos.filter((p) => p.kind === "video").length;
                const pdfPages = stage.photos.filter(
                  (p) => p.source === "pdf-page",
                ).length;
                const parts = [
                  imgs ? `${imgs} photo${imgs === 1 ? "" : "s"}` : null,
                  vids ? `${vids} video${vids === 1 ? "" : "s"}` : null,
                  pdfPages
                    ? `${pdfPages} PDF page${pdfPages === 1 ? "" : "s"}`
                    : null,
                ].filter(Boolean);
                return parts.length ? (
                  <span className="ml-1 font-normal normal-case tracking-normal text-text-secondary">
                    · {parts.join(" + ")}
                  </span>
                ) : null;
              })()}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {stage.photos.map((p) => (
                <figure
                  key={p.id}
                  className="relative overflow-hidden rounded-md border border-border bg-background-light/40"
                >
                  {p.kind === "video" ? (
                    <div className="relative">
                      <video
                        src={p.dataUrl}
                        className="aspect-[4/3] w-full object-contain"
                        muted
                        preload="metadata"
                      />
                      <span className="absolute inset-0 flex items-center justify-center bg-scrim/30">
                        <Play className="h-6 w-6 fill-on-fill text-on-fill" />
                      </span>
                    </div>
                  ) : (
                    <UploadedImage
                      src={p.dataUrl}
                      alt={p.caption ?? "Staging attachment"}
                      backdrop
                      className="aspect-[4/3] w-full"
                    />
                  )}
                  {p.source === "pdf-page" && (
                    <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-primary/90 px-1 py-0 text-[8px] font-bold uppercase text-on-fill">
                      <FileText className="h-2 w-2" />
                      p.{p.pdfPageNumber}
                    </span>
                  )}
                  <figcaption className="px-2 py-1">
                    <p className="truncate text-[10px] font-medium text-text-secondary">
                      {p.caption ?? p.id}
                    </p>
                    <p className="truncate text-[9px] text-text-secondary">
                      {p.uploadedBy} · {fmtDate(p.uploadedAt)}
                      {p.poNumber ? ` · ${p.poNumber}` : ""}
                    </p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}

        {/* Line items */}
        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-background-light text-[10px] uppercase tracking-wider text-text-secondary">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-semibold">#</th>
                <th className="px-2.5 py-1.5 text-left font-semibold">SKU</th>
                <th className="px-2.5 py-1.5 text-left font-semibold">Description</th>
                <th className="px-2.5 py-1.5 text-left font-semibold">Vendor · PO</th>
                <th className="px-2.5 py-1.5 text-center font-semibold">UoM</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Ordered</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Received</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Backorder</th>
                <th className="px-2.5 py-1.5 text-center font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {enrichedLines.map((l, idx) => {
                const done = l.backorder === 0;
                return (
                  <tr key={l.id} className="border-t border-border align-top">
                    <td className="px-2.5 py-1.5 text-text-secondary">{idx + 1}</td>
                    <td className="px-2.5 py-1.5 font-mono text-[11px] text-text-primary">
                      {l.itemSku}
                    </td>
                    <td className="px-2.5 py-1.5 text-text-primary">
                      {l.itemName}
                      {l.serialized && (
                        <span className="ml-1 rounded-full bg-primary-subtle px-1 py-0 text-[9px] font-medium text-primary ring-1 ring-primary/30">
                          serialized
                        </span>
                      )}
                      {l.serialized && l.receivedSerials && l.receivedSerials.length > 0 && (
                        <div className="mt-0.5 text-[10px] text-text-secondary">
                          Serials:{" "}
                          <span className="font-mono">{l.receivedSerials.join(", ")}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-[11px] text-text-secondary">
                      <div>{l.vendor}</div>
                      <div className="font-mono text-[10px]">{l.poNumber}</div>
                      {l.expectedDate && !done && (
                        <div className="text-[10px] text-warning">
                          ETA {fmtDay(l.expectedDate)}
                        </div>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-center font-mono text-[11px] text-text-secondary">
                      {l.uom}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-text-primary">
                      {l.qtyOrdered}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono font-semibold text-success">
                      {l.qtyReceived}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono font-semibold text-warning">
                      {l.backorder > 0 ? l.backorder : "—"}
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      {done ? (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-success/10 px-1.5 py-0 text-[10px] font-semibold text-success ring-1 ring-success/20">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          Complete
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/10 px-1.5 py-0 text-[10px] font-semibold text-warning ring-1 ring-warning/20">
                          Backorder
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Totals strip */}
        <div className="mt-3 flex items-center justify-between rounded-md bg-background-light px-3 py-2 text-[12px]">
          <div className="flex items-center gap-4 text-[11px] text-text-secondary">
            <span>
              Lines:{" "}
              <span className="font-mono font-semibold text-text-primary">
                {enrichedLines.length}
              </span>
            </span>
            <span>
              Units received:{" "}
              <span className="font-mono font-semibold text-success">
                {enrichedLines.reduce((s, l) => s + l.qtyReceived, 0)}
              </span>
              {" / "}
              <span className="font-mono text-text-secondary">
                {enrichedLines.reduce((s, l) => s + l.qtyOrdered, 0)}
              </span>
            </span>
            <span>
              Backorder:{" "}
              <span className="font-mono font-semibold text-warning">
                {enrichedLines.reduce((s, l) => s + l.backorder, 0)}
              </span>
            </span>
          </div>
          <div className="text-[11px] text-text-secondary">
            Est. value at cost:{" "}
            <span className="font-mono font-semibold text-text-primary">
              {fmtMoney(subtotal)}
            </span>
          </div>
        </div>

        {/* Signature block — DocuSign-style inline typed signatures. The
            fields are identity-aware: if the logged-in user IS the assigned
            tech or branch manager, their adopted signature auto-fills.
            Otherwise a "Signing as" toggle lets the operator at the counter
            sign either on behalf of the assigned person OR as themselves. */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <SignatureField
            role="Tech Pickup Sign-out"
            signerId={tech?.id ?? `tech_${stage.assignedTech ?? "unknown"}`}
            defaultName={tech?.name ?? stage.assignedTech ?? ""}
            signerLabel={tech?.name ?? stage.assignedTech ?? "Tech"}
            currentUser={{ id: currentUser.id, name: currentUser.name }}
            value={techSig}
            onSign={setTechSig}
            onClear={() => setTechSig(null)}
          />
          <SignatureField
            role="Warehouse / Counter Manager"
            signerId={
              branch?.managerName === currentUser.name
                ? currentUser.id
                : `mgr_${branch?.id ?? "unknown"}`
            }
            defaultName={branch?.managerName ?? currentUser.name}
            signerLabel={branch?.managerName ?? "Manager"}
            currentUser={{ id: currentUser.id, name: currentUser.name }}
            value={mgrSig}
            onSign={setMgrSig}
            onClear={() => setMgrSig(null)}
          />
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t border-border pt-3 text-[10px] text-text-secondary">
          <span className="inline-flex items-center gap-1">
            <Package className="h-3 w-3" />
            {brand} · Pickup ticket {stage.jobNumber} · Generated {fmtDate(new Date().toISOString())}
          </span>
          <span>Page 1 of 1</span>
        </div>
      </div>
    </Modal>
  );
}
