/**
 * CreatePOFromJobDialog — order the Job's MATERIAL lines from a vendor (Inventory P2,
 * D16 entry #2). Opens from the Items-tab header "Create PO" button (LineItemsEditor);
 * gated there on `create PurchaseOrder`.
 *
 * Selection lives HERE, not as checkboxes on the shared LineItemsTable (that grid is
 * shared with the Invoice editor and estimate surfaces — row-select mode was rejected
 * for scope). Lines resolve to catalog items by `price_book_item_id`; free-text lines
 * render disabled — the PO line contract requires a real SKU (server `resolveSkuMap`).
 *
 * Submit posts the standard NewPOInput through useCreatePO() with `jobId` set — the
 * whole point: PurchaseOrder.job_id gets linked so the D15 material-cost actuals and
 * the Pre-PO queue both see the job. `customer`/`site` are omitted; the server derives
 * display fields from the job relation (no denormalized strings from the FE).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShoppingCart } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/form/SelectField';
import { DatePicker } from '@/components/form/DatePicker';
import { useInventoryItems, useVendors, useCreatePO } from '@/lib/api/inventory';
import type { Item, POLine } from '@/lib/api/inventory';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { toast } from '@/components/ui/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { EmptyState } from '@/components/ui/empty-state';
import { extractApiError } from '@/lib/utils';

export interface CreatePOFromJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** uuid from LineItemsEditor. */
  jobId: string;
  /** Pre-filtered MATERIAL lines. */
  lines: InvoiceLineItem[];
  /** Threads through from LineItemsEditor (cost column visibility). */
  canSeePricing: boolean;
}

type DraftRow = {
  line: InvoiceLineItem;
  item: Item | null; // null → free-text / unresolvable — renders disabled
  checked: boolean;
  qty: string;       // editable, decimals allowed (qty is Decimal since P0)
  unitCost: string;  // editable only when canSeePricing; '' = omit from payload
};

