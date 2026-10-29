import type { ColumnDef } from '@tanstack/react-table';

export interface TagChip {
  id: string;
  name: string;
  color: string;
}

/**
 * SRVW-58 - the one tag-chip treatment, shared by the five list pages' Tags
 * column and the three schedule card renderers.
 *
 * `tag.color` is runtime user data (a hex string on the Tag row), so it is
 * applied as an inline style, never as a Tailwind palette class - the same
 * precedent CheckboxFacet uses for a facet option's `swatch`. No new hex
 * literal enters the component.
 *
 * Renders at most `max` chips plus a neutral `+N` overflow pill; the full list
 * is always in the `title` so nothing is unreachable.
 */
export function TagChips({ tags, max = 2 }: { tags?: TagChip[]; max?: number }) {
  if (!tags || tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const overflow = tags.length - shown.length;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" title={tags.map((t) => t.name).join(', ')}>
      {shown.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium text-on-fill"
          style={{ backgroundColor: tag.color }}
        >
          {tag.name}
        </span>
      ))}
      {overflow > 0 && (
        <span className="inline-flex shrink-0 items-center rounded-full bg-background-light px-2 py-0.5 text-[11px] font-medium text-text-secondary">
          +{overflow}
        </span>
      )}
    </span>
  );
}

/**
 * SRVW-58 - the Tags column definition, shared by the five list pages.
 * `enableSorting: false` is load-bearing: tags are not a sortable column on
 * any list endpoint, and SRVW-89 turns an unknown sort id into a 400.
 */
export function tagsColumn<T extends { tags?: TagChip[] }>(): ColumnDef<T, unknown> {
  return {
    id: 'tags',
    header: 'Tags',
    size: 140,
    enableSorting: false,
    meta: { growWeight: 1, minWidth: 80 },
    cell: ({ row }) => <TagChips tags={row.original.tags} />,
  };
}
