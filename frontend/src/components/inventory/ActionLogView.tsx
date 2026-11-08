/**
 * ActionLogView — the filterable stock-movements ledger (Inventory P5 §2,
 * QA-705). Server-side filters (type / item / location / actor / date) over
 * GET /api/inventory/movements' {data,meta} envelope, with server-joined
 * display names (from/to location, job number, invoice number).
 *
 * Cost column: `unitCost` is present ONLY when the server didn't cost-strip
 * (canSeePricing) — the column renders only when at least one row carries it.
 * CSV export snapshots the currently-filtered view (one limit=100 page, the
 * same current-view semantics as the Stock page's handleExport).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import api from "@/lib/axios";
import {
  useMovements,
  useInventoryItems,
  useLocations,
  useTechs,
} from "@/lib/api/inventory";
import type { Movement, MovementFilters, MovementType, PaginationMeta } from "@/lib/api/inventory";
import { SelectField } from "@/components/form/SelectField";
import { DatePicker } from "@/components/form/DatePicker";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { formatCurrency } from "@/lib/utils";
import { toCSV, downloadCSV } from "@/lib/inventory/csv";

const PAGE_SIZE = 25;

const TYPE_OPTIONS: { value: MovementType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "receive", label: "Receive" },
  { value: "consume", label: "Consume" },
  { value: "return", label: "Return" },
  { value: "transfer", label: "Transfer" },
  { value: "adjust", label: "Adjust" },
];

/** Verb → token-tinted pill (matches the item-panel dot colors). */
const TYPE_PILL: Record<MovementType, string> = {
  receive: "bg-success/10 text-success ring-success/20",
  consume: "bg-danger/10 text-danger ring-danger/20",
  transfer: "bg-info/10 text-info ring-info/20",
  return: "bg-primary-subtle text-primary ring-primary/30",
  adjust: "bg-warning/10 text-warning ring-warning/20",
};

