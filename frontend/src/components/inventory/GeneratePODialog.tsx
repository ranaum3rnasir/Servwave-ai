/**
 * GeneratePODialog — low-stock → draft POs, one per vendor group (Inventory P2,
 * D16 entry #3, QA-612). Opens from the Stock page's "Generate PO (N)" header
 * button and the LowStockActionDialog's secondary CTA; gated on
 * `create PurchaseOrder` at both call sites.
 *
 * Quantities are editable before create (QA-612). Groups whose item.vendor
 * doesn't resolve against the vendor list collapse into ONE "No preferred
 * vendor" group with a required picker — its lines are skipped (called out
 * inline) until a vendor is chosen; never a hard block on the other groups.
 *
 * Creation is sequential `await createPO.mutateAsync(...)` per group (the
 * handlePriceBookAdd convention — no Promise.all); one failure doesn't abort
 * the rest. Success navigates to the Pre-PO tab.
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
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/form/SelectField';
import { useVendors, useCreatePO } from '@/lib/api/inventory';
import type { Item, Location, POLine } from '@/lib/api/inventory';
import { buildLowStockProposal, type VendorGroup } from '@/lib/inventory/low-stock-proposal';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

export interface GeneratePODialogProps {
  open: boolean;
  onClose: () => void;
  items: Item[];
  locations: Location[];
  scopeLabel?: string;
}

type RowDraft = { checked: boolean; qty: string };

export function GeneratePODialog({ open, onClose, items, locations, scopeLabel }: GeneratePODialogProps) {
  const navigate = useNavigate();
  const { data: vendors = [] } = useVendors();
  const createPO = useCreatePO();

  const groups: VendorGroup[] = useMemo(
    () => (open ? buildLowStockProposal(items, vendors) : []),
    [open, items, vendors],
  );

  // Draft state keyed by item id; manual vendor pick for the null group.
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [nullGroupVendorId, setNullGroupVendorId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next: Record<string, RowDraft> = {};
    for (const g of groups) {
      for (const l of g.lines) next[l.item.id] = { checked: true, qty: String(l.suggestedQty) };
    }
    setDrafts(next);
    setNullGroupVendorId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groups.length]);

  const locName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);

  const vendorOptions = useMemo(
    () =>
      vendors
        .filter((v) => v.status !== 'inactive')
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [vendors],
  );

  // A group is creatable when it has ≥1 checked line and a resolved vendor
  // (named group → its Vendor row; null group → the manual pick).
  const resolvedGroups = groups
    .map((g) => {
      const vendor =
        g.vendor ?? (g.vendorName === null ? vendorOptions.find((v) => v.id === nullGroupVendorId) : undefined);
      const checkedLines = g.lines.filter((l) => drafts[l.item.id]?.checked);
      return { group: g, vendor, checkedLines };
    })
    .filter((r) => r.checkedLines.length > 0);
  const creatable = resolvedGroups.filter((r) => !!r.vendor);
  const skipped = resolvedGroups.filter((r) => !r.vendor);

  async function handleCreate() {
    if (creatable.length === 0) return;
    setSubmitting(true);
    const failures: string[] = [];
    let created = 0;
    for (const { vendor, checkedLines } of creatable) {
      const lines: POLine[] = checkedLines.map(({ item, suggestedQty }) => {
        const qty = Math.max(1, Number(drafts[item.id]?.qty) || suggestedQty);
        return {
          itemSku: item.sku,
          itemName: item.name,
          uom: item.uom,
          qtyOrdered: qty,
          qtyReceived: 0,
          ...(item.unitCost != null ? { unitCost: item.unitCost } : {}),
          priceBookItemId: item.id,
        };
      });
      try {
        await createPO.mutateAsync({
          vendor: vendor!.name,
          vendorId: vendor!.id,
          status: 'draft',
          orderedAt: new Date().toISOString(),
          lines,
        });
        created += 1;
      } catch (err) {
        failures.push(`${vendor!.name}: ${extractApiError(err, 'create failed')}`);
      }
    }
    setSubmitting(false);
    if (failures.length > 0) {
      toast({
        title: `${failures.length} PO${failures.length === 1 ? '' : 's'} failed`,
        description: failures.join(' · '),
        variant: 'destructive',
      });
    }
    if (created > 0) {
      onClose();
      navigate('/inventory/purchase-orders?status=draft');
      toast({ title: `${created} draft PO${created === 1 ? '' : 's'} created` });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Generate purchase orders from low stock{scopeLabel ? ` at ${scopeLabel}` : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {groups.length === 0 && (
            <p className="py-6 text-center text-sm text-text-secondary">
              Nothing is below its reorder threshold.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.vendorName ?? '__none__'} className="rounded-card border border-border bg-surface-light">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background-light px-3 py-2">
                {g.vendorName != null ? (
                  <span className="text-sm font-semibold text-text-primary">
                    {g.vendorName}
                    <span className="ml-2 text-xs font-normal text-text-secondary">
                      {g.lines.length} line{g.lines.length === 1 ? '' : 's'}
                    </span>
                  </span>
                ) : (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">No preferred vendor</span>
                    <div className="min-w-[220px]">
                      <SelectField
                        value={nullGroupVendorId}
                        onValueChange={setNullGroupVendorId}
                        placeholder="Pick a vendor to order these from…"
                        aria-label="Vendor for unassigned items"
                        options={vendorOptions.map((v) => ({ value: v.id, label: v.name }))}
                      />
                    </div>
                  </div>
                )}
              </div>
              <table className="min-w-full text-sm">
                <tbody className="divide-y divide-border">
                  {g.lines.map(({ item, suggestedQty }) => {
                    const d = drafts[item.id] ?? { checked: true, qty: String(suggestedQty) };
                    const offending = item.stock.filter((s) => s.min != null && s.onHand < s.min);
                    return (
                      <tr key={item.id} className="hover:bg-background-light">
                        <td className="w-8 px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Order ${item.name}`}
                            checked={d.checked}
                            onChange={(e) =>
                              setDrafts((prev) => ({ ...prev, [item.id]: { ...d, checked: e.target.checked } }))
                            }
                            className="h-4 w-4 rounded border-border accent-primary"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-text-secondary">{item.sku}</td>
                        <td className="px-3 py-2 text-text-primary">{item.name}</td>
                        <td className="px-3 py-2 text-[11px] text-text-secondary">
                          {offending.map((s) => (
                            <span key={s.locationId} className="mr-2 whitespace-nowrap font-mono">
                              {locName.get(s.locationId) ?? s.locationId}: {s.onHand}/{s.min} min
                            </span>
                          ))}
                        </td>
                        <td className="w-24 px-3 py-2 text-right">
                          <Input
                            type="number"
                            min={1}
                            step="1"
                            aria-label={`Quantity for ${item.name}`}
                            value={d.qty}
                            onChange={(e) =>
                              setDrafts((prev) => ({ ...prev, [item.id]: { ...d, qty: e.target.value } }))
                            }
                            disabled={!d.checked}
                            className="w-20 px-1.5 py-0.5 text-right"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

          {skipped.length > 0 && (
            <p className="text-xs text-warning">
              {skipped.length === 1 ? 'One group is' : `${skipped.length} groups are`} skipped until a
              vendor is picked — the other POs still create.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="solid" tone="business" onClick={handleCreate} disabled={submitting || creatable.length === 0}>
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ShoppingCart className="mr-2 h-4 w-4" aria-hidden />
            )}
            Create {creatable.length} draft PO{creatable.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
