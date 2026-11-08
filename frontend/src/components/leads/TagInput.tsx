import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { X, Plus, ArrowDownAZ, ArrowUpAZ } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { TAG_COLORS } from '@/lib/tag-colors';
import { TAG_ENTITY_ROUTES, TAG_EMBEDDING_QUERY_KEYS, type TagEntityType } from '@/lib/tag-entities';

interface Tag {
  id: string;
  name: string;
  color: string;
}

// SRVW-103 - one lookup per TagEntity value: the write route segment, and the detail
// query key the host page reads so an add/remove refetches it. Shared with
// TagsSettingsCard via `@/lib/tag-entities` so the two cannot disagree on the set.
type EntityType = TagEntityType;

interface TagInputProps {
  /** @deprecated Use entityType + entityId. Kept so existing call sites compile. */
  leadId?: string;
  entityType?: EntityType;
  entityId?: string;
  tags: Tag[];
}

export function TagInput(props: TagInputProps) {
  const { tags } = props;
  const entityType: EntityType = props.entityType ?? 'LEAD';
  const entityId: string = (props.entityId ?? props.leadId) as string;
  const { path: resourcePath, detailKey: invalidationKey } = TAG_ENTITY_ROUTES[entityType];
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [color, setColor] = useState<string>(TAG_COLORS[0]!);
  const [sortAsc, setSortAsc] = useState(true);
  const queryClient = useQueryClient();

  // Fetch all tags for autocomplete
  const { data: allTags, refetch: refetchTags } = useQuery({
    queryKey: ['tags'],
    queryFn: async () => {
      const { data } = await api.get('/api/tags');
      return data.tags as Tag[];
    },
  });

  // Attaching or detaching a tag changes this record's chip row AND every other
  // cached payload that carries a copy of that tag: the list pages, which each
  // render a Tags column, and the schedule board, which reads the very same
  // /api/jobs and /api/leads list endpoints (tags attached) under its own four
  // keys. Both writers drop the same set - a detached chip is exactly as visible
  // on a list row or a board card as an attached one.
  //
  // ['tags'] is the tag vocabulary - this picker's autocomplete and the Settings
  // management card now read the very same key, so a write on either side lands
  // in one cache rather than two that can disagree.
  //
  // Derived from the shared entity map rather than hand-listed - hand-listing is
  // how the settings card came to cover two of the five taggable types (#1753).
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [invalidationKey, entityId] });
    void queryClient.invalidateQueries({ queryKey: ['tags'] });
    for (const key of TAG_EMBEDDING_QUERY_KEYS) {
      // Skip this entity's bare detail key: only THIS record's detail changed,
      // and it was just dropped record-scoped above. Dropping the prefix too
      // would cancel and restart that same in-flight refetch, because
      // invalidateQueries defaults to cancelRefetch: true - one tag click, two
      // GETs of the record.
      if (key === invalidationKey) continue;
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  // A tag write can fail because someone else changed the vocabulary underneath
  // this page: an admin deletes a tag in Settings, and a colleague who has not
  // reloaded still has it in their picker. The API answers 404 with a `code`
  // saying so. Both branches must be LOUD - the click used to be swallowed
  // silently, which reads as the app ignoring you, and the dead entry stayed in
  // the list to be clicked again.
  const handleWriteError = (err: unknown, fallbackTitle: string) => {
    const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;

    if (code === 'TAG_NOT_FOUND' || code === 'TAG_NOT_ATTACHED') {
      // Self-heal on the same click that exposed the staleness, so the entry
      // leaves the picker instead of failing identically on the next attempt.
      invalidate();
      toast({
        variant: 'destructive',
        title: 'That tag is no longer available',
        description: 'Someone else changed or deleted it. The tag list has been refreshed.',
      });
      return;
    }

    toast({
      variant: 'destructive',
      title: fallbackTitle,
      description: extractApiError(err, 'Please try again.'),
    });
  };

  // Add tag mutation
  const addTag = useMutation({
    mutationFn: async (body: { tag_id?: string; name?: string; color?: string }) => {
      const { data } = await api.post(`/api/${resourcePath}/${entityId}/tags`, body);
      return data.tag;
    },
    onSuccess: () => {
      invalidate();
      setSearch('');
      setOpen(false);
    },
    onError: (err) => handleWriteError(err, "Couldn't add tag"),
  });

  // Remove tag mutation
  const removeTag = useMutation({
    mutationFn: async (tagId: string) => {
      await api.delete(`/api/${resourcePath}/${entityId}/tags/${tagId}`);
    },
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => handleWriteError(err, "Couldn't remove tag"),
  });

  // Available tags: exclude already-attached; suggestions additionally match search
  const attachedIds = new Set(tags.map(t => t.id));
  const availableCount = (allTags ?? []).filter(t => !attachedIds.has(t.id)).length;
  const suggestions = (allTags ?? [])
    .filter(t => !attachedIds.has(t.id))
    .filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name) * (sortAsc ? 1 : -1));

  const exactMatch = (allTags ?? []).some(t => t.name.toLowerCase() === search.trim().toLowerCase());
  const showCreate = search.trim().length > 0 && !exactMatch;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Existing tags */}
      {tags.map(tag => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-on-fill"
          style={{ backgroundColor: tag.color }}
        >
          {tag.name}
          {/* Close-X inside a coloured chip - not Button-shaped. Deferred. */}
          <button
            className="ml-0.5 hover:opacity-70 transition-opacity"
            onClick={() => removeTag.mutate(tag.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {/* Add-tag popover */}
      <Popover
        open={open}
        onOpenChange={value => {
          setOpen(value);
          // The vocabulary is shared and small, and the app's default staleTime is
          // five minutes - long enough for a tag deleted in Settings to still be
          // sitting in this list. Refetching on open is the cheapest way to shrink
          // that window to nothing that matters; handleWriteError covers the race
          // that remains.
          if (value) void refetchTags();
          if (!value) { setSearch(''); setColor(TAG_COLORS[0]!); }
        }}
      >
        <PopoverTrigger asChild>
          {/* Dashed "add" pill (rounded-full border-dashed) - the same dashed-CTA family with
              no matching cell already deferred at AddStepButton.tsx. Deferred. */}
          <button
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-text-secondary',
              'hover:border-primary hover:text-primary transition-colors'
            )}
          >
            <Plus className="h-3 w-3" />
            Tag
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          {/* Header: available count + sort toggle */}
          <div className="px-3 pt-3 pb-1 flex items-center justify-between">
            <span className="text-xs font-semibold">
              Available tags ({availableCount})
            </span>
            {/* Idle-neutral/hover-brand text toggle, no hover background - no minted cell
                reproduces this exact combination. Deferred. */}
            <button
              aria-label="Sort tags"
              className="text-text-secondary hover:text-primary transition-colors"
              onClick={() => setSortAsc(prev => !prev)}
            >
              {sortAsc ? (
                <ArrowDownAZ className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpAZ className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {/* Search */}
          <div className="px-3 py-1">
            <input
              className="h-7 w-full rounded-control border border-border bg-surface-light px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Search tags..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && showCreate) {
                  addTag.mutate({ name: search.trim(), color });
                }
              }}
              autoFocus
            />
          </div>

          {/* Available tag chips */}
          <div className="max-h-48 overflow-y-auto px-3 py-2 flex flex-wrap gap-1.5">
            {suggestions.map(tag => (
              // Dynamic per-tag colour chip (style-based backgroundColor) - not a token,
              // not Button-shaped. Deferred.
              <button
                key={tag.id}
                className="rounded-full px-2.5 py-0.5 text-xs font-medium text-on-fill hover:opacity-80 transition-opacity"
                style={{ backgroundColor: tag.color }}
                onClick={() => addTag.mutate({ tag_id: tag.id })}
              >
                {tag.name}
              </button>
            ))}
            {suggestions.length === 0 && !showCreate && (
              <EmptyState density="flush" title="No tags found" />
            )}
          </div>

          {/* Inline create — color picker + create action */}
          {showCreate && (
            <div className="border-t border-border">
              <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                {TAG_COLORS.map(c => (
                  // Colour-swatch picker - not Button-shaped. Deferred.
                  <button
                    key={c}
                    type="button"
                    aria-label={`Use color ${c}`}
                    aria-pressed={c === color}
                    className={cn('h-5 w-5 rounded-full', c === color && 'ring-2 ring-offset-1 ring-primary')}
                    style={{ backgroundColor: c }}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
              {/* Full-width left-aligned menu-item row - a dropdown-item shape, not
                  Button-shaped. Deferred. */}
              <button
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-primary hover:bg-background-light transition-colors"
                onClick={() => addTag.mutate({ name: search.trim(), color })}
              >
                <Plus className="h-3 w-3" />
                Create new tag "{search.trim()}"
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
