import { useMemo, useState } from "react";
import { Check, MapPin, Pencil, PlusCircle } from "lucide-react";
import {
  SearchablePanel,
  type SearchablePanelRow,
} from "@/components/ui/searchable-panel";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Location } from "@/lib/api/inventory";

type Props = {
  /** The parent location (warehouse) inside which the staging area lives. */
  parentLocation: Location | null | undefined;

  /** Current staging area value (free-form string). */
  value?: string;

  /** Fired whenever the user picks or types a new area. */
  onChange: (next: string | undefined) => void;

  /**
   * Compact mode renders just a clickable pill — good for inline placement
   * inside a stage card row. Default = full dropdown surface.
   */
  compact?: boolean;

  /** Optional className override for the wrapper. */
  className?: string;
};

/**
 * StagingAreaPicker — small dropdown that lets the warehouse manager pick
 * which zone inside a warehouse a staged job is sitting in. Sources options
 * from `parentLocation.stagingAreas` and also offers an inline "Add custom
 * area…" path so any floor-plan tweak doesn't need a settings trip.
 *
 * The PANEL is `@/components/ui/searchable-panel` — the shared primitive that
 * owns the search box, so this file declares nothing about search and the areas
 * are reachable by typing. See that file's header.
 *
 * WHAT THE PRIMITIVE REPLACED HERE, AND WHY IT IS A DELETION
 *   This picker used to portal its own `position: fixed` panel to `document.body`
 *   and keep it glued to the trigger by hand: a `getBoundingClientRect` read, a
 *   right-align-then-clamp-into-the-viewport calculation, a flip-up-when-no-room
 *   branch, a `maxHeight` derived from the space actually available, and a
 *   capture-phase `scroll` listener plus a `resize` listener to redo all of it.
 *   Every one of those is something Radix's Popover already does — the portal by
 *   default, the right-align as `align="end"`, the flip and the clamp as
 *   `avoidCollisions`, the height as `--radix-popover-content-available-height`,
 *   and the tracking as Popper's own reference observer. So the search box came
 *   in and ~80 lines went out; it was not traded for the panel's behaviour.
 *
 *   The hostile case the hand-rolled version existed for — this picker lives on
 *   a stage card inside a scrollable, `overflow-hidden` list — is exactly the
 *   case the portal handles, and it was re-checked in a real browser rather than
 *   argued from the source.
 */
