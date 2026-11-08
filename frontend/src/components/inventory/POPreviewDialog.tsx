import { useEffect, useMemo, useState } from "react";
import { Building2, Download, FileText, Printer, RotateCcw } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { extractApiError, formatCurrency, formatPhone } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import { usePurchaseOrders, useUpdatePO, useVendors, type PurchaseOrder } from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import { lineHasCost, lineTotal, lineUnitCost } from "@/lib/inventory/po-money";
import { useAuthStore } from "@/stores/auth.store";
import { SignatureField } from "@/components/inventory/SignatureField";
import { fmtSignedAt, signatureImageDataUrl, type SignatureValue } from "@/lib/inventory/signatures";
import { useScheduleTimezone } from "@/lib/schedule-tz";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { STATUS_INTENT_CLASSES, STATUS_REGISTRY } from "@/design-system/status-registry";

type Props = {
  open: boolean;
  onClose: () => void;
  // Either pass a PO object directly, OR pass a PO number / id to look up.
  po?: PurchaseOrder | null;
  poNumber?: string | null;
  poId?: string | null;
  lockEscape?: boolean;
  /** Optional Modal z-index — accepted for prop-API parity when this dialog
   *  is opened from inside another dialog. The Modal adapter manages stacking
   *  itself, so it is intentionally not wired. */
  zIndex?: number;
};

const fmtMoney = formatCurrency;

