import type React from "react";
import { useState } from "react";
import {
  Boxes,
  Check,
  ChevronDown,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Truck,
  Warehouse,
} from "lucide-react";
import { SearchablePanel, type SearchablePanelRow } from "@/components/ui/searchable-panel";
import type { Item, Location } from "@/lib/api/inventory";
import type { LocationType } from "@/lib/api/_mock/inventory";

type Props = {
  locations: Location[];
  items: Item[];
  activeId: string; // "all" or a location id
  onChange: (id: string) => void;
  onAddNew: () => void;
  /**
   * #2043 - split from a single `canManage` boolean: the footer "Add
   * Location / Van" CTA calls `POST /api/inventory/locations`
   * (`create Inventory`), the per-row pencil calls `PATCH .../locations/:id`
   * (`update Inventory`), and the per-row trash calls `DELETE .../:id`
   * (`delete Inventory`) - three different verbs on the same subject.
   */
  canAdd?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  onEditLocation?: (loc: Location) => void;
  // REQUIRED on purpose, and NOT symmetrical with `onEditLocation` above.
  // This was optional, and the routed Stock page simply never passed it - so
  // the delete affordance silently did not render, with no type error and no
  // failing test. The sole remaining call site (the routed Stock page) passes
  // it; a new one that forgets now fails to compile. The `canManage` gate
  // below still decides whether the affordance is shown at all.
  onDeleteLocation: (loc: Location) => void;
};

