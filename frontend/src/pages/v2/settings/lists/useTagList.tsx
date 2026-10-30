import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAppAbility } from '@/contexts/AbilityContext';
import api from '@/lib/axios';
import type { Tag } from '@/lib/api/tags';
import { DEFAULT_TAG_COLOR } from '@/lib/tag-colors';
import { TAG_EMBEDDING_QUERY_KEYS } from '@/lib/tag-entities';

import { DeleteTagDialog } from './DeleteTagDialog';
import { TAGS_DEF, pluralise, type ListController, type ListItem } from './listDefs';

function toItem(tag: Tag): ListItem {
  const used = tag.usage_count ?? 0;
  return { id: tag.id, name: tag.name, archived: false, usedCount: used, usedText: pluralise(used, TAGS_DEF.usedWord), color: tag.color };
}

/**
 * The Tags card's adapter. Reads the SAME `['tags']` cache entry the record-page picker and the Tags filter use (one
 * request, one cache), which now also carries `usage_count`. A rename, recolour or delete changes what is drawn wherever
 * the tag already sits, so those drop every cached payload that embeds a copy of it (`TAG_EMBEDDING_QUERY_KEYS`).
 */
export function useTagList(): ListController {
  const qc = useQueryClient();
  const ability = useAppAbility();
  const query = useQuery({
    queryKey: ['tags'],
    queryFn: async () => ((await api.get('/api/tags')).data.tags ?? []) as Tag[],
  });

  const refreshTags = () => void qc.invalidateQueries({ queryKey: ['tags'] });
  const refreshEverywhere = () => {
    refreshTags();
    for (const key of TAG_EMBEDDING_QUERY_KEYS) void qc.invalidateQueries({ queryKey: [key] });
  };

  const create = useMutation({
    mutationFn: async (v: { name: string; color: string }) => (await api.post('/api/tags', v)).data.tag as Tag,
    onSuccess: refreshTags,
  });
  const update = useMutation({
    mutationFn: async (v: { id: string; name?: string; color?: string }) => {
      const { id, ...body } = v;
      return (await api.patch(`/api/tags/${id}`, body)).data.tag as Tag;
    },
    onSuccess: refreshEverywhere,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => void (await api.delete(`/api/tags/${id}`)),
    onSuccess: refreshEverywhere,
  });

  const withUsage = (tag: Tag): Tag => ({ ...tag, usage_count: tag.usage_count ?? query.data?.find((t) => t.id === tag.id)?.usage_count ?? 0 });

  const controller: ListController = {
    def: TAGS_DEF,
    items: (query.data ?? []).map(toItem),
    isLoading: query.isLoading,
    isError: query.isError,
    retry: () => void query.refetch(),
    canCreate: ability.can('create', 'Tag'),
    canEdit: ability.can('update', 'Tag'),
    canDelete: ability.can('delete', 'Tag'),
    defaultColour: DEFAULT_TAG_COLOR,
    create: async (name, colour) => toItem(withUsage(await create.mutateAsync({ name, color: colour ?? DEFAULT_TAG_COLOR }))),
    rename: async (id, name) => toItem(withUsage(await update.mutateAsync({ id, name }))),
    setColour: async (id, colour) => toItem(withUsage(await update.mutateAsync({ id, color: colour }))),
    archive: () => Promise.reject(new Error('Tags are deleted, not archived.')),
    unarchive: () => Promise.reject(new Error('Tags are deleted, not archived.')),
    reorder: () => Promise.reject(new Error('Tags have no manual order.')),
    remove: (id) => remove.mutateAsync(id),
    deleteDialog: (item, close) => <DeleteTagDialog item={item} remove={controller.remove} onClose={close} />,
  };
  return controller;
}