export function CreatePOFromJobDialog({
  open,
  onOpenChange,
  jobId,
  lines,
  canSeePricing,
}: CreatePOFromJobDialogProps) {
  const navigate = useNavigate();
  const { data: items = [] } = useInventoryItems();
  const { data: vendors = [] } = useVendors();
  const createPO = useCreatePO();

  const [rows, setRows] = useState<DraftRow[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');

  // Same filter as NewPODialog: active vendors only, sorted by name.
  const vendorOptions = useMemo(
    () =>
      vendors
        .filter((v) => v.status !== 'inactive')
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [vendors],
  );

  // Re-seed the draft rows every time the dialog opens (lines/items may have changed).
  useEffect(() => {
    if (!open) return;
    const next: DraftRow[] = lines.map((line) => {
      const item = line.price_book_item_id
        ? items.find((i) => i.id === line.price_book_item_id) ?? null
        : null;
      const cost = line.unit_cost != null ? Number(line.unit_cost) : item?.unitCost;
      return {
        line,
        item,
        checked: item != null,
        qty: String(Number(line.quantity) || 1),
        unitCost: cost != null ? String(cost) : '',
      };
    });
    setRows(next);
    // Preselect the vendor when every resolvable line's item names the same one.
    const names = new Set(
      next.filter((r) => r.item).map((r) => r.item!.vendor).filter(Boolean),
    );
    if (names.size === 1) {
      const match = vendors.find((v) => v.name === Array.from(names)[0] && v.status !== 'inactive');
      setVendorId(match?.id ?? '');
    } else {
      setVendorId('');
    }
    setExpectedDate('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const checkedRows = rows.filter((r) => r.checked && r.item);
  const canSubmit = !createPO.isPending && !!vendorId && checkedRows.length > 0;

  const setRow = (idx: number, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  async function handleSubmit() {
    const vendor = vendorOptions.find((v) => v.id === vendorId);
    if (!vendor || checkedRows.length === 0) return;
    const poLines: POLine[] = checkedRows.map((r) => {
      const item = r.item!;
      const qty = Math.max(0.01, Number(r.qty) || 0.01);
      const unitCost = r.unitCost.trim() === '' ? null : Number(r.unitCost);
      return {
        itemSku: item.sku,
        itemName: item.name,
        uom: item.uom,
        qtyOrdered: qty,
        qtyReceived: 0,
        ...(canSeePricing && unitCost != null && isFinite(unitCost) ? { unitCost } : {}),
        priceBookItemId: item.id,
      };
    });
    try {
      const r = await createPO.mutateAsync({
        vendor: vendor.name,
        vendorId: vendor.id,
        status: 'draft',
        jobId,
        orderedAt: new Date().toISOString(),
        ...(expectedDate ? { expectedDate: new Date(expectedDate).toISOString() } : {}),
        lines: poLines,
      });
      const poNumber = r.purchaseOrder.poNumber;
      onOpenChange(false);
      toast({
        title: `${poNumber} created`,
        description: 'Draft purchase order linked to this job.',
        action: (
          <ToastAction
            altText="View purchase order"
            onClick={() =>
              navigate(`/inventory/purchase-orders?status=draft&q=${encodeURIComponent(poNumber)}`)
            }
          >
            View
          </ToastAction>
        ),
      });
    } catch (err) {
      toast({ title: extractApiError(err, 'Failed to create purchase order'), variant: 'destructive' });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (createPO.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create purchase order from job</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Pick the material lines to order. Free-text lines need a price-book item first.
          </p>

          <div className="max-h-72 overflow-y-auto rounded-card border border-border">
            <table className="min-w-full text-sm">
              <thead className="border-b border-border bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="w-24 px-3 py-2 text-right">Qty</th>
                  {canSeePricing && <th className="w-28 px-3 py-2 text-right">Unit cost</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r, idx) =>
                  r.item ? (
                    <tr key={r.line.id} className="hover:bg-background-light">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Order ${r.item.name}`}
                          checked={r.checked}
                          onChange={(e) => setRow(idx, { checked: e.target.checked })}
                          className="h-4 w-4 rounded border-border accent-primary"
                        />
                      </td>
                      <td className="px-3 py-2 text-text-primary">{r.item.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-text-secondary">{r.item.sku}</td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min={0.01}
                          step="0.01"
                          aria-label={`Quantity for ${r.item.name}`}
                          value={r.qty}
                          onChange={(e) => setRow(idx, { qty: e.target.value })}
                          disabled={!r.checked}
                          className="w-20 px-1.5 py-0.5 text-right"
                        />
                      </td>
                      {canSeePricing && (
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            aria-label={`Unit cost for ${r.item.name}`}
                            value={r.unitCost}
                            onChange={(e) => setRow(idx, { unitCost: e.target.value })}
                            disabled={!r.checked}
                            className="w-24 px-1.5 py-0.5 text-right"
                          />
                        </td>
                      )}
                    </tr>
                  ) : (
                    <tr key={r.line.id} className="opacity-60">
                      <td className="px-3 py-2">
                        <input type="checkbox" disabled className="h-4 w-4 rounded border-border" />
                      </td>
                      <td className="px-3 py-2 text-text-secondary" colSpan={canSeePricing ? 4 : 3}>
                        {r.line.description.split('\n')[0]}
                        <span className="ml-2 text-xs italic text-text-secondary">
                          No catalog item — add it to the price book to order it
                        </span>
                      </td>
                    </tr>
                  ),
                )}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={canSeePricing ? 5 : 4} className="px-3 py-4 text-center text-sm text-text-secondary">
                      <EmptyState title="No material lines on this job." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="create-po-vendor">Vendor</Label>
              <SelectField
                value={vendorId}
                onValueChange={setVendorId}
                placeholder="Pick a vendor…"
                aria-label="Vendor"
                options={vendorOptions.map((v) => ({ value: v.id, label: v.name }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-po-expected">Expected date (optional)</Label>
              <DatePicker id="create-po-expected" value={expectedDate} onChange={setExpectedDate} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={createPO.isPending}>
            Cancel
          </Button>
          <Button type="button" variant="solid" tone="business" onClick={handleSubmit} disabled={!canSubmit}>
            {createPO.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ShoppingCart className="mr-2 h-4 w-4" aria-hidden />
            )}
            Create purchase order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
