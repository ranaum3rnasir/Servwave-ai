import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAppAbility } from '@/contexts/AbilityContext';
import type { OrgListApi, OrgListResponse, OrgListRow } from '@/lib/api/orgListRows';
import { pluralise, type ListController, type ListDef, type ListItem } from './listDefs';

function toItem(def: ListDef, row: OrgListRow): ListItem {
  return { id: row.id, name: row.name, archived: row.archived, usedCount: row.used_count, usedText: pluralise(row.used_count, def.usedWord) };
}

/**
 * The shared adapter for a list stored as rows (Job types, Lead/Customer sources): React Query reads and writes, mapped
 * to the card engine's `ListController`. A write puts the server's answer straight into the cache (so the card is right
 * at once) and then refetches, which refreshes the used-by numbers; it also drops `['organization']`, which is what the
 * lead and job forms read their menus from.
 */
export function useRowsList(def: ListDef, queryKey: readonly string[], api: OrgListApi): ListController {
  const qc = useQueryClient();
  const ability = useAppAbility();
  const query = useQuery({ queryKey, queryFn: api.list });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey });
    void qc.invalidateQueries({ queryKey: ['organization'] });
  };
  const patchCache = (fn: (items: OrgListRow[]) => OrgListRow[]) =>
    qc.setQueryData<OrgListResponse>(queryKey, (cur) => {
      if (!cur) return cur;
      const items = fn(cur.items);
      const archived = items.filter((i) => i.archived).length;
      return { items, counts: { active: items.length - archived, archived } };
    });
  const replace = (row: OrgListRow) => patchCache((items) => items.map((i) => (i.id === row.id ? row : i)));

  const create = useMutation({
    mutationFn: api.create,
    onSuccess: (row) => {
      patchCache((items) => [...items, row]);
      refresh();
    },
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.rename(v.id, v.name),
    onSuccess: (row) => {
      replace(row);
      refresh();
    },
  });
  const archive = useMutation({
    mutationFn: api.archive,
    onSuccess: (row) => {
      replace(row);
      refresh();
    },
  });
  const unarchive = useMutation({
    mutationFn: api.unarchive,
    onSuccess: (row) => {
      replace(row);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: api.remove,
    onSuccess: (_v, id) => {
      patchCache((items) => items.filter((i) => i.id !== id));
      refresh();
    },
  });
  const reorder = useMutation({
    mutationFn: api.reorder,
    // The new order shows at once; a failed save puts the old one back.
    onMutate: async (orderedIds: string[]) => {
      await qc.cancelQueries({ queryKey });
      const before = qc.getQueryData<OrgListResponse>(queryKey);
      patchCache((items) => {
        const byId = new Map(items.map((i) => [i.id, i]));
        const active = orderedIds.map((id, n) => ({ ...byId.get(id)!, sort_order: n })).filter((r) => r.id);
        return [...active, ...items.filter((i) => i.archived)];
      });
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(queryKey, ctx.before);
    },
    onSettled: refresh,
  });

  const items = (query.data?.items ?? []).map((r) => toItem(def, r));

  return {
    def,
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    retry: () => void query.refetch(),
    canCreate: ability.can('update', 'Organization'),
    canEdit: ability.can('update', 'Organization'),
    canDelete: false,
    defaultColour: '',
    setColour: () => Promise.reject(new Error('This list has no colour.')),
    create: async (name) => toItem(def, await create.mutateAsync(name)),
    rename: async (id, name) => toItem(def, await rename.mutateAsync({ id, name })),
    archive: async (id) => void (await archive.mutateAsync(id)),
    unarchive: async (id) => void (await unarchive.mutateAsync(id)),
    reorder: (ids) => reorder.mutateAsync(ids),
    remove: (id) => remove.mutateAsync(id),
  };
}
