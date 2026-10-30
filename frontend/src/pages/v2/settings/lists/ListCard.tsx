import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Plus } from 'lucide-react';

import { moveInList } from '@/lib/moveInList';
import { tagColorName } from '@/lib/tag-colors';
import { extractApiError } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Button } from '@/ui-kit/components/ui/button';
import { toast } from '@/ui-kit/components/ui/sonner';

import { FlushCard } from '../components/section';
import { InfoPopover } from '../../_shared/infoPopover';
import { CreateForm } from './CreateForm';
import { ListRow, type RowDrag } from './ListRow';
import { SORT_LABELS, cleanName, countText, nameProblem, visibleItems, writeErrorText, type ListController, type SortKey } from './listDefs';
import { notifySaved } from '@/lib/listSavedToast';
import './lists.css';

/** Column sets (spec 6.3): wide card, and the narrow card the container query switches to. */
function listColumns(reorder: boolean, colour: boolean): CSSProperties {
  // The Actions width is a variable so a touch screen wider than a phone (44px buttons) can widen it in lists.css.
  const wide = [reorder && '28px', 'minmax(0, 1fr)', colour && '132px', '104px', 'var(--act-w)'].filter(Boolean).join(' ');
  const narrow = [reorder && '22px', 'minmax(0, 1fr)', colour && '40px', '84px', 'var(--act-w-s)'].filter(Boolean).join(' ');
  return { '--cols': wide, '--cols-s': narrow } as CSSProperties;
}

/**
 * One Lists card: the shared engine behind every list (search, sort, counts, empty states, name checks, create, rename,
 * archive, reorder, the Saved toast with Undo, the flash and scroll-into-view). What differs per list is the
 * `ListController` it is given. The rows container is never remounted, so each card keeps its scroll position.
 */