export function StagingAreaPicker({
  parentLocation,
  value,
  onChange,
  compact,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const presets = useMemo(
    () => parentLocation?.stagingAreas ?? [],
    [parentLocation?.stagingAreas],
  );

  // Include the current custom value (if any) in the list so users see it
  // as the active selection even when it's not in the configured presets.
  const allOptions = useMemo(() => {
    if (!value) return presets;
    if (presets.includes(value)) return presets;
    return [value, ...presets];
  }, [value, presets]);

  function pick(next: string | undefined) {
    onChange(next);
    setOpen(false);
    setEditing(false);
  }

  function saveCustom() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // Persist the new area as a preset on the parent location so future
    // stages in the same warehouse see it as a configured option, not just
    // a one-off on this stage. In production this is a
    // `PATCH /inventory_locations/{id}` writing `staging_areas` — for the
    // v1 prototype we mutate the in-memory array (it's the same `locations`
    // object referenced everywhere in the app).
    if (parentLocation && !parentLocation.stagingAreas?.includes(trimmed)) {
      parentLocation.stagingAreas = [
        ...(parentLocation.stagingAreas ?? []),
        trimmed,
      ];
    }
    pick(trimmed);
    setDraft("");
  }

  // If there's no parent location at all, render an inactive hint.
  if (!parentLocation) {
    return (
      <span className={`text-[11px] italic text-secondary-dark ${className ?? ""}`}>
        Set a staging location first to pick an area
      </span>
    );
  }

  const triggerLabel = value || "Pick a staging area";

  const rows: SearchablePanelRow[] = allOptions.map((opt) => {
    const isActive = value === opt;
    return {
      key: opt,
      // The row is a single line of text, so the label IS everything a user
      // could reasonably type at it — there is no subtitle to also match.
      label: opt,
      render: (
        // Not converted to Button: listbox-option row (role="listbox"
        // parent above), not a Button shape.
        <button
          type="button"
          onClick={() => pick(opt)}
          className={[
            "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px]",
            isActive
              ? "bg-primary-subtle font-semibold text-primary"
              : "text-text-secondary hover:bg-background-light",
          ].join(" ")}
        >
          <span className="truncate">{opt}</span>
          {isActive && (
            <Check className="h-3 w-3 flex-shrink-0 text-primary" />
          )}
        </button>
      ),
    };
  });

  return (
    <div
      className={`relative inline-block ${className ?? ""}`}
      onClick={(e) => {
        // Prevent the picker (and the dropdown panel below it) from bubbling
        // clicks up to any parent row / card that opens a detail view on
        // click. The picker is its own interactive surface. The panel is
        // portalled out of this div in the DOM, but it is still a React child
        // of it, so its synthetic clicks stop here too — same as when the
        // portal was hand-rolled.
        e.stopPropagation();
      }}
    >
      <SearchablePanel
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Closing the panel abandons a half-typed new area, exactly as the
          // outside-click / Escape handlers used to.
          if (!next) {
            setEditing(false);
            setDraft("");
          }
        }}
        searchPlaceholder="Search staging areas…"
        searchAriaLabel="Search staging areas"
        trigger={
          /* Not converted to Button: two-state pill (primary-subtle/warning ring)
             has no matching variant/tone cell. Raw by design either way:
             PopoverTrigger asChild clones + ref-forwards onto this element. */
          <button
            type="button"
            onClick={(e) => {
              // Only the bubble stop is ours now — PopoverTrigger owns the
              // open/close toggle, and doing it here too would cancel it out.
              e.stopPropagation();
            }}
            className={[
              "inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium transition",
              compact
                ? "px-2 py-0.5"
                : "px-2.5 py-1",
              value
                ? "bg-primary-subtle text-primary ring-1 ring-primary/30 hover:bg-primary-subtle/80"
                : "bg-warning/10 text-warning ring-1 ring-warning/20 hover:bg-warning/10",
            ].join(" ")}
            title={
              value
                ? `Staged in: ${value} (click to change)`
                : "Pick where in the warehouse"
            }
          >
            <MapPin className="h-3 w-3" />
            {triggerLabel}
            <span className="text-[9px] opacity-60">▼</span>
          </button>
        }
        // Right-aligned under the trigger, which is what the hand-rolled
        // `left = rect.right - PANEL_W` did. `avoidCollisions` (Radix's
        // default) is the flip-up-when-there-is-no-room branch and the
        // clamp-into-the-viewport line, and it is left ON here — unlike
        // CategorySelector / LocationSelector, which pin `side="bottom"`
        // because their 420px panels flipped distractingly. This one is a
        // small inline pill low down a scrolling card list; opening upward
        // when it sits near the bottom of the viewport is the behaviour it
        // has always had, and the behaviour it needs.
        align="end"
        side="bottom"
        sideOffset={4}
        role="listbox"
        // `max-h` from the room Radix actually measures, replacing the
        // hand-computed `Math.min(480, Math.max(220, space - MARGIN))`.
        contentClassName="flex max-h-[min(480px,var(--radix-popover-content-available-height))] w-72 flex-col overflow-hidden p-0"
        listClassName="min-h-0 flex-1 overflow-y-auto py-1"
        /* Pinned at the TOP, above the search box: the title block naming the
           warehouse, then the create affordance. Never filtered — a query
           matching no existing area is precisely when "Add new staging area"
           is the thing being reached for. */
        header={
          <>
            {/* Header — fixed */}
            <div className="flex flex-shrink-0 items-center justify-between border-b border-border bg-background-light/60 px-3 py-1.5">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  Staging area in {parentLocation.name}
                </p>
                <p className="text-[10px] text-text-secondary">
                  {presets.length} preset
                  {presets.length === 1 ? "" : "s"} configured for this warehouse
                </p>
              </div>
            </div>

            {/* "+ Add new staging area" — fixed, always visible above the
                scrollable preset list so a new zone is one click away. */}
            <div className="flex-shrink-0 border-b border-primary/20 bg-primary-subtle/40 p-2">
              {editing ? (
                <div>
                  {/* Not converted to FormField: the sibling below is an
                      input+button pair, not a single control FormField's
                      cloneElement can id, and outside the checkbox/select
                      render-prop precedent this batch adopts elsewhere. */}
                  <label className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-primary">
                    New staging area
                  </label>
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveCustom();
                        if (e.key === "Escape") {
                          setEditing(false);
                          setDraft("");
                        }
                      }}
                      placeholder="e.g. Mezzanine Bin 4"
                      className="flex-1 px-2 py-1 text-[11px]"
                    />
                    <Button
                      type="button"
                      onClick={saveCustom}
                      disabled={!draft.trim()}
                      size="3xs"
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        setEditing(false);
                        setDraft("");
                      }}
                      variant="ghost"
                      tone="subtle"
                      size="3xs"
                      title="Cancel"
                    >
                      ✕
                    </Button>
                  </div>
                  <p className="mt-1 text-[9px] italic text-primary/80">
                    Saved areas become presets for every future stage in {parentLocation.name}.
                  </p>
                </div>
              ) : (
                <Button
                  type="button"
                  onClick={() => setEditing(true)}
                  size="sm"
                  className="w-full"
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                  Add new staging area
                </Button>
              )}
            </div>
          </>
        }
        rows={rows}
        emptyState={
          <p className="px-3 py-2 text-[11px] italic text-text-secondary">
            No areas configured yet. Use the button above to add one.
          </p>
        }
        /* Clear action — pinned to bottom of panel when a value is set, and
           outside the filtered list for the same reason the create row is:
           backing out of a selection must survive a no-match query. */
        footer={
          value ? (
            <Button
              type="button"
              onClick={() => pick(undefined)}
              variant="ghost"
              tone="danger"
              size="3xs"
              className="w-full justify-start flex-shrink-0"
            >
              Clear staging area
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Read-only display of "Warehouse · Area" with a small Pencil affordance.
 * Useful in the doc preview header where we want a compact summary, not the
 * full dropdown trigger.
 */
export function StagingAreaInline({
  parentLocationName,
  area,
  onEdit,
}: {
  parentLocationName: string;
  area?: string;
  onEdit?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
      <MapPin className="h-3 w-3 text-text-secondary" />
      {parentLocationName}
      {area ? (
        <>
          <span className="text-text-secondary">·</span>
          <span className="font-medium text-text-primary">{area}</span>
        </>
      ) : null}
      {onEdit && (
        // Not converted to Button: idle-secondary/hover-brand icon with no
        // hover background has no matching ghost cell.
        <button
          type="button"
          onClick={onEdit}
          className="ml-0.5 inline-flex items-center text-text-secondary hover:text-primary"
          title="Change staging area"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
