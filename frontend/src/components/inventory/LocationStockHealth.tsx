import type React from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  MapPin,
  PackagePlus,
  Truck,
  Warehouse,
} from "lucide-react";
import type { Item, Location } from "@/lib/api/inventory";
import type { LocationType } from "@/lib/api/_mock/inventory";

type Props = {
  items: Item[];
  locations: Location[];
  activeLocationId: string;        // "all" or a specific location id
  onSelectLocation: (id: string) => void;
  onRestockLocation?: (locationId: string) => void;
};

type Severity = "green" | "yellow" | "red";

function locTypeIcon(type: LocationType | undefined, cls: string) {
  if (type === "warehouse") return <Warehouse className={cls} />;
  if (type === "truck") return <Truck className={cls} />;
  if (type === "counter") return <Boxes className={cls} />;
  return <MapPin className={cls} />;
}

export function LocationStockHealth({
  items,
  locations,
  activeLocationId,
  onSelectLocation,
  onRestockLocation,
}: Props) {
  // Compute per-location stock health
  const perLocation = locations.map((loc) => {
    const materialItems = items.filter((i) => i.kind === "material");
    let lowCount = 0;
    let criticalCount = 0;
    let worstRatio = Infinity; // onHand / min
    let lowestItem: { sku: string; onHand: number; min: number } | null = null;

    for (const item of materialItems) {
      const s = item.stock.find((x) => x.locationId === loc.id);
      if (!s || s.min == null || s.min === 0) continue;
      if (s.onHand < s.min) {
        lowCount++;
        const ratio = s.min === 0 ? Infinity : s.onHand / s.min;
        if (ratio < 0.5) criticalCount++;
        if (ratio < worstRatio) {
          worstRatio = ratio;
          lowestItem = { sku: item.sku, onHand: s.onHand, min: s.min };
        }
      }
    }

    const severity: Severity =
      criticalCount > 0 ? "red" : lowCount > 0 ? "yellow" : "green";

    return { loc, lowCount, criticalCount, severity, lowestItem };
  });

  // Org-wide rollup
  const totals = perLocation.reduce(
    (acc, p) => ({
      green: acc.green + (p.severity === "green" ? 1 : 0),
      yellow: acc.yellow + (p.severity === "yellow" ? 1 : 0),
      red: acc.red + (p.severity === "red" ? 1 : 0),
    }),
    { green: 0, yellow: 0, red: 0 },
  );

  return (
    <div className="border-b border-border bg-surface-light px-6 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          {/* Raw by design: eyebrow style, no matching Heading variant. */}
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Low-Stock Health by Location
          </h3>
          <p className="text-[11px] text-text-secondary">
            Click a location card to scope the items list to that location.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <LegendDot tint="green" label={`${totals.green} healthy`} />
          <LegendDot tint="yellow" label={`${totals.yellow} watching`} />
          <LegendDot tint="red" label={`${totals.red} critical`} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {perLocation.map((p) => {
          const isActive = activeLocationId === p.loc.id;
          const cfg = sevConfig[p.severity];
          const Icon = cfg.icon;
          const canRestock = p.lowCount > 0 && !!onRestockLocation;
          return (
            <div
              key={p.loc.id}
              className={[
                "relative overflow-hidden rounded-card border transition",
                isActive
                  ? "ring-2 ring-primary ring-offset-1"
                  : "hover:shadow-sm",
                cfg.border,
                cfg.bg,
              ].join(" ")}
            >
              {/* Restock pill — top-right corner; only when below-min items exist.
                  Raw by design: no `success` tone is minted on Button (see
                  button.tsx header note - deferred, zero measured call sites). */}
              {canRestock && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestockLocation!(p.loc.id);
                  }}
                  title={`Create Purchase Order(s) to restock ${p.loc.name}`}
                  className="absolute right-1.5 top-2 z-10 inline-flex items-center gap-0.5 rounded-md bg-success px-1.5 py-0.5 text-[10px] font-semibold text-on-fill shadow-sm hover:bg-success"
                >
                  <PackagePlus className="h-2.5 w-2.5" />
                  Restock
                </button>
              )}

              {/* Raw by design: a card click target selecting a whole location
                  card, not Button-shaped. */}
              <button
                type="button"
                onClick={() => onSelectLocation(p.loc.id)}
                className="block w-full text-left"
              >
              {/* Top accent strip */}
              <div className={`h-1 ${cfg.accent}`} />
              <div className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {locTypeIcon(p.loc.type, `h-3.5 w-3.5 ${cfg.iconColor}`)}
                    <span className="truncate text-xs font-semibold text-text-primary">
                      {p.loc.name}
                    </span>
                  </div>
                  {/* Hide severity icon when Restock pill takes the corner */}
                  {!canRestock && (
                    <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${cfg.iconColor}`} />
                  )}
                </div>

                <div className="flex items-baseline gap-1">
                  <span className={`font-mono text-2xl font-bold ${cfg.textColor}`}>
                    {p.lowCount}
                  </span>
                  <span className="text-[10px] text-text-secondary">
                    {p.lowCount === 1 ? "item below min" : "items below min"}
                  </span>
                </div>

                {p.criticalCount > 0 && (
                  <div className="flex items-center gap-1 text-[10px] font-medium text-danger">
                    <AlertOctagon className="h-2.5 w-2.5" />
                    {p.criticalCount} critical (&lt; 50% of min)
                  </div>
                )}

                {p.lowestItem ? (
                  <div className="text-[10px] text-text-secondary">
                    Worst:{" "}
                    <code className="font-mono text-[9px]">
                      {p.lowestItem.sku.length > 18
                        ? p.lowestItem.sku.slice(0, 17) + "…"
                        : p.lowestItem.sku}
                    </code>{" "}
                    <span className="font-mono">
                      {p.lowestItem.onHand}/{p.lowestItem.min}
                    </span>
                  </div>
                ) : (
                  <div className="text-[10px] font-medium text-success">
                    All items at or above reserve
                  </div>
                )}
              </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const sevConfig: Record<
  Severity,
  {
    border: string;
    bg: string;
    accent: string;
    icon: React.ComponentType<{ className?: string }>;
    iconColor: string;
    textColor: string;
  }
> = {
  green: {
    border: "border-success/20",
    bg: "bg-success/10",
    accent: "bg-success",
    icon: CheckCircle2,
    iconColor: "text-success",
    textColor: "text-success",
  },
  yellow: {
    border: "border-warning/20",
    bg: "bg-warning/10",
    accent: "bg-warning",
    icon: AlertTriangle,
    iconColor: "text-warning",
    textColor: "text-warning",
  },
  red: {
    border: "border-danger/20",
    bg: "bg-danger/10",
    accent: "bg-danger",
    icon: AlertOctagon,
    iconColor: "text-danger",
    textColor: "text-danger",
  },
};

function LegendDot({ tint, label }: { tint: Severity; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-text-secondary">
      <span className={`inline-block h-2 w-2 rounded-full ${sevConfig[tint].accent}`} />
      {label}
    </span>
  );
}
