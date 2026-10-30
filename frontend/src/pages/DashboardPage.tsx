import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Check, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { useAuthStore } from '@/stores/auth.store';
import { useDashboard } from '@/lib/api/dashboard';
import NewMenu from '@/pages/dashboard/NewMenu';
import { useDashboardLayout } from '@/lib/dashboard/useDashboardLayout';
import { useIsMobile } from '@/hooks/useIsMobile';
import { WIDGETS } from '@/components/dashboard/widgetRegistry';
import { SIZE_SPAN, type TimeRange } from '@/lib/dashboard/layoutTypes';
import EditableWidget from '@/components/dashboard/EditableWidget';
import CatalogDrawer from '@/components/dashboard/CatalogDrawer';

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getDayString(): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { data } = useDashboard({});
  const { layout, update, reorder, add, reset } = useDashboardLayout();

  const [edit, setEdit] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const dragId = useRef<string | null>(null);
  const phone = useIsMobile();

  // On a phone the catalog is a sheet over the whole screen, so it opens from the toolbar's Add
  // widgets rather than with edit mode (mobile slice 48): it would hide the widgets being moved.
  const toggleEdit = () => {
    setEdit((e) => {
      const next = !e;
      setCatalogOpen(next && !phone);
      return next;
    });
  };

  // The widgets that actually have a cell, in order, so Move up / Move down step over hidden ones
  // and over a widget that vetoes its own cell.
  const cells = layout
    .filter((item) => item.visible)
    .map((item) => {
      const def = WIDGETS[item.id];
      if (!def) return null;
      const size = item.size ?? def.defaultSize;
      const range: TimeRange = item.range ?? def.defaultRange ?? '30d';
      const el = def.render({ data: data?.data, range, navigate });
      if (!el) return null;
      return { item, def, size, range, el };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <Heading>
            {getGreeting()}, {user?.first_name ?? 'there'} 👋
          </Heading>
          <p className="text-sm text-text-secondary">{getDayString()} - Here's what's happening today.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <NewMenu />
          {/* two custom fill states toggled by `edit` (idle bg-primary/hover:opacity-90, editing
              bg-ocean-700/hover:bg-ocean-900 i.e. --primary-light/--primary-dark) - the editing
              state has no matching Button tone cell - left raw */}
          <button
            type="button"
            onClick={toggleEdit}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-on-fill transition-colors ${edit ? 'bg-ocean-700 hover:bg-ocean-900' : 'bg-primary hover:opacity-90'}`}
          >
            {edit ? <><Check className="h-3.5 w-3.5" /> Done</> : <><Pencil className="h-3.5 w-3.5" /> Customize home page</>}
          </button>
        </div>
      </div>

      {/* Edit toolbar */}
      {edit && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary-subtle bg-primary-subtle px-4 py-2.5">
          <p className="text-[12px] font-medium text-primary">
            {phone
              ? "Edit mode - use the arrows to reorder · ✕ to hide · the time pill sets each widget's range"
              : "Edit mode - drag or use the arrows to reorder · ✕ to hide · the time pill sets each widget's range · add more from the catalog →"}
          </p>
          {!catalogOpen && (
            <Button type="button" variant="link" size={null} className="gap-1.5" onClick={() => setCatalogOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add widgets
            </Button>
          )}
          {/* link/brand matches text-primary hover:underline; gap-1.5 restores the raw's exact spacing
              over Button's base gap-2. Two disclosed, not-restored deltas: Button's base text-sm (14px)
              replaces the raw's 12px - no size override exists on Button's prop surface below the 3xs
              rung, and the 3xs rung itself would also change padding/height that this link-style button
              never had, so it is not used here - and Button's own [&_svg]:size-4 grows the h-3.5 w-3.5
              icon to 16px. */}
          <Button type="button" variant="link" size={null} className="gap-1.5" onClick={reset}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset to default
          </Button>
        </div>
      )}

      {/* Body: layout grid + catalog drawer */}
      <div className="flex gap-3.5 items-start">
        <div className="grid grid-cols-12 gap-3.5 flex-1 auto-rows-min">
          {cells.map(({ item, def, size, range, el }, i) => (
            <div key={item.id} className={SIZE_SPAN[size]}>
              <EditableWidget
                id={item.id}
                title={def.title}
                edit={edit}
                range={range}
                onHide={() => update(item.id, { visible: false })}
                onRange={(r) => update(item.id, { range: r })}
                onDragStart={(id) => (dragId.current = id)}
                onDrop={(id) => { if (dragId.current) reorder(dragId.current, id); dragId.current = null; }}
                onMoveUp={i > 0 ? () => reorder(item.id, cells[i - 1]!.item.id) : undefined}
                onMoveDown={i < cells.length - 1 ? () => reorder(item.id, cells[i + 1]!.item.id) : undefined}
              >
                {el}
              </EditableWidget>
            </div>
          ))}
        </div>

        <CatalogDrawer open={edit && catalogOpen} layout={layout} tiles={data?.tiles ?? []} categories={data?.categories ?? []} onAdd={add} onClose={() => setCatalogOpen(false)} />
      </div>
    </div>
  );
}
