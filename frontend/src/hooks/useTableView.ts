import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/use-toast';
import { getTableView, putTableView } from '@/lib/api/table-views';
import type { TableViewConfig, ColumnPref } from '@/lib/api/table-views';

// ─── applySavedView utility ───────────────────────────────

type ColumnDef = { id: string; minWidth?: number; maxWidth?: number; locked?: boolean }

export function applySavedView(
  defaults: Record<string, ColumnPref>,
  saved: TableViewConfig | null,
  columnDefs: ColumnDef[]
): Record<string, ColumnPref> {
  if (saved === null) return defaults;

  const result: Record<string, ColumnPref> = {};

  for (const col of columnDefs) {
    const savedPref = saved.columns[col.id];
    if (!savedPref) {
      // Fill missing with default
      result[col.id] = defaults[col.id] ?? {};
      continue;
    }

    const pref: ColumnPref = { ...savedPref };

    // Clamp width
    if (pref.width !== undefined) {
      const min = col.minWidth ?? 64;
      const max = col.maxWidth ?? 1200;
      pref.width = Math.min(Math.max(pref.width, min), max);
    }

    // Force visible for locked columns
    if (col.locked) {
      pref.visible = true;
    }

    result[col.id] = pref;
  }

  return result;
}

// ─── useTableView hook ────────────────────────────────────

export function useTableView(tableKey: string) {
  const qc = useQueryClient();

  const query = useQuery<TableViewConfig | null>({
    queryKey: ['table-views', tableKey],
    queryFn: () => getTableView(tableKey),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: tableKey !== '__no_key__',
  });

  const mutation = useMutation({
    mutationFn: (config: TableViewConfig) => putTableView(tableKey, config),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['table-views', tableKey] });
      toast({ title: 'Saved to your account' });
    },
  });

  return {
    isLoading: query.isLoading,
    // `undefined` while the query is still resolving, `null` once settled with
    // no stored view. The DataTable restore effect distinguishes the two so it
    // applies a saved view exactly once — after the fetch settles, not on the
    // initial loading render (which would otherwise burn its run-once guard).
    config: query.isLoading ? undefined : (query.data ?? null),
    saveView: (config: TableViewConfig) => mutation.mutate(config),
  };
}
