/**
 * The Assets tab body, rebuilt on the CRM UI kit.
 *
 * Originally a presentation swap over `components/inventory/assets/
 * AssetsView.tsx`. THAT FILE IS GONE - it was reachable only from the dead v1
 * `pages/inventory/InventoryPage.tsx`, so it was deleted along with it and
 * this is now the only Assets tab body in the tree. The "unchanged" and "what
 * moved" notes below stay because they are the record of what this file
 * promised to preserve when it took over; they are no longer a diff you can
 * run against a second file that still exists.
 *
 * Unchanged: the `useAssets(filters, 1)` query and its filter shape (the
 * retired toggle still switches between sending `status: 'ACTIVE'` and sending
 * no status at all), the 300ms search debounce, `useUsers` for the assignee
 * picker, the `useDeleteAsset` mutation with its delete-confirmation guard and
 * both toast strings, and the two empty states (filtered vs nothing-yet, the
 * second keeping its create action).
 *
 * What moved onto the kit:
 *   - the header row becomes a kit PageHeader plus a kit filter row.
 *   - the raw search `<input>` becomes the kit SearchInput, keeping the
 *     `Search assets…` placeholder the spec selects on.
 *   - the native `<select>` becomes a kit Select, keeping `Filter by assignee`.
 *   - the raw checkbox becomes a kit Checkbox + Label, keeping `Show retired`.
 *   - the hand-rolled `<table>` becomes a kit DataTable.
 *   - the hand-rolled absolute-positioned kebab becomes a kit DropdownMenu,
 *     keeping the `More actions for <name>` label and the exact same
 *     state-dependent item set.
 *   - the `w-96` aside becomes kit MasterDetail's detail pane, holding the
 *     rebuilt `AssetHistoryPanel`.
 *
 * KEPT LEGACY: `AssetDialog` and `AssetActionDialog` (create/edit plus the
 * assign/transfer/return/note/retire mutations), and `AssetThumb` - the kit
 * ships no image primitive and the raw-<img> ratchet is at its floor.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArchiveX, ArrowRightLeft, MoreHorizontal, Pencil, StickyNote, Trash2, Undo2, UserPlus, Wrench,
} from 'lucide-react';

import { useAssets, useDeleteAsset, type Asset, type AssetFilters } from '@/lib/api/inventory';
import { useUsers } from '@/lib/api/users';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useConfirm } from '@/hooks/useConfirm';
import { AssetDialog } from '@/components/inventory/assets/AssetDialog';
import { AssetActionDialog, type AssetActionMode } from '@/components/inventory/assets/AssetActionDialog';
import { AssetThumb } from '@/components/inventory/assets/AssetBits';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { MasterDetail } from '@/ui-kit/components/layout/masterDetail';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { cn } from '@/ui-kit/lib/utils';

import { StatusChip } from '../../_shared/statusChip';
import { EM_DASH } from '../glyphs';
import { AssetHistoryPanel } from './assetHistoryPanel';

type EditorState = null | { asset: Asset | null }; // null asset = create
type ActionState = null | { mode: AssetActionMode; asset: Asset };

interface RowActions {
  onAction: (mode: AssetActionMode, asset: Asset) => void;
  onEdit: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  canUpdate: boolean;
  canDelete: boolean;
}

function buildAssetColumns(actions: RowActions): ColumnDef<Asset, unknown>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: 'Name',
      size: 280,
      meta: { label: 'Name', fixed: true },
      cell: ({ row }) => {
        const asset = row.original;
        return (
          // Retired rows read dimmed. The kit table has no per-row class hook,
          // so the dim lands on the cells that carry text rather than on the
          // <tr> - the RETIRED status chip is still the primary signal.
          <span className={cn('flex items-center gap-2.5', asset.status === 'RETIRED' && 'opacity-60')}>
            <AssetThumb asset={asset} size={40} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{asset.name}</span>
              {asset.price_book_item && (
                <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">
                  {asset.price_book_item.name}
                </span>
              )}
            </span>
          </span>
        );
      },
    },
    {
      id: 'serial',
      accessorKey: 'serial',
      header: 'Serial',
      size: 140,
      meta: { label: 'Serial', fixed: true },
      cell: ({ row }) =>
        row.original.serial ? (
          <code className="font-mono text-xs">{row.original.serial}</code>
        ) : (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ),
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: 'Status',
      size: 110,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="asset" status={row.original.status} />,
    },
    {
      id: 'assignee',
      accessorKey: 'assigned_user',
      header: 'Assignee',
      size: 170,
      meta: { label: 'Assignee' },
      cell: ({ row }) => {
        const user = row.original.assigned_user;
        return user ? (
          <span>{user.first_name} {user.last_name}</span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        );
      },
    },
    {
      id: 'updated',
      accessorKey: 'updated_at',
      header: 'Updated',
      size: 150,
      meta: { label: 'Updated', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs" title={new Date(row.original.updated_at).toLocaleString()}>
          {formatDistanceToNow(new Date(row.original.updated_at), { addSuffix: true })}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 60,
      enableHiding: false,
      meta: { label: 'Actions', fixed: true },
      cell: ({ row }) => {
        const asset = row.original;
        const retired = asset.status === 'RETIRED';
        const { canUpdate, canDelete } = actions;
        // #2043 §D - every entry here rides POST /assets/:id/{assign,transfer,
        // return,note,retire} or PATCH /assets/:id (update Inventory) except
        // Delete (delete Inventory). When nothing survives, drop the trigger
        // itself rather than open an empty menu.
        if (!canUpdate && !canDelete) return null;
        return (
          <span className="flex justify-end" onClick={(e) => e.stopPropagation()} role="presentation">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${asset.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {canUpdate && !retired && !asset.assigned_user && (
                  <DropdownMenuItem onSelect={() => actions.onAction('assign', asset)}>
                    <UserPlus />
                    Assign
                  </DropdownMenuItem>
                )}
                {canUpdate && !retired && asset.assigned_user && (
                  <>
                    <DropdownMenuItem onSelect={() => actions.onAction('transfer', asset)}>
                      <ArrowRightLeft />
                      Transfer
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => actions.onAction('return', asset)}>
                      <Undo2 />
                      Return
                    </DropdownMenuItem>
                  </>
                )}
                {canUpdate && (
                  <DropdownMenuItem onSelect={() => actions.onAction('note', asset)}>
                    <StickyNote />
                    Add note
                  </DropdownMenuItem>
                )}
                {canUpdate && (
                  <DropdownMenuItem onSelect={() => actions.onEdit(asset)}>
                    <Pencil />
                    Edit
                  </DropdownMenuItem>
                )}
                {canUpdate && !retired && (
                  <DropdownMenuItem onSelect={() => actions.onAction('retire', asset)}>
                    <ArchiveX />
                    Retire
                  </DropdownMenuItem>
                )}
                {canUpdate && canDelete && <DropdownMenuSeparator />}
                {canDelete && (
                  <DropdownMenuItem variant="destructive" onSelect={() => actions.onDelete(asset)}>
                    <Trash2 />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        );
      },
    },
  ];
}

export function AssetsView({ onToast }: { onToast: (msg: string) => void }) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [assigneeId, setAssigneeId] = useState<string>('all');
  const [showRetired, setShowRetired] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [action, setAction] = useState<ActionState>(null);
  const retiredCheckboxId = useId();
  const { confirm, confirmDialog } = useConfirm();

  // #2043 §D - the panel is inside the AbilityProvider tree, so it reads the
  // ability itself rather than taking booleans through props.
  const ability = useAppAbility();
  const canCreateInventory = ability.can('create', 'Inventory');
  const canUpdateInventory = ability.can('update', 'Inventory');
  const canDeleteInventory = ability.can('delete', 'Inventory');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Retired filter: unchecked (default) sends status ACTIVE; checked sends no
  // status (all rows) - retired rows render dimmed with a gray RETIRED pill.
  const filters = useMemo<AssetFilters>(
    () => ({
      ...(showRetired ? {} : { status: 'ACTIVE' as const }),
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      ...(assigneeId !== 'all' ? { assigned_user_id: assigneeId } : {}),
    }),
    [showRetired, debouncedSearch, assigneeId],
  );

  const assetsQuery = useAssets(filters, 1);
  const assets = useMemo(() => assetsQuery.data?.data ?? [], [assetsQuery.data]);
  const usersQuery = useUsers();
  const users = usersQuery.data ?? [];
  const deleteAsset = useDeleteAsset();

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedId) ?? null,
    [assets, selectedId],
  );

  const hasFilters = showRetired || debouncedSearch.trim() !== '' || assigneeId !== 'all';
  const total = assetsQuery.data?.meta.total ?? 0;

  async function handleDelete(asset: Asset) {
    if (
      !(await confirm({
        title: `Delete "${asset.name}"?`,
        description: "Its history is deleted with it. This can't be undone.",
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return;
    try {
      await deleteAsset.mutateAsync({ id: asset.id });
    } catch {
      onToast(`✗ Could not delete "${asset.name}" ${EM_DASH} try again.`);
      return;
    }
    if (selectedId === asset.id) setSelectedId(null);
    onToast(`✓ "${asset.name}" deleted`);
  }

  const columns = useMemo(
    () =>
      buildAssetColumns({
        onAction: (mode, asset) => setAction({ mode, asset }),
        onEdit: (asset) => setEditor({ asset }),
        onDelete: (asset) => { void handleDelete(asset); },
        canUpdate: canUpdateInventory,
        canDelete: canDeleteInventory,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, canUpdateInventory, canDeleteInventory],
  );

  return (
    <div>
      {/* The legacy view had no header block at all - its create button sat in
          the filter row. The title is the tab's own label, so no new copy is
          introduced; it just gives this tab the same shape as its five
          siblings. */}
      <PageHeader
        title="Assets"
        actions={
          canCreateInventory ? (
            <Button size="sm" onClick={() => setEditor({ asset: null })}>
              <Wrench />
              New Asset
            </Button>
          ) : undefined
        }
      />

      <MasterDetail
        // Same collapse the Items tab does: with nothing selected the aside has
        // neither a detail nor a placeholder to show, so it takes no width and
        // the table fills the row instead of stopping two thirds across.
        className={selectedAsset ? undefined : 'gap-0'}
        detailWidth={selectedAsset ? undefined : '0px'}
        list={
          <DataTable
            columns={columns}
            data={assets}
            getRowId={(asset) => asset.id}
            isLoading={assetsQuery.isLoading}
            onRowClick={(asset) => setSelectedId(asset.id)}
            enableColumnResizing
            mobileCards
            empty={
              hasFilters ? (
                <EmptyState title="No assets match your filters." />
              ) : (
                <EmptyState
                  icon={<Wrench />}
                  title="No assets yet - track company tools and who holds them."
                  action={
                    canCreateInventory ? (
                      <Button size="sm" onClick={() => setEditor({ asset: null })}>
                        New Asset
                      </Button>
                    ) : undefined
                  }
                />
              )
            }
          >
            {() => (
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <div className="min-w-[12rem] max-w-md flex-1">
                  <SearchInput value={search} onValueChange={setSearch} placeholder="Search assets…" />
                </div>
                <SelectField
                  value={assigneeId}
                  onValueChange={setAssigneeId}
                  size="sm"
                  aria-label="Filter by assignee"
                  className="w-44"
                  options={[
                    { value: 'all', label: 'Anyone' },
                    ...users
                      .filter((u) => u.is_active)
                      .map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}` })),
                  ]}
                />
                <span className="flex items-center gap-2">
                  <Checkbox
                    id={retiredCheckboxId}
                    checked={showRetired}
                    onCheckedChange={(checked) => setShowRetired(checked === true)}
                  />
                  <Label htmlFor={retiredCheckboxId} className="text-muted-foreground text-sm font-medium">
                    Show retired
                  </Label>
                </span>
                <span className="text-muted-foreground text-xs">
                  {total} asset{total === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </DataTable>
        }
        hasSelection={!!selectedAsset}
        onBack={() => setSelectedId(null)}
        backLabel="Back to assets"
        detail={
          selectedAsset ? (
            <AssetHistoryPanel
              asset={selectedAsset}
              onClose={() => setSelectedId(null)}
              onEdit={() => setEditor({ asset: selectedAsset })}
              onAction={(mode) => setAction({ mode, asset: selectedAsset })}
            />
          ) : undefined
        }
      />

      {/* Mounted only while open: AssetDialog's dup-serial check queries the
          full asset list, and that fetch should not fire on every view render. */}
      {editor && (
        <AssetDialog open onClose={() => setEditor(null)} editAsset={editor.asset} onSaved={onToast} />
      )}
      {action && (
        <AssetActionDialog
          open
          mode={action.mode}
          asset={action.asset}
          onClose={() => setAction(null)}
          onDone={onToast}
        />
      )}
      {confirmDialog}
    </div>
  );
}
