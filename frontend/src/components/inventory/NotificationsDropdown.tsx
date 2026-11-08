// Bell-icon dropdown surfacing every inventory state that needs attention —
// low stock · backorder · staging ready / missing area · POs partially
// received. The bell badge shows the live total; the panel groups alerts by
// kind, sorted freshest-first within each group.
//
// Per PRD §7.4.A / §5.4.A — see lib/inventory/inventory-alerts.ts for the
// data reduction. UI is read-only in v1 (no per-row jump action yet); a
// follow-up rev wires each row to its target page / dialog.
//
// ALPHA port: counts compute from the live seam hooks (useInventoryItems /
// useLocations / usePurchaseOrders / useJobStages) rather than module-load
// seed imports, and the "navigate to this alert" intent is emitted through
// the Zustand `useInventoryAlertStore` (replaces Emanuel's module-level
// `alert-bus` pub/sub).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  MapPin,
  Package,
  Truck,
  X,
} from "lucide-react";
import {
  useInventoryItems,
  useLocations,
  usePurchaseOrders,
  useJobStages,
} from "@/lib/api/inventory";
import {
  computeInventoryAlerts,
  groupAlerts,
  relativeShort,
  severityCounts,
  type InventoryAlert,
  type InventoryAlertKind,
} from "@/lib/inventory/inventory-alerts";
import { useInventoryAlertStore } from "@/stores/inventory-alert.store";
import { Button } from "@/components/ui/button";

const KIND_ICON: Record<InventoryAlertKind, typeof Bell> = {
  backorder: Package,
  low_stock: AlertTriangle,
  staging_no_area: MapPin,
  po_partial: Truck,
  staging_ready: CheckCircle2,
};

const KIND_TINT: Record<
  InventoryAlertKind,
  { ring: string; bg: string; text: string; dot: string }
> = {
  backorder: {
    ring: "ring-danger/20",
    bg: "bg-danger/10",
    text: "text-danger",
    dot: "bg-danger",
  },
  low_stock: {
    ring: "ring-warning/20",
    bg: "bg-warning/10",
    text: "text-warning",
    dot: "bg-warning",
  },
  staging_no_area: {
    ring: "ring-warning/20",
    bg: "bg-warning/10",
    text: "text-warning",
    dot: "bg-warning",
  },
  po_partial: {
    ring: "ring-info/20",
    bg: "bg-info/10",
    text: "text-info",
    dot: "bg-info",
  },
  staging_ready: {
    ring: "ring-success/20",
    bg: "bg-success/10",
    text: "text-success",
    dot: "bg-success",
  },
};

