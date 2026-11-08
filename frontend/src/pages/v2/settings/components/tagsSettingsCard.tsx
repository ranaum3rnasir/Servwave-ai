/**
 * TagsSettingsCard — org-wide tag management for admins.
 *
 * Tags are created inline from the record pages (TagInput), which is where they
 * should stay. What was missing is the other half: nothing could ever rename,
 * recolour or delete a tag once it existed, so a typo'd or obsolete tag was
 * permanent. This card is that half.
 *
 * Unlike the sibling ListSection cards on Payments & Lists, these are real
 * server rows, not org JSON columns — so edits here write immediately rather
 * than through the shell's "Save Changes" bar. The card says so.
 *
 * Rendered only when the viewer can `delete Tag` / `update Tag`, which have no
 * defaultGrants row and so resolve to ADMIN-only via `manage all`.
 *
 * Lives beside `section.tsx` rather than under `components/settings/` because
 * its only consumer is the routed v2 Payments & Lists page, and it draws its
 * chrome from that page's own `Section`. Importing a page-local primitive from
 * `components/` would have been the first such inversion in the tree.
 *
 * `Section` is what keeps it flush with the two ListSections it shares a grid
 * row with - same kit Card surface, radius, border, shadow and `p-5`, and the
 * same `role="heading"` treatment. It used to hand-roll a legacy Card and a raw
 * `<h3>`, which read as a different component sitting in the same row.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TAG_COLORS } from '@/lib/tag-colors';
import { TAG_EMBEDDING_QUERY_KEYS } from '@/lib/tag-entities';
import { Section } from './section';

interface ManagedTag {
  id: string;
  name: string;
  color: string;
}

export function TagsSettingsCard() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ManagedTag | null>(null);

  // Deliberately the SAME key the record-page picker (TagInput) uses, reading the
  // same endpoint with the same shape. The card used to ask for a per-tag usage
  // count on a key of its own, which bought a second cache to keep in sync and a
  // figure nobody acted on. One key means a delete here updates the picker's copy.
  const { data: tags, isLoading } = useQuery({
    queryKey: ['tags'],
    queryFn: async () => {
      const { data } = await api.get('/api/tags');
      return data.tags as ManagedTag[];
    },
  });

  // A tag edit here changes what is rendered wherever that tag already sits, so
  // both mutations drop the same set - a rename or recolour leaves a stale chip
  // on a cached record page exactly as a delete leaves a deleted one.
  //
  // ['tags'] is the tag vocabulary itself (TagInput's autocomplete, the list
  // pages' Tags facet, and this card's own list).
  // TAG_EMBEDDING_QUERY_KEYS is every OTHER cache that embeds a copy of the tag
  // row: the five detail keys, the five list keys, and the schedule board's own
  // job/lead keys. It is derived from the shared entity map rather than
  // hand-listed here - hand-listing is exactly how this card drifted to
  // covering two of the five taggable types.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tags'] });
    for (const key of TAG_EMBEDDING_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  const updateTag = useMutation({
    mutationFn: async ({ id, name, color }: { id: string; name?: string; color?: string }) => {
      const { data } = await api.patch(`/api/tags/${id}`, { ...(name ? { name } : {}), ...(color ? { color } : {}) });
      return data.tag as ManagedTag;
    },
    onSuccess: () => {
      invalidate();
      setEditingId(null);
      toast({ title: 'Tag updated' });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: "Couldn't update tag", description: extractApiError(err, 'Please try again.') });
    },
  });

  const deleteTag = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/tags/${id}`);
    },
    onSuccess: () => {
      invalidate();
      setPendingDelete(null);
      toast({ title: 'Tag deleted' });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: "Couldn't delete tag", description: extractApiError(err, 'Please try again.') });
    },
  });

  const startEdit = (tag: ManagedTag) => {
    setEditingId(tag.id);
    setDraftName(tag.name);
    setDraftColor(tag.color);
  };

  const commitEdit = (tag: ManagedTag) => {
    const name = draftName.trim();
    if (!name) return;
    if (name === tag.name && draftColor === tag.color) {
      setEditingId(null);
      return;
    }
    updateTag.mutate({
      id: tag.id,
      ...(name !== tag.name ? { name } : {}),
      ...(draftColor !== tag.color ? { color: draftColor } : {}),
    });
  };

  return (
    <Section
      title="Tags"
      description="Tags used across customers, leads, estimates, jobs and invoices. Add new ones from any record; rename, recolour or delete them here. Changes save immediately and apply everywhere."
    >
      {isLoading ? (
        <p className="text-sm text-text-secondary">Loading tags…</p>
      ) : (tags?.length ?? 0) === 0 ? (
        <EmptyState density="flush" title="No tags yet — add one from any customer, lead or job." />
      ) : (
        <ul className="divide-y divide-border">
          {tags!.map((tag) => (
            <li key={tag.id} className="py-2">
              {editingId === tag.id ? (
                // Stacked, not inline: this card shares a two-column grid, so a
                // swatch row + name field + two buttons on one line squeezes the
                // field down to a few pixels.
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {TAG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Use colour ${c}`}
                        aria-pressed={draftColor.toUpperCase() === c}
                        onClick={() => setDraftColor(c)}
                        style={{ backgroundColor: c }}
                        className={`h-5 w-5 rounded-full transition-transform ${
                          draftColor.toUpperCase() === c ? 'scale-110 ring-2 ring-primary ring-offset-1' : ''
                        }`}
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitEdit(tag);
                        }
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      maxLength={50}
                      autoFocus
                      aria-label={`Rename tag ${tag.name}`}
                      className="h-8 min-w-0 flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={!draftName.trim() || updateTag.isPending}
                      onClick={() => commitEdit(tag)}
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span className="sr-only">Save tag</span>
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      <X className="h-3.5 w-3.5" />
                      <span className="sr-only">Cancel</span>
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    style={{ backgroundColor: tag.color }}
                    className="h-3 w-3 shrink-0 rounded-full"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                    {tag.name}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => startEdit(tag)}
                    aria-label={`Edit tag ${tag.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setPendingDelete(tag)}
                    aria-label={`Delete tag ${tag.name}`}
                    className="text-text-secondary hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        tone="danger"
        icon={Trash2}
        title={`Delete "${pendingDelete?.name ?? ''}"?`}
        description="This removes the tag from every record it is assigned to. This can't be undone."
        confirmLabel="Delete tag"
        isLoading={deleteTag.isPending}
        onConfirm={() => pendingDelete && deleteTag.mutate(pendingDelete.id)}
      />
    </Section>
  );
}