export function LocationSelector({
  locations,
  items,
  activeId,
  onChange,
  onAddNew,
  canAdd,
  canEdit,
  canDelete,
  onEditLocation,
  onDeleteLocation,
}: Props) {
  const [open, setOpen] = useState(false);

  const active = locations.find((l) => l.id === activeId);
  const totalItemsAtActive =
    activeId === "all"
      ? items.filter((i) => i.kind === "material").length
      : items.filter((i) =>
          i.stock.some((s) => s.locationId === activeId && s.onHand > 0),
        ).length;

  const truckCount = locations.filter((l) => l.type === "truck").length;
  const warehouseCount = locations.filter((l) => l.type === "warehouse").length;

  const rows: SearchablePanelRow[] = locations.map((loc) => {
    // The row's second line, and therefore also a haystack: typing "Brooklyn"
    // has to find "Mike's Van", and typing "BX-4421" has to find it too.
    const sub =
      loc.type === "truck"
        ? `${loc.branch} · ${loc.primaryTech ?? "Unassigned tech"}${loc.vehicle ? ` · ${loc.vehicle}` : ""}`
        : `${loc.branch} · ${formatType(loc.type)}`;
    const itemCount = items.filter((i) =>
      i.stock.some((s) => s.locationId === loc.id && s.onHand > 0),
    ).length;
    return {
      key: loc.id,
      label: loc.name,
      subtitle: sub,
      render: (
        <LocationRow
          label={loc.name}
          sub={sub}
          icon={<LocationIcon type={loc.type} active />}
          count={itemCount}
          active={activeId === loc.id}
          onClick={() => {
            onChange(loc.id);
            setOpen(false);
          }}
          onEdit={
            canEdit && onEditLocation
              ? () => {
                  onEditLocation(loc);
                  setOpen(false);
                }
              : undefined
          }
          /* `canDelete` alone, deliberately NOT the same shape as
             `onEdit` above: `onDeleteLocation` is a required prop, so a
             second conjunct could never be falsy and would only suggest
             to a reader that the prop is still optional. `onEditLocation`
             really is optional, so its own check stays. */
          onDelete={
            canDelete
              ? () => {
                  onDeleteLocation(loc);
                  setOpen(false);
                }
              : undefined
          }
        />
      ),
    };
  });

  return (
    <SearchablePanel
      open={open}
      onOpenChange={setOpen}
      searchPlaceholder="Search locations…"
      searchAriaLabel="Search locations"
      trigger={
        /* Raw by design: PopoverTrigger asChild clones + ref-forwards onto
           this element - the never-convert asChild trigger shape. */
        <button
          className={[
            "flex min-w-[260px] items-center gap-2 rounded-card border bg-surface-light px-3 py-2 text-left transition",
            open
              ? "border-primary ring-2 ring-primary/20"
              : "border-border hover:border-secondary-dark",
          ].join(" ")}
        >
          <LocationIcon type={active?.type} active />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">
              {activeId === "all" ? "All Locations" : active?.name}
            </p>
            <p className="truncate text-[11px] text-text-secondary">
              {activeId === "all"
                ? `${warehouseCount} warehouse · ${truckCount} vans · ${locations.length - warehouseCount - truckCount} other`
                : active
                  ? `${active.branch} · ${formatType(active.type)}${active.primaryTech ? ` · ${active.primaryTech}` : ""}`
                  : ""}
            </p>
          </div>
          <span className="rounded-md bg-background-light px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-secondary">
            {totalItemsAtActive}
          </span>
          <ChevronDown
            className={[
              "h-4 w-4 text-text-secondary transition",
              open ? "rotate-180" : "",
            ].join(" ")}
          />
        </button>
      }
      align="start"
      // Always BELOW the trigger. The panel is a fixed 420px tall, so Radix's
      // collision handling used to flip it above the button whenever the
      // toolbar sat past the middle of the viewport - the same control
      // opening in two different directions depending on scroll position.
      // The list clamps to the room actually below instead, and scrolls.
      side="bottom"
      avoidCollisions={false}
      sideOffset={6}
      // `border` dropped: PopoverContent's own base string already emits
      // an unconditional `border border-border` - this was a byte-for-byte
      // redundant restatement, not an override.
      contentClassName="w-[420px] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
      listClassName="max-h-[min(420px,var(--radix-popover-content-available-height))] overflow-y-auto py-1"
      /* The reset row scrolls WITH the list here, unlike CategorySelector's
         sticky one - that is how this panel has always rendered and the
         difference is visible, so it stays a prop rather than being
         normalised onto its neighbour. Never filtered either way. */
      resetRowPlacement="inList"
      resetRow={
        <>
          <LocationRow
            label="All Locations"
            sub={`Show items across all ${locations.length} locations`}
            icon={<MapPin className="h-4 w-4 text-text-secondary" />}
            count={items.filter((i) => i.kind === "material").length}
            active={activeId === "all"}
            onClick={() => {
              onChange("all");
              setOpen(false);
            }}
          />
          <div className="my-1 border-t border-border" />
        </>
      }
      rows={rows}
      /* Pinned below the filtered list on purpose: a query matching nothing is
         exactly when "Add Location / Van" is the thing the user wants. */
      footer={
        (canAdd || canEdit || canDelete) && (
          <div className="border-t border-border bg-background-light px-2 py-1.5">
            {canAdd && (
              // Raw by design: a brand-tinted footer CTA (text-primary,
              // hover:bg-primary-subtle, no border) - no minted ghost/brand
              // cell (ghost only has neutral/subtle/danger tones).
              <button
                onClick={() => {
                  setOpen(false);
                  onAddNew();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-primary hover:bg-primary-subtle"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-subtle">
                  <Plus className="h-3.5 w-3.5" />
                </span>
                Add Location / Van
              </button>
            )}
            {(canEdit || canDelete) && (
              <p className="px-2.5 pb-1 pt-0.5 text-[10px] text-text-secondary">
                <ShieldCheck className="mr-0.5 inline h-2.5 w-2.5 text-success" />
                Admin · hover any location to edit or delete
              </p>
            )}
          </div>
        )
      }
    />
  );
}

function LocationRow({
  label,
  sub,
  icon,
  count,
  active,
  onClick,
  onEdit,
  onDelete,
}: {
  label: string;
  sub: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={[
        "group flex w-full items-center gap-3 px-3 py-2 text-left transition",
        active ? "bg-primary-subtle" : "hover:bg-background-light",
      ].join(" ")}
    >
      {/* Raw by design: a list-row click target, not Button-shaped. */}
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div
          className={[
            "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md",
            active ? "bg-surface-light ring-1 ring-primary/30" : "bg-background-light",
          ].join(" ")}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={[
              "truncate text-sm",
              active
                ? "font-semibold text-primary-dark"
                : "font-medium text-text-primary",
            ].join(" ")}
          >
            {label}
          </p>
          <p className="truncate text-[11px] text-text-secondary">{sub}</p>
        </div>
        <span className="rounded-md bg-background-light px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-secondary">
          {count}
        </span>
        {active && <Check className="h-3.5 w-3.5 text-primary" />}
      </button>
      {onEdit && (
        // Raw by design: the opacity-0/group-hover:opacity-100 visibility
        // toggle lives on this button's own className (not a wrapping span),
        // and the hover background (secondary-light) doesn't match any
        // minted ghost cell either - converting would add new SOFT classes
        // to a governed component, and the layering guard's soft ratchet has
        // zero slack (196/196 measured pre-batch).
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title="Edit location (admin)"
          aria-label="Edit location"
          className="ml-1 rounded-md p-1 text-text-secondary opacity-0 transition hover:bg-secondary-light hover:text-text-primary group-hover:opacity-100 focus:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {onDelete && (
        // Raw by design: same reveal-on-hover row affordance as the edit button
        // above, danger-toned. The minted ghost/danger cell carries no opacity
        // toggle, so converting would need new SOFT classes on a governed
        // component (see the edit button's note).
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete location (admin)"
          aria-label="Delete location"
          className="rounded-md p-1 text-text-secondary opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function LocationIcon({
  type,
  active,
}: {
  type?: LocationType;
  active?: boolean;
}) {
  const cls = ["h-4 w-4", active ? "text-primary" : "text-text-secondary"].join(
    " ",
  );
  if (type === "truck") return <Truck className={cls} />;
  if (type === "warehouse") return <Warehouse className={cls} />;
  if (type === "counter") return <Boxes className={cls} />;
  if (type === "staging") return <MapPin className={cls} />;
  return <MapPin className={cls} />;
}

function formatType(type?: LocationType) {
  if (type === "truck") return "Truck";
  if (type === "warehouse") return "Warehouse";
  if (type === "counter") return "Counter";
  if (type === "staging") return "Staging";
  return "Location";
}