export function NotificationsDropdown() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Live inventory state from the seam — counts recompute as data refetches.
  const { data: items = [] } = useInventoryItems();
  const { data: locations = [] } = useLocations();
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: jobStages = [] } = useJobStages();

  const emit = useInventoryAlertStore((s) => s.emit);

  const alerts = useMemo<InventoryAlert[]>(
    () =>
      computeInventoryAlerts({
        items,
        locations,
        purchaseOrders,
        jobStages,
      }),
    [items, locations, purchaseOrders, jobStages],
  );
  const groups = useMemo(() => groupAlerts(alerts), [alerts]);
  const counts = useMemo(() => severityCounts(alerts), [alerts]);
  const total = alerts.length;
  const badge = total > 9 ? "9+" : String(total);

  // Outside click + Esc close.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const badgeTone =
    counts.critical > 0
      ? "bg-notify"
      : counts.warning > 0
        ? "bg-warning"
        : counts.info > 0
          ? "bg-success"
          : "bg-secondary";

  return (
    <div ref={rootRef} className="relative">
      {/* Dropped on conversion: the `open`-state ring/background highlight
          (bg-background-light ring-1 ring-primary/30) — Button has no
          "active" modifier and the layering guard bans a HARD ring/bg class
          on a governed component's className. Idle + hover reproduce exactly
          via ghost/subtle; the open-state cue is disclosed as dropped.
          className="h-8 w-8" restores the raw's ~32px geometry over the
          "icon" rung's 40px default - width/height is LAYOUT, not
          appearance, so this is a real fix, not a disclosed drop. */}
      <Button variant="ghost" tone="subtle" size="icon"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          total === 0
            ? "Inventory alerts — all clear"
            : `${total} inventory ${total === 1 ? "alert" : "alerts"}`
        }
        className="relative h-8 w-8"
      >
        <Bell className="h-4 w-4" />
        {total > 0 && (
          <span
            className={[
              // ring-surface-light, not ring-on-fill: this halo punches the badge
              // out of the SURFACE behind it, so it has to track that surface and
              // flip with it under the dark theme, not track the badge's own fill.
              "absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold text-on-fill ring-2 ring-surface-light",
              badgeTone,
            ].join(" ")}
          >
            {badge}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Inventory alerts"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-[380px] max-w-[calc(100vw-24px)] overflow-hidden rounded-card border border-border bg-surface-light shadow-xl"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2 border-b border-border bg-background-light/60 px-3 py-2.5">
            <div>
              <p className="text-[12px] font-semibold text-text-primary">
                Inventory needs attention
              </p>
              <p className="mt-0.5 text-[10px] text-text-secondary">
                {total === 0
                  ? "Nothing on the queue right now."
                  : `${total} ${total === 1 ? "item" : "items"} across ${groups.length} ${
                      groups.length === 1 ? "category" : "categories"
                    }`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {counts.critical > 0 && (
                <SeverityChip tone="rose" count={counts.critical} label="critical" />
              )}
              {counts.warning > 0 && (
                <SeverityChip tone="amber" count={counts.warning} label="warning" />
              )}
              {counts.info > 0 && (
                <SeverityChip tone="emerald" count={counts.info} label="info" />
              )}
              {/* Deferred: small icon-only close-X affordance inside the panel
                  header, the excluded shape — left raw. */}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="ml-1 rounded p-1 text-text-secondary hover:bg-border hover:text-text-primary"
                aria-label="Close alerts"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[480px] overflow-y-auto">
            {total === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <CheckCircle2 className="h-7 w-7 text-success" />
                <p className="text-[12px] font-semibold text-text-primary">All clear</p>
                <p className="text-[11px] text-text-secondary">
                  No low stock, no backorders, and every staging job is squared away.
                </p>
              </div>
            ) : (
              groups.map((g) => {
                const Icon = KIND_ICON[g.kind];
                const tint = KIND_TINT[g.kind];
                return (
                  <section key={g.kind} className="border-b border-border last:border-b-0">
                    <header
                      className={[
                        "flex items-center justify-between gap-2 px-3 py-1.5",
                        tint.bg,
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon className={["h-3.5 w-3.5", tint.text].join(" ")} />
                        <p className={["text-[11px] font-semibold uppercase tracking-wide", tint.text].join(" ")}>
                          {g.label}
                        </p>
                      </div>
                      <span
                        className={[
                          "rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1",
                          tint.bg,
                          tint.text,
                          tint.ring,
                        ].join(" ")}
                      >
                        {g.alerts.length}
                      </span>
                    </header>
                    <ul className="divide-y divide-border">
                      {g.alerts.map((a) => (
                        <li
                          key={a.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            emit(a);
                            setOpen(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              emit(a);
                              setOpen(false);
                            }
                          }}
                          className="group flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-primary/5 focus:bg-primary/5 focus:outline-none"
                          title={
                            a.at
                              ? `Open · ${new Date(a.at).toLocaleString('en-US')}`
                              : "Open"
                          }
                        >
                          <span
                            className={[
                              "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                              tint.dot,
                            ].join(" ")}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12px] font-medium text-text-primary group-hover:text-primary">
                              {a.title}
                            </p>
                            <p className="truncate text-[10.5px] text-text-secondary">
                              {a.subtitle}
                            </p>
                          </div>
                          {a.at && (
                            <span className="ml-2 inline-flex shrink-0 items-center gap-0.5 text-[9.5px] text-text-secondary">
                              <Clock className="h-2.5 w-2.5" />
                              {relativeShort(a.at)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border bg-background-light/60 px-3 py-1.5">
            <p className="text-[9px] text-text-secondary">
              Live view · updates as inventory state changes
            </p>
            {/* Deferred: 10px footer utility link with no fixed height —
                the smallest Button rung (3xs, h-6) would visibly grow this
                compact footer bar, and no ghost/link tone reproduces the
                primary-tinted hover background. Left raw. */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SeverityChip({
  tone,
  count,
  label,
}: {
  tone: "rose" | "amber" | "emerald";
  count: number;
  label: string;
}) {
  const cls =
    tone === "rose"
      ? "bg-danger/10 text-danger ring-danger/20"
      : tone === "amber"
        ? "bg-warning/10 text-warning ring-warning/20"
        : "bg-success/10 text-success ring-success/20";
  return (
    <span
      title={`${count} ${label} ${count === 1 ? "alert" : "alerts"}`}
      className={[
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ring-1",
        cls,
      ].join(" ")}
    >
      {count}
    </span>
  );
}