export function ListCard({ controller: c }: { controller: ListController }) {
  const { def, items } = c;
  const cardRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(def.defaultSort);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);

  const active = useMemo(() => items.filter((i) => !i.archived), [items]);
  const archivedCount = items.length - active.length;
  const list = useMemo(() => visibleItems(items, query, sort, showArchived), [items, query, sort, showArchived]);
  const searching = query.trim() !== '';
  // A failed load shows no numbers and no controls that would act on an empty list we know nothing about.
  const failed = c.isError && items.length === 0;

  const reorderOn = def.reorder && c.canEdit && sort === 'manual' && !searching && !showArchived;
  const reorderWhy = showArchived ? 'Archived items cannot be reordered.' : 'Clear the search to reorder.';
  const showNote = def.reorder && c.canEdit && !showArchived && searching;

  // Where focus should land once the change a handler just made has been drawn (a ref, read after every render).
  const focusRef = useRef<string | null>(null);
  const requestFocus = (sel: string) => {
    focusRef.current = sel;
  };
  useEffect(() => {
    const sel = focusRef.current;
    if (!sel) return;
    focusRef.current = null;
    cardRef.current?.querySelector<HTMLElement>(sel)?.focus();
  });

  // The flash fades on its own; a new row also scrolls into view INSIDE its card (never the page).
  const scrolledTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!flashId || scrolledTo.current === flashId) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-id="${flashId}"]`);
    const box = scrollRef.current;
    if (!row || !box) return;
    scrolledTo.current = flashId;
    const r = box.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    if (b.top < r.top) box.scrollTop -= r.top - b.top;
    else if (b.bottom > r.bottom) box.scrollTop += b.bottom - r.bottom;
  }, [flashId, list]);
  useEffect(() => {
    if (!flashId) return;
    const t = window.setTimeout(() => setFlashId(null), 1500);
    return () => window.clearTimeout(t);
  }, [flashId]);

  const fail = (err: unknown) => toast.error(extractApiError(err, 'Please try again.'));

  // --- create ---
  const exactMatch = items.some((i) => i.name.toLowerCase() === query.trim().toLowerCase());
  const createLabel = `Create ${def.singular}${searching && !exactMatch ? ` “${query.trim()}”` : ''}`;

  const submitCreate = async (raw: string, colour: string): Promise<string | null> => {
    const problem = nameProblem(def, items, raw);
    if (problem) return problem;
    try {
      const item = await c.create(cleanName(raw), def.colour ? colour : undefined);
      setCreating(false);
      setQuery('');
      setShowArchived(false);
      setFlashId(item.id);
      scrolledTo.current = null;
      requestFocus('[data-a="create"]');
      notifySaved(`Created ${def.singular} “${item.name}”`, () => c.remove(item.id));
      return null;
    } catch (err) {
      return writeErrorText(def, err, cleanName(raw));
    }
  };

  // --- rename ---
  const rename = async (id: string, name: string, refocus: boolean) => {
    const old = items.find((i) => i.id === id)?.name ?? '';
    try {
      const item = await c.rename(id, name);
      setEditId(null);
      if (refocus) requestFocus(`[data-id="${id}"] [data-a="rename"]`);
      notifySaved(`Renamed “${old}” to “${item.name}”`, () => c.rename(id, old));
    } catch (err) {
      throw new Error(writeErrorText(def, err, name), { cause: err });
    }
  };
  const cancelRename = (id: string) => {
    setEditId(null);
    requestFocus(`[data-id="${id}"] [data-a="rename"]`);
  };

  // --- colour ---
  const recolour = async (id: string, colour: string) => {
    const item = items.find((i) => i.id === id);
    if (!item?.color) return;
    const old = item.color;
    try {
      await c.setColour(id, colour);
      notifySaved(`Colour of “${item.name}” is now ${tagColorName(colour)}`, () => c.setColour(id, old));
    } catch (err) {
      fail(err);
    }
  };

  // The menu item that opened the delete dialog is gone, so focus would fall to the page: put it back on the row's button.
  // Kept in state (a fresh object per close), not the focus ref, so rendering the dialog never touches a ref.
  const [refocusMore, setRefocusMore] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (refocusMore) cardRef.current?.querySelector<HTMLElement>(`[data-id="${refocusMore.id}"] button[aria-label^="More actions"]`)?.focus();
  }, [refocusMore]);
  const closeDelete = (id: string) => {
    setDeleteId(null);
    setRefocusMore({ id });
  };

  // --- archive / restore ---
  const archive = async (id: string) => {
    const name = items.find((i) => i.id === id)?.name ?? '';
    // The row leaves this view: focus goes to the next row, else the previous, else the create row.
    const at = list.findIndex((i) => i.id === id);
    const near = list[at + 1] ?? list[at - 1];
    try {
      await c.archive(id);
      requestFocus(near ? `[data-id="${near.id}"] [data-a="rename"]` : '[data-a="create"]');
      notifySaved(`Archived “${name}”`, () => c.unarchive(id));
    } catch (err) {
      fail(err);
    }
  };
  const restore = async (id: string) => {
    const name = items.find((i) => i.id === id)?.name ?? '';
    try {
      await c.unarchive(id);
      setFlashId(id);
      scrolledTo.current = null;
      notifySaved(`Restored “${name}”`, () => c.archive(id));
    } catch (err) {
      fail(err);
    }
  };

  // --- reorder ---
  const activeIds = useMemo(() => active.map((i) => i.id), [active]);
  const saveOrder = async (next: string[], movedId: string, detail: string) => {
    const before = activeIds;
    try {
      await c.reorder(next);
      setFlashId(movedId);
      scrolledTo.current = null;
      notifySaved(detail, () => c.reorder(before));
    } catch (err) {
      fail(err);
    }
  };
  const move = (id: string, dir: 'up' | 'down') => {
    const next = moveInList(activeIds, activeIds.indexOf(id), dir);
    if (!next) return;
    const name = items.find((i) => i.id === id)?.name ?? '';
    void saveOrder(next, id, `Moved “${name}” ${dir}`);
    requestFocus(`[data-id="${id}"] [data-slot="move-buttons"] button:nth-of-type(${dir === 'up' ? 1 : 2})`);
  };

  const drag: RowDrag = {
    dragId,
    over,
    start: setDragId,
    hover: (id: string, e: DragEvent<HTMLElement>) => {
      if (!dragId || dragId === id) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setOver({ id, after: e.clientY > r.top + r.height / 2 });
    },
    drop: (id: string) => {
      const after = over?.id === id ? over.after : false;
      const moved = dragId;
      setDragId(null);
      setOver(null);
      if (!moved || moved === id) return;
      const next = activeIds.filter((x) => x !== moved);
      next.splice(next.indexOf(id) + (after ? 1 : 0), 0, moved);
      if (next.join() === activeIds.join()) return;
      const name = items.find((i) => i.id === moved)?.name ?? '';
      void saveOrder(next, moved, `Moved “${name}”`);
    },
    end: () => {
      setDragId(null);
      setOver(null);
    },
  };

  const deleting = deleteId ? items.find((i) => i.id === deleteId) : undefined;

  const emptyText = searching
    ? `No ${def.title.toLowerCase()} match “${query.trim()}”. Use Create above to add it.`
    : showArchived
      ? 'Nothing is archived.'
      : `No ${def.title.toLowerCase()} yet. Use Create above to add one.`;

  return (
    <FlushCard className="lc-card">
      <section ref={cardRef} aria-labelledby={`lc-title-${def.key}`} className="contents">
        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-1">
            <p id={`lc-title-${def.key}`} role="heading" aria-level={2} className="text-sm font-semibold">
              {def.title}
            </p>
            <InfoPopover label={def.title}>{def.help}</InfoPopover>
          </div>
          {!failed && (
            <span className="lc-count" data-slot="lc-count">
              {countText(def, items, query, showArchived, list.length)}
            </span>
          )}
        </div>
        <div className="lc-body" style={listColumns(def.reorder, def.colour)}>
          <div className="lc-tools">
            <div className="lc-tools-search">
              <SearchInput
                value={query}
                onValueChange={setQuery}
                placeholder={`Search ${def.title.toLowerCase()}`}
                aria-label={`Search ${def.title.toLowerCase()}`}
              />
            </div>
            {def.sorts.length > 0 && (
              <div className="lc-tools-sort">
                <SelectField
                  aria-label={`Sort ${def.title.toLowerCase()}`}
                  value={sort}
                  onValueChange={(v) => setSort(v as SortKey)}
                  options={def.sorts.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
                />
              </div>
            )}
            {def.archive && !failed && (
              <ToggleGroup
                type="single"
                variant="segmented"
                aria-label="Show"
                value={showArchived ? 'archived' : 'active'}
                onValueChange={(v) => v && setShowArchived(v === 'archived')}
              >
                <ToggleGroupItem value="active" className="lc-seg">Active {active.length}</ToggleGroupItem>
                <ToggleGroupItem value="archived" className="lc-seg">Archived {archivedCount}</ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>

          {c.canCreate && !failed &&
            (creating ? (
              <CreateForm def={def} initial={exactMatch ? '' : query.trim()} defaultColour={c.defaultColour} onSubmit={submitCreate} onCancel={() => { setCreating(false); requestFocus('[data-a="create"]'); }} />
            ) : (
              <Button type="button" variant="ghost" className="lc-create" data-a="create" onClick={() => setCreating(true)}>
                <Plus aria-hidden />
                {createLabel}
              </Button>
            ))}

          {showNote && <div className="lc-note">Clear the search to reorder. Dragging and the Move buttons are off until then.</div>}

          <div className="lc-head" role="presentation">
            {def.reorder && <span />}
            <span>Name</span>
            {def.colour && (
              <span>
                <span className="lc-head-colour">Colour</span>
              </span>
            )}
            <span>Used by</span>
            <span className="lc-head-actions">Actions</span>
          </div>

          <div className="lc-scroll" ref={scrollRef}>
            <div role="list" aria-label={def.title}>
              {c.isLoading ? (
                <div className="lc-empty">Loading…</div>
              ) : c.isError ? (
                <div className="lc-empty" role="alert">
                  {`Could not load ${def.title.toLowerCase()}.`}
                  {c.retry && (
                    <div className="mt-3">
                      <Button type="button" variant="outline" size="sm" onClick={c.retry}>
                        Retry
                      </Button>
                    </div>
                  )}
                </div>
              ) : list.length === 0 ? (
                <div className="lc-empty">{emptyText}</div>
              ) : (
                list.map((item) => (
                  <ListRow
                    key={item.id}
                    def={def}
                    item={item}
                    canEdit={c.canEdit}
                    canDelete={c.canDelete}
                    reorderOn={reorderOn}
                    reorderWhy={reorderWhy}
                    index={activeIds.indexOf(item.id)}
                    activeCount={activeIds.length}
                    editing={editId === item.id}
                    flash={flashId === item.id}
                    drag={drag}
                    check={(name, except) => nameProblem(def, items, name, except)}
                    onStartRename={setEditId}
                    onRename={rename}
                    onCancelRename={cancelRename}
                    onMove={move}
                    onArchive={archive}
                    onRestore={restore}
                    onDelete={setDeleteId}
                    onColour={recolour}
                    onNotice={(text) => toast(text)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
        {deleting && c.deleteDialog?.(deleting, () => closeDelete(deleting.id))}
      </section>
    </FlushCard>
  );
}
