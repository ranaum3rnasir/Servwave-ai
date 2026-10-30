import { useEffect, useRef, useState, type DragEvent } from 'react';
import { GripVertical, MoreHorizontal, Pencil, Undo2 } from 'lucide-react';

import { MoveButtons } from '@/components/form/MoveButtons';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui-kit/components/ui/dropdownMenu';
import { Input } from '@/ui-kit/components/ui/input';
import { cn } from '@/ui-kit/lib/utils';
import { tagColorName } from '@/lib/tag-colors';

import { ColourDot, ColourPopover } from './ColourPopover';
import { NAME_MAX, cleanName, type ListDef, type ListItem } from './listDefs';
import type { CSSProperties } from 'react';

/** Drag state and handlers, owned by the card so one row at a time can be dragged. */
export interface RowDrag {
  dragId: string | null;
  over: { id: string; after: boolean } | null;
  start: (id: string) => void;
  hover: (id: string, e: DragEvent<HTMLElement>) => void;
  drop: (id: string) => void;
  end: () => void;
}

export interface ListRowProps {
  def: ListDef;
  item: ListItem;
  /** Create, rename, archive and reorder controls are drawn only for someone who can use them. */
  canEdit: boolean;
  /** "Delete…" in the More menu. */
  canDelete: boolean;
  /** Reordering is on: no search text, Active view, manual order. */
  reorderOn: boolean;
  reorderWhy: string;
  /** This row's place among the active rows, for the ends of the Move buttons. */
  index: number;
  activeCount: number;
  editing: boolean;
  flash: boolean;
  drag: RowDrag;
  check: (name: string, exceptId: string) => string;
  onStartRename: (id: string) => void;
  /** Rejects with an Error whose message is the text to show under the input. */
  onRename: (id: string, name: string, refocus: boolean) => Promise<void>;
  onCancelRename: (id: string) => void;
  onMove: (id: string, dir: 'up' | 'down') => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onColour: (id: string, colour: string) => void;
  onNotice: (text: string) => void;
}

export function ListRow(p: ListRowProps) {
  const { def, item, canEdit, reorderOn, editing } = p;
  const dragEnabled = reorderOn && !editing && !item.archived && canEdit;
  const over = p.drag.over?.id === item.id ? p.drag.over : null;
  return (
    <div
      role="listitem"
      data-id={item.id}
      draggable={dragEnabled || undefined}
      onDragStart={dragEnabled ? (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
        p.drag.start(item.id);
      } : undefined}
      onDragOver={p.drag.dragId ? (e) => p.drag.hover(item.id, e) : undefined}
      onDrop={p.drag.dragId ? (e) => { e.preventDefault(); p.drag.drop(item.id); } : undefined}
      onDragEnd={p.drag.end}
      className={cn(
        'lc-row',
        def.colour && 'has-col',
        item.archived && 'is-arch',
        editing && 'is-edit',
        p.flash && 'is-flash',
        p.drag.dragId === item.id && 'is-drag',
        over && (over.after ? 'is-over-after' : 'is-over'),
      )}
    >
      {def.reorder && (
        <span className="lc-grip">
          {!item.archived && canEdit && (
            <span
              aria-hidden
              data-slot="lc-grip"
              aria-disabled={reorderOn ? undefined : true}
              title={reorderOn ? 'Drag to reorder' : p.reorderWhy}
              onClick={reorderOn ? undefined : () => p.onNotice(p.reorderWhy)}
            >
              <GripVertical className="size-4" />
            </span>
          )}
        </span>
      )}
      <div className="lc-name">
        {editing ? (
          <RenameInput item={item} check={(n) => p.check(n, item.id)} onSave={(n, refocus) => p.onRename(item.id, n, refocus)} onCancel={() => p.onCancelRename(item.id)} />
        ) : (
          def.colour ? (
            <span className="lc-chip" style={{ '--c': item.color } as CSSProperties}>
              <span className="lc-nm" title={item.name}>
                {item.name}
              </span>
            </span>
          ) : (
            <>
              <span className="lc-nm" title={item.name}>
                {item.name}
              </span>
              {item.archived && <Badge variant="softNeutral" size="sm">Archived</Badge>}
            </>
          )
        )}
      </div>
      {def.colour && item.color && (
        canEdit ? (
          <ColourPopover name={item.name} colour={item.color} onPick={(next) => p.onColour(item.id, next)} />
        ) : (
          <span className="lc-swb is-static">
            <ColourDot colour={item.color} />
            <span className="lc-swn" data-slot="lc-colour-name">
              {tagColorName(item.color)}
            </span>
          </span>
        )
      )}
      <span className="lc-meta" title={item.usedTitle}>
        {item.usedText}
      </span>
      <div className="lc-act">
        {canEdit && item.archived && (
          <Button type="button" variant="outline" size="sm" onClick={() => p.onRestore(item.id)}>
            <Undo2 aria-hidden />
            Restore
          </Button>
        )}
        {canEdit && !item.archived && (
          <>
            <Button type="button" variant="ghost" size="icon-sm" className="size-8 max-[640px]:size-11" data-a="rename" aria-label={`Rename ${item.name}`} title="Rename" onClick={() => p.onStartRename(item.id)}>
              <Pencil />
            </Button>
            {def.reorder && (
              <MoveButtons
                name={item.name}
                canMoveUp={p.index > 0}
                canMoveDown={p.index < p.activeCount - 1}
                onMoveUp={() => p.onMove(item.id, 'up')}
                onMoveDown={() => p.onMove(item.id, 'down')}
                disabledReason={reorderOn ? undefined : p.reorderWhy}
                onDisabledPress={p.onNotice}
                buttonClassName="size-8 max-[640px]:size-11"
              />
            )}
            {(def.archive || (def.deletable && p.canDelete)) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" className="size-8 max-[640px]:size-11" aria-label={`More actions for ${item.name}`} title="More">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {def.archive && <DropdownMenuItem className="max-[640px]:min-h-11" onSelect={() => p.onArchive(item.id)}>Archive</DropdownMenuItem>}
                  {def.deletable && p.canDelete && (
                    <DropdownMenuItem variant="destructive" className="max-[640px]:min-h-11" onSelect={() => p.onDelete(item.id)}>
                      Delete…
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The name turned into an input (spec 6.5). Enter or leaving the field saves, Escape cancels, unchanged text just closes.
 * A refused name keeps the input open with the reason under it.
 */
function RenameInput({
  item,
  check,
  onSave,
  onCancel,
}: {
  item: ListItem;
  check: (name: string) => string;
  onSave: (name: string, refocus: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(item.name);
  const [error, setError] = useState('');
  const done = useRef(false);
  const busy = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const errorId = `lc-ren-${item.id}-error`;

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const submit = async (refocus: boolean) => {
    if (done.current || busy.current) return;
    const next = cleanName(value);
    if (next === item.name) {
      done.current = true;
      onCancel();
      return;
    }
    const problem = check(next);
    if (problem) {
      setError(problem);
      ref.current?.focus();
      return;
    }
    busy.current = true;
    try {
      await onSave(next, refocus);
      done.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
      ref.current?.focus();
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Input
        ref={ref}
        value={value}
        maxLength={NAME_MAX}
        aria-label={`Name of ${item.name}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => void submit(false)}
      />
      {error && (
        <p id={errorId} role="alert" className="text-danger-text text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
