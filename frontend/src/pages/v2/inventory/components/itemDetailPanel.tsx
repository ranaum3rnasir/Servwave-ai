import { AlertTriangle, ArrowRightLeft, Pencil, PackagePlus, Trash2, X } from 'lucide-react';

import { ItemIdentifiers } from '@/components/inventory/ItemIdentifiers';
import { useAppAbility } from '@/contexts/AbilityContext';
import { totalOnHand, type Item, type Location, type Movement } from '@/lib/api/inventory';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/ui-kit/components/ui/card';
import { Separator } from '@/ui-kit/components/ui/separator';

import { ItemThumb } from './itemThumb';

/** The small uppercase section label the panel repeats five times. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span role="heading" aria-level={3} className="text-muted-foreground text-[10px] font-semibold uppercase">
      {children}
    </span>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string | number; emphasis?: boolean }) {
  return (
    <div className="bg-muted rounded-md px-2 py-1.5">
      <p className="text-muted-foreground text-[10px] uppercase">{label}</p>
      <p className={cn('font-mono font-semibold', emphasis && 'text-status-green-emphasis')}>{value}</p>
    </div>
  );
}

const MOVEMENT_DOT: Record<string, string> = {
  receive: 'bg-status-green',
  consume: 'bg-status-red',
  transfer: 'bg-status-blue',
};

/**
 * The selected item's detail pane.
 *
 * Same five sections, same copy and same four footer actions as the legacy
 * `DetailPanel`, rebuilt on the kit Card. The one structural change is that it
 * no longer owns its own width and border - `MasterDetail` provides the aside,
 * so the panel is just the card that sits in it.
 *
 * The header carries the model number / part number / finish line, the same one
 * the grid prints, because this panel is where an operator reads a row rather
 * than scans the list. Finish is a foreign key, so the page resolves it and
 * hands the name down; no `finishName` simply renders no finish segment.
 */
export function ItemDetailPanel({
  item, finishName, locations, movements, onClose, onTransfer, onDelete, onEdit, onRestock,
  onSetThresholds,
}: {
  item: Item;
  /** Resolved finish name - see `ItemIdentifiers`. */
  finishName?: string;
  locations: Location[];
  movements: Movement[];
  onClose: () => void;
  onTransfer: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRestock: () => void;
  onSetThresholds: () => void;
}) {
  // #2043 - the panel is inside the AbilityProvider tree, so it reads the
  // ability itself rather than taking booleans through props.
  const ability = useAppAbility();
  const canUpdateInventory = ability.can('update', 'Inventory');
  const canUpdatePriceBook = ability.can('update', 'PriceBook');
  const canDeletePriceBook = ability.can('delete', 'PriceBook');

  return (
    <Card className="gap-0">
      <CardHeader className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <ItemThumb item={item} size="lg" />
          <div className="min-w-0">
            <span className="text-muted-foreground font-mono text-[11px]">{item.sku}</span>
            <p role="heading" aria-level={2} className="mt-0.5 font-semibold">{item.name}</p>
            <ItemIdentifiers item={item} finishName={finishName} className="mt-0.5 text-muted-foreground" />
            <Badge variant="softNeutral" size="pill" className="mt-1">{item.category}</Badge>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close item details" onClick={onClose}>
          <X />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-4 py-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat label="On Hand" value={totalOnHand(item)} />
          <Stat label="Avail" value={totalOnHand(item)} emphasis />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat
            label="Unit Cost"
            value={item.unitCost != null ? formatCurrency(item.unitCost) : '-'}
          />
          <Stat label="Sell Price" value={formatCurrency(item.sellPrice)} />
        </div>
      </CardContent>

      <Separator />

      <CardContent className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>By Location</SectionLabel>
          {canUpdateInventory && (
            <Button variant="ghost" size="sm" onClick={onSetThresholds}>Reserve levels</Button>
          )}
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          {item.stock.map((s) => {
            const loc = locations.find((l) => l.id === s.locationId);
            if (!loc) return null;
            const low = s.min != null && s.onHand < s.min;
            return (
              <li key={s.locationId} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs">
                <span className="flex items-center gap-1.5 font-medium">
                  {loc.name}
                  {low && <AlertTriangle aria-label="below min" className="text-status-amber-emphasis size-3" />}
                </span>
                <span className="flex items-center gap-3 font-mono">
                  <span className="font-semibold">{s.onHand}</span>
                  {s.min != null && <span className="text-muted-foreground text-[10px]">min {s.min}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>

      {item.serialized && item.serials && item.serials.length > 0 && (
        <>
          <Separator />
          <CardContent className="px-4 py-3">
            <SectionLabel>Serial Numbers</SectionLabel>
            <div className="mt-2 flex flex-wrap gap-1">
              {item.serials.map((s) => (
                <Badge key={s} variant="softNeutral" size="sm">{s}</Badge>
              ))}
            </div>
          </CardContent>
        </>
      )}

      <Separator />

      <CardContent className="px-4 py-3">
        <SectionLabel>Recent Stock Movements</SectionLabel>
        <ul className="mt-2 flex flex-col gap-2">
          {movements.length === 0 ? (
            <li className="text-muted-foreground text-xs">No movements recorded yet.</li>
          ) : (
            movements.map((m) => (
              <li key={m.id} className="flex items-start gap-2 text-xs">
                <span
                  className={cn(
                    'mt-1 inline-block size-2 shrink-0 rounded-full',
                    MOVEMENT_DOT[m.type] ?? 'bg-status-amber',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium capitalize">
                    {m.type} <span className="font-mono">{m.qty > 0 ? `+${m.qty}` : m.qty}</span> {item.uom}
                  </p>
                  <p className="text-muted-foreground text-[11px]">{m.reference}</p>
                  <p className="text-muted-foreground text-[10px]">
                    {m.actor} ·{' '}
                    {new Date(m.occurredAt).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
              </li>
            ))
          )}
        </ul>
      </CardContent>

      <CardFooter className="mt-auto flex-col gap-2 border-t px-4 py-3">
        {canUpdateInventory && (
          <div className="flex w-full gap-2">
            <Button size="sm" className="flex-1" onClick={onRestock}>
              <PackagePlus />Restock
            </Button>
            <Button size="sm" className="flex-1" onClick={onTransfer}>
              <ArrowRightLeft />Transfer
            </Button>
          </div>
        )}
        <div className="flex w-full gap-2">
          {/* #2043 - this is the read-only requester's only entry point into
              the item detail (Ran's Decision: cost/sell price/GM stay
              visible). Always renders; the label distinguishes the mode. */}
          <Button variant="outline" size="sm" className="flex-1" onClick={onEdit}>
            <Pencil />{canUpdatePriceBook ? 'Edit' : 'View'}
          </Button>
          {canDeletePriceBook && (
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Delete item"
              title="Delete item"
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
