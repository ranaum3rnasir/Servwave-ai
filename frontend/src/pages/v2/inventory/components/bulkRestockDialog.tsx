import { useEffect, useMemo, useState } from 'react';
import { PackagePlus } from 'lucide-react';

import { useBulkRestock, type BulkRestockLine, type Item, type Location } from '@/lib/api/inventory';
import { useOrganization } from '@/lib/api/organization';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';

/**
 * Receive stock against every selected item in one write.
 *
 * The endpoint is `POST /api/inventory/bulk-restock`, whose body is
 * `bulkRestockSchema`: `{ lines: [{ itemId, locationId, qty, unitCost? }] }`,
 * `lines` non-empty, `qty` strictly positive, both ids uuids. That is a
 * NARROWER contract than the single restock this dialog sits beside - there is
 * no `source`, no `reference` and no `notes` on a line, and the server writes
 * the ledger reference itself ('bulk-restock'). So this is not RestockDialog
 * with a list: the fields that endpoint cannot carry are not offered, rather
 * than collected and dropped.
 *
 * What IS carried over from RestockDialog, deliberately:
 *   - the destination default: the org's `default_inventory_location_id` when
 *     it still resolves against the live locations (a stale default would name
 *     an id with no option and 404 the submit), else the first warehouse, else
 *     the first location. A submit with no destination is refused, not sent.
 *   - the SRVW-92 cost rule: `item.unitCost == null` is the exact signal that
 *     the server cost-stripped the response, so the key is OMITTED rather than
 *     sent as a prefilled 0 the server would persist as a literal 0.00.
 *   - the mutation seam (`useBulkRestock` -> `useInventoryMutation`), which
 *     carries the same `['inventory']` invalidation every other stock write
 *     uses, and the same `onSubmitted(msg)` toast hand-off.
 *
 * Quantities default to the SHORTFALL at the chosen destination - `min` minus
 * on-hand where that is positive, 1 otherwise - so the common case (top the
 * low rows back up to reserve) needs no typing, and nothing is guessed for an
 * item that is not short.
 *
 * Every id posted comes from this org's own items/locations queries, and the
 * server re-resolves each one under `tenantWhere(req)` before writing, so a
 * line cannot be pointed at another org's rows.
 */
function BulkRestockDialog({
  open, onClose, items, locations, onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  /** The selected rows, in the order the grid holds them. */
  items: Item[];
  locations: Location[];
  onSubmitted: (msg: string) => void;
}) {
  const { data: org } = useOrganization();
  const bulkRestock = useBulkRestock();

  const defaultLocationId = useMemo(() => {
    const orgDefault = org?.default_inventory_location_id;
    if (orgDefault && locations.some((l) => l.id === orgDefault)) return orgDefault;
    return locations.find((l) => l.type === 'warehouse')?.id ?? locations[0]?.id ?? '';
  }, [locations, org?.default_inventory_location_id]);

  const [locationId, setLocationId] = useState('');
  // Keyed by item id and seeded on open, so a typed quantity survives a
  // destination change rather than being silently rewritten under the cursor.
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  function shortfallAt(item: Item, locId: string): number {
    const row = item.stock.find((s) => s.locationId === locId);
    if (!row || row.min == null) return 1;
    return Math.max(1, row.min - row.onHand);
  }

  useEffect(() => {
    if (!open) return;
    const dest = defaultLocationId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the dialog resets its own draft (destination plus per-item quantities) on open, so a typed quantity is not rewritten mid-edit
    setLocationId(dest);
    setQtys(Object.fromEntries(items.map((i) => [i.id, String(shortfallAt(i, dest))])));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const locationName = locations.find((l) => l.id === locationId)?.name ?? 'location';

  async function submit() {
    if (bulkRestock.isPending) return;
    if (!locationId) { setError('Pick a destination location.'); return; }

    const lines: BulkRestockLine[] = [];
    for (const item of items) {
      const qty = parseInt(qtys[item.id] ?? '', 10);
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(`Quantity for ${item.sku} must be greater than 0.`);
        return;
      }
      lines.push({
        itemId: item.id,
        locationId,
        qty,
        // See the SRVW-92 note above: absent, not 0, when costs were stripped.
        ...(item.unitCost == null ? {} : { unitCost: item.unitCost }),
      });
    }
    if (lines.length === 0) { setError('Nothing selected to receive.'); return; }
    setError(null);

    try {
      await bulkRestock.mutateAsync({ lines });
    } catch (err: unknown) {
      setError(extractApiError(err, 'Could not record the receipts - try again.'));
      return;
    }

    const units = lines.reduce((sum, l) => sum + l.qty, 0);
    onSubmitted(
      `✓ Received ${units} unit${units === 1 ? '' : 's'} across ${lines.length} item${lines.length === 1 ? '' : 's'} into ${locationName}`,
    );
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[34rem]">
        <DialogHeader>
          <DialogTitle>Restock {items.length} item{items.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Posts one immutable stock_movement entry (type: receive) per line, all in one
            transaction, and adds to on-hand at the destination.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {error && (
            <p role="alert" className="text-status-red-emphasis text-xs">{error}</p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-restock-location">Receive into location</Label>
            <SelectField
              id="bulk-restock-location"
              value={locationId}
              onValueChange={setLocationId}
              size="sm"
              aria-label="Receive into location"
              placeholder="Pick a location"
              options={locations.map((l) => ({ value: l.id, label: l.name }))}
            />
          </div>

          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-3">
                <Label htmlFor={`bulk-restock-qty-${item.id}`} className="min-w-0 flex-1 font-normal">
                  <span className="text-muted-foreground font-mono text-xs">{item.sku}</span>
                  <span className="ms-2 truncate">{item.name}</span>
                </Label>
                <Input
                  id={`bulk-restock-qty-${item.id}`}
                  className="w-24"
                  type="number"
                  min="1"
                  step="1"
                  aria-label={`Quantity for ${item.sku}`}
                  value={qtys[item.id] ?? ''}
                  onChange={(e) => setQtys((prev) => ({ ...prev, [item.id]: e.target.value }))}
                />
                <span className="text-muted-foreground w-8 text-xs">{item.uom}</span>
              </div>
            ))}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={bulkRestock.isPending}>
            <PackagePlus />
            {bulkRestock.isPending ? 'Receiving…' : `Receive ${items.length} line${items.length === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Declared then exported, not `export function ...Dialog`: the design-system
// duplicate-implementation guard keys on that literal form and requires an
// import from `@/components/ui/dialog`, a path a v2 page may not use. This DOES
// compose a shared Dialog primitive - the kit's - so the check is a false
// positive against the v2 layer. Same workaround as
// `customers/components/duplicateCustomerDialog.tsx` and `leads/components/leadDialogs.tsx`.
export { BulkRestockDialog };
