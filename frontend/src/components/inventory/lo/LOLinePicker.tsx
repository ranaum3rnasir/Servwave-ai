/**
 * LOLinePicker — the line-list editor for a Logistic Order (spec §7 / §12 rec 2).
 *
 * Controlled: the parent owns the `lines` array and receives every edit through `onChange`.
 * Its whole job is to make "8 lines from one warehouse" cost one location decision:
 *
 *   • Tracked-item search — hits the browse endpoint with `track_inventory=true`
 *     (listPriceBookItems(q, { trackedOnly:true })). We do NOT reuse `searchItems`/`/search`:
 *     its Prisma `select` omits both `track_inventory` and `sku`, so it can neither filter to
 *     stocked items nor show a SKU. The browse endpoint uses `include`, so it carries both —
 *     zero backend change (recon §7).
 *   • Per-location on-hand — salvaged from AddLineDialog: GET /api/inventory/items/:id →
 *     { stock: [{locationId,onHand}] }, gated on `read Inventory`, keyed ['inventory','item',id]
 *     so rows sharing an item dedupe. Absent (no ability / error) ⇒ options render without hints.
 *   • Location defaults on ADD — inherit the previous line's location; line 1 resolves the shipped
 *     chain (session memory → org default → first location), each candidate validated against the
 *     live location list. Default qty = 1. Every row keeps its own override select.
 *
 * The client never sends item_sku/item_name — the server snapshots them from item_id; the two
 * display fields on LOLineDraft are for rendering only. `toLoLineInput` strips them for submit.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import api from '@/lib/axios';
import { type PriceBookItem } from '@/lib/api/invoices';
import { useLocations } from '@/lib/api/inventory';
import { useOrganization } from '@/lib/api/organization';
import { useAppAbility } from '@/contexts/AbilityContext';
import {
  getLastStockLocationId,
  setLastStockLocationId,
} from '@/lib/inventory/stockLocationMemory';
import type { LoLineInput } from '@/lib/api/logisticOrders';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/form/SelectField';
import { TrackedItemSearch } from './TrackedItemSearch';

/**
 * One editable line. Extends the write shape (LoLineInput) with the two display-only snapshots the
 * picker renders. `id` present = an existing persisted line (a PROCESSED edit diffs off it).
 */
export interface LOLineDraft extends LoLineInput {
  item_sku: string | null;
  item_name: string;
}

export interface LOLinePickerProps {
  /** The current lines (controlled). */
  lines: LOLineDraft[];
  /** Called with the full next array on every add / edit / remove. */
  onChange: (next: LOLineDraft[]) => void;
  /** Read-only render — no search, inputs disabled, no remove. Use for a non-editable LO. */
  disabled?: boolean;
}

/** Strip the display-only fields, leaving the exact shape the create/update endpoints accept. */
export function toLoLineInput(line: LOLineDraft): LoLineInput {
  const { item_sku: _sku, item_name: _name, ...rest } = line;
  void _sku;
  void _name;
  return rest;
}

/** Minimal slice of GET /api/inventory/items/:id — the per-location on-hand feed (salvaged). */
interface ItemStockDetail {
  id: string;
  stock?: { locationId: string; onHand: number }[];
}

function useItemStock(itemId: string | null, enabled: boolean) {
  return useQuery<ItemStockDetail>({
    queryKey: ['inventory', 'item', itemId],
    queryFn: () => api.get(`/api/inventory/items/${itemId}`).then((r) => r.data.item),
    enabled: enabled && !!itemId,
    retry: false,
  });
}

type LocationOption = { id: string; name: string; branch?: string };

