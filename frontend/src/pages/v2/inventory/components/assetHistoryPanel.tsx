/**
 * The selected asset's detail pane, rebuilt on the CRM UI kit.
 *
 * Originally a presentation swap over `components/inventory/assets/
 * AssetHistoryDrawer.tsx`. THAT FILE IS GONE - its only importer was the v1
 * `AssetsView.tsx`, itself reachable only from the dead v1
 * `pages/inventory/InventoryPage.tsx`, so both were deleted together and this
 * is now the only asset detail pane in the tree. The parity notes below stay
 * as the record of what this file promised to preserve when it took over.
 *
 * Same `useAssetEvents(asset.id)` query, same state-dependent action set
 * (assign vs transfer/return, note, edit, retire - all suppressed once the
 * asset is RETIRED), same append-only server-ordered timeline and the same
 * copy, including the `Close asset panel` and `Retire asset` labels.
 *
 * Like `itemDetailPanel`, it no longer owns its width and border: MasterDetail
 * supplies the aside, so this is only the card that sits in it. The legacy
 * `animate-panel-in` entry animation has no kit counterpart and is dropped -
 * the same delta the Stock detail panel already records.
 */
import { ArchiveX, ArrowRightLeft, Pencil, StickyNote, Undo2, UserPlus, X } from 'lucide-react';

import { useAssetEvents, type Asset, type AssetEventType } from '@/lib/api/inventory';
import type { AssetActionMode } from '@/components/inventory/assets/AssetActionDialog';
import { useAppAbility } from '@/contexts/AbilityContext';
// KEPT LEGACY: the kit ships no image primitive and the raw-<img> ratchet is
// at its floor, so a v2 file cannot author a thumbnail. See BUILD #8.
import { AssetThumb } from '@/components/inventory/assets/AssetBits';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent, CardHeader } from '@/ui-kit/components/ui/card';
import { Separator } from '@/ui-kit/components/ui/separator';

import { StatusChip } from '../../_shared/statusChip';

const EVENT_LABEL: Record<AssetEventType, string> = {
  ASSIGNED: 'Assigned',
  RETURNED: 'Returned',
  TRANSFERRED: 'Transferred',
  RETIRED: 'Retired',
  NOTE: 'Note',
};

/**
 * Dot colour per event type - the kit's status tokens standing in for the
 * legacy semantic ones. Green stays reserved for the positive signal (a tool
 * going out to a tech); NOTE stays neutral.
 */
const EVENT_DOT: Record<AssetEventType, string> = {
  ASSIGNED: 'bg-status-green',
  RETURNED: 'bg-status-blue',
  TRANSFERRED: 'bg-status-purple',
  RETIRED: 'bg-status-red',
  NOTE: 'bg-subtle-foreground',
};

export function AssetHistoryPanel({
  asset, onClose, onEdit, onAction,
}: {
  asset: Asset;
  onClose: () => void;
  onEdit: () => void;
  onAction: (mode: AssetActionMode) => void;
}) {
  const eventsQuery = useAssetEvents(asset.id);
  const events = eventsQuery.data ?? [];
  const retired = asset.status === 'RETIRED';

  // #2043 R2 - the history panel is a write surface, not a read: Transfer,
  // Return, Assign, Add note, Edit and Retire all ride POST
  // /assets/:id/{assign,transfer,return,note,retire} or PATCH /assets/:id -
  // all `update Inventory` (inv-assets.routes.ts:23,30-34). The event
  // timeline itself stays ungated.
  const ability = useAppAbility();
  const canUpdate = ability.can('update', 'Inventory');

  return (
    <Card className="gap-0">
      <CardHeader className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <AssetThumb asset={asset} size={56} />
          <div className="min-w-0">
            <p role="heading" aria-level={2} className="font-semibold">{asset.name}</p>
            {asset.serial && (
              <code className="text-muted-foreground font-mono text-[11px]">{asset.serial}</code>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusChip domain="asset" status={asset.status} />
              <span className="text-muted-foreground text-[11px]">
                {asset.assigned_user
                  ? `Held by ${asset.assigned_user.first_name} ${asset.assigned_user.last_name}`
                  : 'Unassigned'}
              </span>
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close asset panel" onClick={onClose}>
          <X />
        </Button>
      </CardHeader>

      {(asset.price_book_item || asset.notes) && (
        <CardContent className="border-b px-4 py-3 text-xs">
          {asset.price_book_item && (
            <p className="text-muted-foreground">
              Catalog item: <span className="text-foreground font-medium">{asset.price_book_item.name}</span>
            </p>
          )}
          {asset.notes && (
            <p className="text-muted-foreground mt-1 whitespace-pre-wrap">{asset.notes}</p>
          )}
        </CardContent>
      )}

      {/* Action buttons - per current state */}
      {canUpdate && (
        <CardContent className="flex flex-col gap-2 border-b px-4 py-3">
          {!retired && (
            <div className="flex gap-2">
              {asset.assigned_user ? (
                <>
                  <Button size="sm" className="flex-1" onClick={() => onAction('transfer')}>
                    <ArrowRightLeft />
                    Transfer
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => onAction('return')}>
                    <Undo2 />
                    Return
                  </Button>
                </>
              ) : (
                <Button size="sm" className="flex-1" onClick={() => onAction('assign')}>
                  <UserPlus />
                  Assign
                </Button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={() => onAction('note')}>
              <StickyNote />
              Add note
            </Button>
            <Button variant="outline" size="sm" className="flex-1" onClick={onEdit}>
              <Pencil />
              Edit
            </Button>
            {!retired && (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Retire asset"
                title="Retire asset"
                onClick={() => onAction('retire')}
              >
                <ArchiveX />
              </Button>
            )}
          </div>
        </CardContent>
      )}

      <Separator />

      {/* Event timeline */}
      <CardContent className="px-4 py-3">
        <span role="heading" aria-level={3} className="text-muted-foreground text-[10px] font-semibold uppercase">
          History
        </span>
        <ul className="mt-2 flex flex-col gap-2">
          {eventsQuery.isLoading ? (
            <li className="text-muted-foreground text-xs">Loading history…</li>
          ) : events.length === 0 ? (
            <li>
              {/* #2043 visual round - "it starts with the first assign" points
                  a requester without `update Inventory` at an action they
                  cannot take; drop the hint for them and keep it for a
                  requester who can actually assign the asset. */}
              <EmptyState
                title={canUpdate ? 'No history yet - it starts with the first assign.' : 'No history yet.'}
              />
            </li>
          ) : (
            events.map((ev) => (
              <li key={ev.id} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 inline-block size-2 shrink-0 rounded-full ${EVENT_DOT[ev.type]}`} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {EVENT_LABEL[ev.type]}
                    {ev.user && <> · {ev.user.first_name} {ev.user.last_name}</>}
                  </p>
                  {ev.note && (
                    <p className="text-muted-foreground whitespace-pre-wrap text-[11px]">{ev.note}</p>
                  )}
                  <p className="text-muted-foreground text-[10px]">
                    by{' '}
                    {ev.by_user ? `${ev.by_user.first_name} ${ev.by_user.last_name}` : 'Unknown user'}
                    {' · '}
                    {new Date(ev.at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </li>
            ))
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