function fmtDate(iso?: string | null): string {
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

/** The persisted buyer signature as the document shows it. */
type PersistedSignature = { data: string; name: string; at: string | null };

function persistedSignatureOf(po: PurchaseOrder | null): PersistedSignature | null {
  if (!po?.signatureData) return null;
  return { data: po.signatureData, name: po.signatureName ?? "", at: po.signatureAt ?? null };
}

export function POPreviewDialog({
  open,
  onClose,
  po: poProp,
  poNumber,
  poId,
  lockEscape,
  zIndex,
}: Props) {
  // zIndex is accepted for prop-API parity with the prototype; the Modal
  // adapter manages stacking itself, so it is intentionally not wired.
  void zIndex;

  // ─── Seam data ───
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allVendors = [] } = useVendors();
  const { data: org } = useOrganization();
  const tz = useScheduleTimezone();
  const updatePO = useUpdatePO();
  const brand = org?.name ?? "ServWave";

  // ─── Current user (ALPHA auth store) ───
  // Identity for the buyer signature block comes from the logged-in user.
  const authUser = useAuthStore((s) => s.user);
  const currentUser = useMemo(
    () => ({
      id: authUser?.id ?? "",
      name: authUser ? `${authUser.first_name} ${authUser.last_name}`.trim() : "",
    }),
    [authUser],
  );

  // Resolve PO from any of the three input shapes. A PO passed as an object is
  // a snapshot from the caller's state; when the list query holds the same PO,
  // the list wins so a signature saved here is reflected after the refetch.
  const po: PurchaseOrder | null = useMemo(() => {
    if (poProp) return purchaseOrders.find((p) => p.id === poProp.id) ?? poProp;
    if (poId) return purchaseOrders.find((p) => p.id === poId) ?? null;
    if (poNumber)
      return (
        purchaseOrders.find(
          (p) => p.poNumber.toLowerCase() === poNumber.toLowerCase(),
        ) ?? null
      );
    return null;
  }, [poProp, poId, poNumber, purchaseOrders]);

  const vendor = useMemo(() => {
    if (!po) return undefined;
    return (
      (po.vendorId ? allVendors.find((v) => v.id === po.vendorId) : undefined) ??
      allVendors.find((v) => v.name === po.vendor)
    );
  }, [po, allVendors]);

  // "Deliver to" is the company address from Settings (verdict §6) — never a branch.
  const deliverTo = useMemo(() => {
    const cityLine = [
      [org?.city, org?.state].filter(Boolean).join(", "),
      org?.postal_code,
    ]
      .filter(Boolean)
      .join(" ");
    const lines = [org?.address_line1, org?.address_line2, cityLine].filter(
      (l): l is string => !!l && l.trim().length > 0,
    );
    return lines;
  }, [org?.address_line1, org?.address_line2, org?.city, org?.state, org?.postal_code]);

  // One money rule (S3.2): line cost, then the linked catalog item's cost, then
  // $0 — shared with the grid, CSV, detail dialog and vendor spend. `unit` is
  // null only when neither source has a price, and the cell prints "—".
  const enrichedLines = useMemo(() => {
    if (!po) return [];
    return po.lines.map((l) => ({
      ...l,
      unit: lineHasCost(l) ? lineUnitCost(l) : null,
      ext: lineTotal(l),
    }));
  }, [po]);

  const subtotal = enrichedLines.reduce((s, l) => s + l.ext, 0);
  const total = subtotal; // D6: PO is tax-exclusive

  // Buyer signature persists on the PO (PATCH signatureData/signatureName; the
  // server stamps the time). The vendor signature is a blank line on paper —
  // ServWave never sends a PO, so nothing is signed remotely.
  //
  // `sigOverride` carries the server's answer until the caller's PO snapshot
  // catches up. It is keyed by PO id so switching documents reads the new PO
  // instead of a stale answer (no reset effect needed).
  const [sigOverride, setSigOverride] = useState<{ poId: string; value: PersistedSignature | null } | null>(null);
  const signature =
    sigOverride && po && sigOverride.poId === po.id ? sigOverride.value : persistedSignatureOf(po);

  function handleSign(sig: SignatureValue) {
    if (!po) return;
    const poId = po.id;
    const signatureData = signatureImageDataUrl(sig.fullName);
    updatePO.mutate(
      { id: poId, signatureData, signatureName: sig.fullName },
      {
        onSuccess: ({ purchaseOrder }) =>
          setSigOverride({
            poId,
            value: persistedSignatureOf(purchaseOrder) ?? {
              data: signatureData,
              name: sig.fullName,
              at: sig.signedAt,
            },
          }),
        onError: (err) =>
          toast({
            title: "Signature not saved",
            description: extractApiError(err, "Could not save the signature on this PO"),
            variant: "destructive",
          }),
      },
    );
  }

  function handleClearSignature() {
    if (!po) return;
    const poId = po.id;
    updatePO.mutate(
      { id: poId, signatureData: null },
      {
        onSuccess: () => setSigOverride({ poId, value: null }),
        onError: (err) =>
          toast({
            title: "Signature not cleared",
            description: extractApiError(err, "Could not clear the signature on this PO"),
            variant: "destructive",
          }),
      },
    );
  }

  // Inject scoped print CSS only while this dialog is open
  useEffect(() => {
    if (!open) return;
    const style = document.createElement("style");
    style.id = "po-print-style";
    style.textContent = `
      @media print {
        body * { visibility: hidden !important; }
        .po-print-root, .po-print-root * { visibility: visible !important; }
        .po-print-root {
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
        .po-print-hide { display: none !important; }
        @page { size: Letter; margin: 0; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById("po-print-style");
      if (el) el.remove();
    };
  }, [open]);

  if (!po) {
    if (!open) return null;
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={`Purchase Order · ${poNumber ?? poId ?? "—"}`}
        subtitle="PO not found in the local price book"
        size="md"
        lockEscape={lockEscape}
        footer={
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Close
          </Button>
        }
      >
        <div className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          The requested PO could not be loaded for preview. It may have been
          archived or live in an external system. Try opening it from
          <span className="font-mono"> Inventory → Purchase Orders</span>.
        </div>
      </Modal>
    );
  }

  function handlePrint() {
    // Browser print dialog includes "Save as PDF" — same path
    window.print();
  }

  const statusEntry = STATUS_REGISTRY.purchaseOrder[po.status];
  const whenLine = po.orderedAt ? `ordered ${fmtDate(po.orderedAt)}` : `created ${fmtDate(po.createdAt)}`;
  const notes = po.notes?.trim() ?? "";
  const orgContact = [org?.phone ? formatPhone(org.phone) : null, org?.email ?? null]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={`Purchase Order · ${po.poNumber}`}
      subtitle={`${po.vendor} · ${po.lines.length} line${po.lines.length === 1 ? "" : "s"} · ${whenLine}`}
      size="xl"
      lockEscape={lockEscape}
      footer={
        <div className="po-print-hide flex w-full items-center justify-between">
          <p className="text-[11px] text-text-secondary">
            Browser print dialog includes <span className="font-medium text-text-primary">"Save as PDF"</span> as a destination.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Close
            </Button>
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
      <div className="po-print-root rounded-md border border-border bg-surface-light p-6 text-[13px] leading-snug text-text-primary">
        {/* Document header — the company, not a branch */}
        <div className="flex items-start justify-between gap-6 border-b border-border pb-4">
          <div className="flex items-start gap-3">
            {org?.logo_url ? (
              <img
                src={org.logo_url}
                alt={`${brand} logo`}
                className="h-10 w-10 rounded-lg object-contain"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-on-fill">
                <Building2 className="h-5 w-5" />
              </div>
            )}
            <div>
              <div className="text-sm font-semibold text-text-primary">{brand}</div>
              {orgContact && (
                <div className="text-[11px] text-text-secondary">{orgContact}</div>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Purchase Order
            </div>
            <div className="font-mono text-2xl font-bold text-text-primary">
              {po.poNumber}
            </div>
            <span
              data-testid="po-status-chip"
              className={[
                // `border` (width) is required here: STATUS_INTENT_CLASSES supplies
                // only the border COLOUR, and Tailwind preflight zeroes the width.
                "mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                STATUS_INTENT_CLASSES[statusEntry?.intent ?? "neutral"],
              ].join(" ")}
            >
              {statusEntry?.label ?? po.status}
            </span>
          </div>
        </div>

        {/* Vendor + Deliver to */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div data-testid="po-vendor-block">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Vendor
            </div>
            <div className="mt-1 font-semibold text-text-primary">{po.vendor}</div>
            {vendor?.category && (
              <div className="text-[11px] text-text-secondary">{vendor.category}</div>
            )}
            <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-text-secondary">
              {vendor?.contactPersonName && (
                <>
                  <span>Contact</span>
                  <span className="text-text-primary">{vendor.contactPersonName}</span>
                </>
              )}
              {vendor?.contactPhone && (
                <>
                  <span>Phone</span>
                  <span className="text-text-primary">{formatPhone(vendor.contactPhone)}</span>
                </>
              )}
              {vendor?.contactEmail && (
                <>
                  <span>Email</span>
                  <span className="text-text-primary">{vendor.contactEmail}</span>
                </>
              )}
              {vendor?.accountNumber && (
                <>
                  <span>Acct #</span>
                  <span className="font-mono text-text-primary">{vendor.accountNumber}</span>
                </>
              )}
            </div>
          </div>
          <div data-testid="po-deliver-to">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Deliver to
            </div>
            <div className="mt-1 font-semibold text-text-primary">{brand}</div>
            {deliverTo.length > 0 ? (
              deliverTo.map((line) => (
                <div key={line} className="text-[12px] text-text-primary">
                  {line}
                </div>
              ))
            ) : (
              <div className="mt-1 rounded-md border border-warning/20 bg-warning/10 px-2 py-1 text-[11px] text-warning">
                Set your company address in Settings
              </div>
            )}
            {po.jobNumber && (
              <div className="mt-2 inline-block rounded-md border border-primary/30 bg-primary-subtle/60 px-2.5 py-1.5 text-[11px] text-primary">
                <div className="font-semibold">For Job · {po.jobNumber}</div>
                {po.customer && <div>{po.customer}</div>}
                {po.site && <div className="text-primary/80">{po.site}</div>}
              </div>
            )}
          </div>
        </div>

        {/* Meta strip */}
        <div
          data-testid="po-meta"
          className="mt-4 grid grid-cols-4 gap-3 rounded-md bg-background-light px-3 py-2 text-[11px]"
        >
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              Created
            </div>
            <div className="text-text-primary">{fmtDate(po.createdAt)}</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              Ordered
            </div>
            <div className="text-text-primary">{fmtDate(po.orderedAt)}</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              Expected
            </div>
            <div className="text-text-primary">{fmtDay(po.expectedDate)}</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              Trade
            </div>
            <div className="text-text-primary capitalize">{po.trade ?? "—"}</div>
          </div>
        </div>

        {/* Line items */}
        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-background-light text-[10px] uppercase tracking-wider text-text-secondary">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-semibold">#</th>
                <th className="px-2.5 py-1.5 text-left font-semibold">SKU</th>
                <th className="px-2.5 py-1.5 text-left font-semibold">Description</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Qty</th>
                <th className="px-2.5 py-1.5 text-center font-semibold">UoM</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Unit Cost</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Line Total</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Recv'd</th>
              </tr>
            </thead>
            <tbody>
              {enrichedLines.map((l, idx) => (
                <tr key={idx} className="border-t border-border align-top">
                  <td className="px-2.5 py-1.5 text-text-secondary">{idx + 1}</td>
                  <td className="px-2.5 py-1.5 font-mono text-[11px] text-text-primary">
                    {l.itemSku}
                  </td>
                  <td className="px-2.5 py-1.5 text-text-primary">{l.itemName}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-text-primary">
                    {l.qtyOrdered}
                  </td>
                  <td className="px-2.5 py-1.5 text-center font-mono text-[11px] text-text-secondary">
                    {l.uom}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-text-primary">
                    {l.unit != null ? fmtMoney(l.unit) : "—"}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono font-semibold text-text-primary">
                    {fmtMoney(l.ext)}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-text-secondary">
                    {l.qtyReceived} / {l.qtyOrdered}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="mt-3 flex justify-end">
          <div className="w-72 space-y-1 text-[12px]">
            <div className="flex justify-between text-text-secondary">
              <span>Subtotal</span>
              <span className="font-mono">{fmtMoney(subtotal)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold text-text-primary">
              <span>Total</span>
              <span className="font-mono">{fmtMoney(total)}</span>
            </div>
          </div>
        </div>

        {/* Notes to the vendor — printed only when there is something to say */}
        {notes && (
          <div className="mt-4 rounded-md border border-border bg-background-light px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Notes to the vendor
            </div>
            <div className="mt-1 whitespace-pre-wrap text-[12px] text-text-primary">{notes}</div>
          </div>
        )}

        {/* Signatures — the buyer signs in-app and it persists on the PO; the vendor line is blank on paper. */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
          {signature ? (
            <div data-testid="po-buyer-signature" className="relative">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                Authorized By
              </div>
              <img
                src={signature.data}
                alt="Buyer signature"
                className="mt-1 h-14 max-w-full object-contain object-left"
              />
              <div className="border-b border-secondary-dark" />
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-text-secondary">
                <span className="font-medium text-text-primary">{signature.name}</span>
                {signature.at && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{fmtSignedAt(signature.at, tz)}</span>
                  </>
                )}
              </div>
              <Button variant="outline" tone="neutral" size={null}
                type="button"
                onClick={handleClearSignature}
                disabled={updatePO.isPending}
                className="po-print-hide absolute -right-1 -top-1 gap-0.5 px-1.5 py-0.5"
                title="Clear the signature on this PO"
              >
                <RotateCcw className="h-2.5 w-2.5" />
                Clear
              </Button>
            </div>
          ) : (
            <SignatureField
              role="Authorized By"
              signerId={currentUser.id || undefined}
              defaultName={currentUser.name}
              signerLabel={currentUser.name || "Authorized Buyer"}
              currentUser={{ id: currentUser.id, name: currentUser.name }}
              value={null}
              onSign={handleSign}
            />
          )}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Vendor signature / date
            </div>
            <div className="mt-6 border-b border-secondary-dark" />
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t border-border pt-3 text-[10px] text-text-secondary">
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {brand} · {po.poNumber} · Generated {fmtDate(new Date().toISOString())}
          </span>
          <span>Page 1 of 1</span>
        </div>
      </div>
    </Modal>
    </>
  );
}