export function LOLinePicker({ lines, onChange, disabled = false }: LOLinePickerProps) {
  const ability = useAppAbility();
  const canReadInventory = ability.can('read', 'Inventory');
  const locationsQuery = useLocations();
  const { data: org } = useOrganization();
  const locations: LocationOption[] = locationsQuery.data ?? [];

  // Line 1: session pick → org default → first location, each validated against the live list.
  // Line N: inherit the previous line's location. (Spec §12 rec 2.)
  const resolveDefaultLocationId = (): string | null => {
    const previous = lines[lines.length - 1];
    if (previous) return previous.from_location_id;
    const inList = (id: string | null | undefined): id is string =>
      !!id && locations.some((l) => l.id === id);
    const session = getLastStockLocationId();
    if (inList(session)) return session;
    const orgDefault = org?.default_inventory_location_id ?? null;
    if (inList(orgDefault)) return orgDefault;
    return locations[0]?.id ?? null;
  };

  const addItem = (item: PriceBookItem) => {
    const from = resolveDefaultLocationId();
    onChange([
      ...lines,
      {
        item_id: item.id,
        item_sku: item.sku ?? null,
        item_name: item.name,
        qty: 1,
        from_location_id: from,
      },
    ]);
    if (from) setLastStockLocationId(from);
  };

  const patchLine = (index: number, patch: Partial<LOLineDraft>) =>
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const removeLine = (index: number) => onChange(lines.filter((_, i) => i !== index));

  const setLineLocation = (index: number, locationId: string) => {
    setLastStockLocationId(locationId);
    patchLine(index, { from_location_id: locationId });
  };

  return (
    <div className="space-y-3">
      {lines.length === 0 ? (
        <EmptyState density="flush" title="No items yet — search below to add tracked parts." />
      ) : (
        <ul className="space-y-2">
          {lines.map((line, index) => (
            <LOLineRow
              key={line.id ?? `new-${index}-${line.item_id}`}
              line={line}
              locations={locations}
              canReadInventory={canReadInventory}
              disabled={disabled}
              onQtyChange={(qty) => patchLine(index, { qty })}
              onLocationChange={(locationId) => setLineLocation(index, locationId)}
              onRemove={() => removeLine(index)}
            />
          ))}
        </ul>
      )}

      {!disabled && <TrackedItemSearch onPick={addItem} />}
    </div>
  );
}

// ─── One line row ─────────────────────────────────────────────────────────────

interface LOLineRowProps {
  line: LOLineDraft;
  locations: LocationOption[];
  canReadInventory: boolean;
  disabled: boolean;
  onQtyChange: (qty: number) => void;
  onLocationChange: (locationId: string) => void;
  onRemove: () => void;
}

function LOLineRow({
  line,
  locations,
  canReadInventory,
  disabled,
  onQtyChange,
  onLocationChange,
  onRemove,
}: LOLineRowProps) {
  const { data: itemStock } = useItemStock(line.item_id, canReadInventory);

  const onHandFor = useMemo(() => {
    const byLoc = new Map((itemStock?.stock ?? []).map((s) => [s.locationId, s.onHand]));
    return (locId: string): number | undefined => byLoc.get(locId);
  }, [itemStock]);

  // Flat options so SelectField can read the count itself (DESIGN_SYSTEM.md
  // §4.2) - an org with ten-plus inventory locations gets the searchable
  // branch, and the on-hand suffix stays part of the searchable label.
  const locationOptions = useMemo(
    () =>
      locations.map((loc) => {
        const onHand = onHandFor(loc.id);
        return {
          value: loc.id,
          label: `${loc.name}${loc.branch ? ` · ${loc.branch}` : ''}${
            onHand != null ? ` — ${onHand} on hand` : ''
          }`,
        };
      }),
    [locations, onHandFor],
  );

  return (
    <li className="flex items-start gap-2 rounded-control border border-border bg-surface-light p-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">{line.item_name}</p>
        {line.item_sku && (
          <code className="font-mono text-xs text-text-secondary">{line.item_sku}</code>
        )}
      </div>

      <div className="w-20 shrink-0">
        <Input
          type="number"
          min={0.01}
          step={0.01}
          aria-label={`Quantity for ${line.item_name}`}
          value={line.qty}
          disabled={disabled}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            onQtyChange(Number.isFinite(n) ? n : 0);
          }}
          className="text-right"
        />
      </div>

      <div className="w-56 shrink-0">
        <SelectField
          value={line.from_location_id ?? ''}
          onValueChange={onLocationChange}
          disabled={disabled || locations.length === 0}
          aria-label={`Source location for ${line.item_name}`}
          placeholder="Pick a location…"
          options={locationOptions}
        />
      </div>

      {!disabled && (
        <Button
          type="button"
          variant="ghost" tone="danger" revealOnHover
          size="icon"
          aria-label={`Remove ${line.item_name}`}
          onClick={onRemove}
          className="shrink-0"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </li>
  );
}