/** Decimal-safe qty: signed for `adjust`, up to 2 decimals. */
function fmtQty(m: Movement): string {
  const abs = Number.isInteger(m.qty) ? String(m.qty) : m.qty.toFixed(2);
  if (m.type === "adjust" && m.qty > 0) return `+${abs}`;
  return abs;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ActionLogView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const logisticOrderId = searchParams.get("lo") ?? undefined;

  const [type, setType] = useState<MovementType | "all">("all");
  const [itemId, setItemId] = useState<string>("all");
  const [locationId, setLocationId] = useState<string>("all");
  const [actorUserId, setActorUserId] = useState<string>("all");
  const [occurredFrom, setOccurredFrom] = useState("");
  const [occurredTo, setOccurredTo] = useState("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const filters = useMemo<MovementFilters>(
    () => ({
      type: type === "all" ? undefined : type,
      itemId: itemId === "all" ? undefined : itemId,
      locationId: locationId === "all" ? undefined : locationId,
      actorUserId: actorUserId === "all" ? undefined : actorUserId,
      occurredFrom: occurredFrom || undefined,
      occurredTo: occurredTo || undefined,
      logisticOrderId,
    }),
    [type, itemId, locationId, actorUserId, occurredFrom, occurredTo, logisticOrderId],
  );

  const movementsQuery = useMovements({ ...filters, page, limit: PAGE_SIZE });
  // Pickers — the ≤100-item window is acceptable for a filter dropdown (P5 §2.2).
  const { data: items = [] } = useInventoryItems();
  const { data: locations = [] } = useLocations();
  const { data: techs = [] } = useTechs();

  const rows = movementsQuery.data?.data ?? [];
  const meta: PaginationMeta | undefined = movementsQuery.data?.meta;
  const hasCost = rows.some((m) => m.unitCost != null);

  function resetPage() {
    setPage(1);
  }

  // The LO filter can also change via a row link or Back navigation (not just
  // the dismiss chip / filter controls, which already call resetPage()) — keep
  // page in sync whenever it changes so a stale page 2+ doesn't strand the
  // user on an empty result set.
  useEffect(() => {
    resetPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logisticOrderId]);

  async function handleExport() {
    setExporting(true);
    try {
      // Current-view semantics: same filters, one capped snapshot page.
      const res = await api.get("/api/inventory/movements", {
        params: {
          type: filters.type,
          item_id: filters.itemId,
          location_id: filters.locationId,
          logistic_order_id: filters.logisticOrderId,
          actor_user_id: filters.actorUserId,
          occurred_from: filters.occurredFrom,
          occurred_to: filters.occurredTo,
          page: 1,
          limit: 100,
        },
      });
      const exportRows = (res.data as { data: Movement[] }).data ?? [];
      const withCost = exportRows.some((m) => m.unitCost != null);
      const csv = toCSV(
        exportRows.map((m) => ({
          time: m.occurredAt,
          type: m.type,
          sku: m.itemSku,
          item: m.itemName,
          qty: m.qty,
          from: m.fromLocationName ?? m.fromLocationId ?? "",
          to: m.toLocationName ?? m.toLocationId ?? "",
          job: m.jobNumber ?? "",
          invoice: m.invoiceNumber ?? "",
          actor: m.actor,
          reference: m.reference,
          ...(withCost ? { unitCost: m.unitCost ?? "" } : {}),
        })),
      );
      downloadCSV(csv, `stock-activity-${new Date().toISOString().slice(0, 10)}.csv`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
                header comment, "NOT COVERED, DELIBERATELY"). */}
            <Heading>Activity</Heading>
            <p className="mt-0.5 text-sm text-text-secondary">
              Every stock movement — receive, consume, return, transfer, adjust
              {meta ? ` · ${meta.total} total` : ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExport()}
            disabled={exporting || rows.length === 0}
          >
            <Download className="h-4 w-4 text-text-secondary" />
            Export CSV
          </Button>
        </div>

        {/* Filter row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="w-40">
            <SelectField
              aria-label="Filter by type"
              value={type}
              onValueChange={(v) => {
                setType(v as MovementType | "all");
                resetPage();
              }}
              options={TYPE_OPTIONS}
            />
          </div>
          <div className="w-56">
            <SelectField
              aria-label="Filter by item"
              value={itemId}
              onValueChange={(v) => {
                setItemId(v);
                resetPage();
              }}
              options={[
                { value: "all", label: "All items" },
                ...items.map((i) => ({ value: i.id, label: `${i.sku} · ${i.name}` })),
              ]}
            />
          </div>
          <div className="w-48">
            <SelectField
              aria-label="Filter by location"
              value={locationId}
              onValueChange={(v) => {
                setLocationId(v);
                resetPage();
              }}
              options={[
                { value: "all", label: "All locations" },
                ...locations.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
          </div>
          <div className="w-48">
            <SelectField
              aria-label="Filter by actor"
              value={actorUserId}
              onValueChange={(v) => {
                setActorUserId(v);
                resetPage();
              }}
              options={[
                { value: "all", label: "All actors" },
                ...techs.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-text-secondary">
            <DatePicker
              aria-label="From date"
              value={occurredFrom}
              max={occurredTo || undefined}
              onChange={(v) => {
                setOccurredFrom(v);
                resetPage();
              }}
              inputClassName="h-9 px-2"
            />
            <span>to</span>
            <DatePicker
              aria-label="To date"
              value={occurredTo}
              min={occurredFrom || undefined}
              onChange={(v) => {
                setOccurredTo(v);
                resetPage();
              }}
              inputClassName="h-9 px-2"
            />
          </div>
        </div>
      </div>

      {logisticOrderId && (
        <div className="flex items-center gap-2 px-6 py-2">
          <span className="inline-flex items-center gap-2 rounded-control border border-border bg-primary-subtle px-3 py-1 text-sm text-text-primary">
            Filtered to {rows[0]?.logisticOrderNumber ?? "one Logistic Order"}
            {/* Raw by design: a close-X affordance inside a filter chip, not
                Button-shaped. */}
            <button
              type="button"
              aria-label="Clear Logistic Order filter"
              className="text-text-secondary hover:text-text-primary"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("lo");
                setSearchParams(next, { replace: true });
                resetPage();
              }}
            >
              ×
            </button>
          </span>
        </div>
      )}

      <div className="p-6">
        <div className="overflow-x-auto rounded-card border border-border bg-surface-light shadow-card">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                <th className="border-b-2 border-border px-4 py-2">Time</th>
                <th className="border-b-2 border-border px-4 py-2">Type</th>
                <th className="border-b-2 border-border px-4 py-2">Item</th>
                <th className="border-b-2 border-border px-4 py-2 text-right">Qty</th>
                <th className="border-b-2 border-border px-4 py-2">From → To</th>
                <th className="border-b-2 border-border px-4 py-2">Job</th>
                <th className="border-b-2 border-border px-4 py-2">Invoice</th>
                <th className="border-b-2 border-border px-4 py-2">Actor</th>
                <th className="border-b-2 border-border px-4 py-2">Reference</th>
                {hasCost && (
                  <th className="border-b-2 border-border px-4 py-2 text-right">Cost</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((m) => (
                <tr key={m.id} className="hover:bg-background-light">
                  <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                    {fmtTime(m.occurredAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1 ${TYPE_PILL[m.type]}`}
                    >
                      {m.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <code className="font-mono text-[11px] text-text-secondary">{m.itemSku}</code>
                    <p className="truncate font-medium text-text-primary">{m.itemName}</p>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-text-primary">{fmtQty(m)}</td>
                  <td className="px-4 py-2.5 text-text-secondary">
                    {m.fromLocationName ?? (m.fromLocationId ? "…" : "—")}
                    {" → "}
                    {m.toLocationName ?? (m.toLocationId ? "…" : "—")}
                  </td>
                  <td className="px-4 py-2.5">
                    {m.jobId ? (
                      <Link to={`/jobs/${m.jobId}`} className="font-medium text-primary hover:underline">
                        {m.jobNumber ?? "Job"}
                      </Link>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                    {m.logisticOrderId && m.logisticOrderId !== logisticOrderId && (
                      <Link
                        to={`/inventory/activity?lo=${m.logisticOrderId}`}
                        className="mt-0.5 block font-mono text-[11px] text-text-secondary hover:text-primary hover:underline"
                      >
                        {m.logisticOrderNumber ?? "Logistic Order"}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {m.invoiceId ? (
                      <Link
                        to={`/invoices/${m.invoiceId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {m.invoiceNumber ?? "Invoice"}
                      </Link>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-text-primary">{m.actor}</td>
                  <td className="max-w-[220px] truncate px-4 py-2.5 text-text-secondary">
                    {m.reference}
                  </td>
                  {hasCost && (
                    <td className="px-4 py-2.5 text-right font-mono text-text-primary">
                      {m.unitCost != null ? formatCurrency(m.unitCost) : "—"}
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={hasCost ? 10 : 9}
                    className="px-6 py-16 text-center text-sm text-text-secondary"
                  >
                    <EmptyState
                      title={
                        movementsQuery.isLoading
                          ? "Loading activity…"
                          : "No movements match these filters."
                      }
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {meta && meta.totalPages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm text-text-secondary">
            <Button
              variant="outline"
              size="3xs"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="3xs"
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page >= meta.totalPages}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
