import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Pencil, Plus, RotateCcw } from 'lucide-react';
import { motion, MotionConfig } from 'framer-motion';

import { useAuthStore } from '@/stores/auth.store';
import { useDashboard } from '@/lib/api/dashboard';
import { useDashboardLayout } from '@/lib/dashboard/useDashboardLayout';
import { useIsMobile } from '@/hooks/useIsMobile';
import { SIZE_SPAN, type TimeRange } from '@/lib/dashboard/layoutTypes';
import EditableWidget from '@/components/dashboard/EditableWidget';
import CatalogDrawer from '@/components/dashboard/CatalogDrawer';

import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';

import { NewMenu } from './components/newMenu';
import { V2_WIDGETS } from './widgetRegistry';
import { useRecordVisit } from '../pageBreadcrumbs';

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getDayString(): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
}

/**
 * `/v2` - the customisable home page, on the CRM UI kit.
 *
 * WHAT IS IMPORTED, NOT REBUILT. The customisation system is business logic
 * and every piece of it is used as it stands:
 *
 *   useDashboardLayout   the per-user layout, its localStorage key
 *                        (`alpha:dashboard-layout:v1:<userId>`), its
 *                        merge-forward restore and its reorder arithmetic
 *   SIZE_SPAN            the four grid spans
 *   EditableWidget       edit chrome, the native HTML5 drag source, the range
 *                        control and the hide button
 *   CatalogDrawer        the add-widget rail
 *   V2_WIDGETS           the legacy registry with kit renders swapped in - see
 *                        widgetRegistry.tsx; ids and titles are never restated
 *
 * A fork of any of them would be a second definition of what a user's saved
 * layout MEANS, and the failure mode is silent: a drifted id is a widget that
 * stops rendering for everyone who has already customised their page.
 *
 * WHAT CHANGED is the chrome: the header is the kit's `PageHeader`, the
 * quick-create menu is the kit's `DropdownMenu`, and every widget card is the
 * kit's `Card`.
 *
 * THREE RENDER-LOOP BEHAVIOURS ARE LOAD-BEARING and are reproduced exactly:
 *
 *   1. a layout entry whose id is missing from the registry is SKIPPED, not an
 *      error - that is what makes a retired widget forward-compatible;
 *   2. a widget may VETO its own cell by returning null, which removes the grid
 *      div entirely rather than leaving an empty box (`kpi.recurring` when the
 *      org has no active plans, `smart_insights` when there is nothing to say);
 *   3. `item.size` is honoured on read even though no control ever writes it.
 *
 * LOADING STATE: the ledger's follow-up. `isLoading` (true only for the first
 * fetch - no cached data yet) is threaded into every widget's render ctx
 * alongside `data`. KPI tiles show the kit's `Skeleton` in place of the value
 * (`KpiCard`'s `loading` prop); the three list widgets that would otherwise
 * assert something false before data arrives (Needs Attention's "All clear",
 * Today's Schedule's "Nothing scheduled", Recent Activity's "No recent
 * activity") show a `Spinner` instead, via `WidgetCard`'s `loading` prop. Still
 * NO error state - a 403 and a first paint remain indistinguishable, and every
 * KPI still reads through `?? 0` once loaded. Widgets that render an empty
 * visual rather than a false claim (the charts, the funnel, the donuts) are
 * unchanged on purpose - reproducing them mid-fetch is a smaller gap than the
 * one this closes.
 */
export default function DashboardPage() {
  useRecordVisit('dashboard');
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { data, isLoading } = useDashboard({});
  const { layout, update, reorder, add, reset } = useDashboardLayout();

  const [edit, setEdit] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const dragId = useRef<string | null>(null);
  const phone = useIsMobile();

  // Entering edit mode opens the catalog; leaving it closes it. One state
  // change, two effects, exactly as before - except on a phone, where the
  // catalog is a sheet over the whole screen: opening it with edit mode would
  // hide the widgets whose order is being changed, so there it opens from the
  // toolbar's Add widgets instead.
  const toggleEdit = () => {
    setEdit((e) => {
      const next = !e;
      setCatalogOpen(next && !phone);
      return next;
    });
  };

  // The widgets that actually have a cell, in order. A hidden widget, an id the registry no longer
  // knows and a widget that vetoes its own cell are all skipped (see the render-loop notes above),
  // so Move up / Move down step over them: the neighbour is the next widget the user can SEE.
  const cells = layout
    .filter((item) => item.visible)
    .map((item) => {
      const def = V2_WIDGETS[item.id];
      if (!def) return null;
      const size = item.size ?? def.defaultSize;
      const range: TimeRange = item.range ?? def.defaultRange ?? '30d';
      const el = def.render({ data, range, navigate, isLoading });
      if (!el) return null;
      return { item, def, size, range, el };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <div>
      {/* No breadcrumb trail: this page IS the trail's Home crumb, and a
          `Home > Workspace > Dashboard` row whose first link points at the page
          you are already on is chrome that says nothing. */}
      <PageHeader
        title={`${getGreeting()}, ${user?.first_name ?? 'there'} 👋`}
        description={`${getDayString()} - Here's what's happening today.`}
        actions={
          <>
            <NewMenu />
            <Button type="button" size="sm" variant={edit ? 'secondary' : 'default'} onClick={toggleEdit}>
              {edit ? <><Check /> Done</> : <><Pencil /> Customize home page</>}
            </Button>
          </>
        }
      />

      {/* Edit toolbar. `Reset to default` overwrites the saved layout
          immediately with no confirmation - reproduced as-is and logged. */}
      {edit && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand bg-brand-subtle px-4 py-2.5">
          <p className="text-[0.75rem] font-medium text-brand-emphasis">
            {phone
              ? "Edit mode - use the arrows to reorder · ✕ to hide · the time pill sets each widget's range"
              : "Edit mode - drag or use the arrows to reorder · ✕ to hide · the time pill sets each widget's range · add more from the catalog →"}
          </p>
          <div className="flex items-center gap-3">
            {!catalogOpen && (
              <Button type="button" size="sm" variant="secondary" onClick={() => setCatalogOpen(true)}>
                <Plus /> Add widgets
              </Button>
            )}
            <Button type="button" variant="link" size={null} onClick={reset}>
              <RotateCcw /> Reset to default
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-start gap-3.5">
        {/* `reducedMotion="user"` makes framer-motion honour the OS
            prefers-reduced-motion setting for every layout animation below -
            those users get an instant reposition, no slide. The drag source
            (EditableWidget's native HTML5 dnd) and `reorder` are untouched;
            this only animates the position a card lands in after the array
            order changes. */}
        <MotionConfig reducedMotion="user">
          <div className="grid flex-1 auto-rows-min grid-cols-12 gap-3.5">
            {cells.map(({ item, def, size, range, el }, i) => (
              <motion.div
                key={item.id}
                layout="position"
                layoutDependency={layout.map((l) => l.id).join()}
                transition={{ duration: 0.25, ease: 'easeInOut' }}
                className={SIZE_SPAN[size]}
              >
                <EditableWidget
                  id={item.id}
                  title={def.title}
                  edit={edit}
                  range={range}
                  onHide={() => update(item.id, { visible: false })}
                  onRange={(r) => update(item.id, { range: r })}
                  onDragStart={(id) => (dragId.current = id)}
                  onDrop={(id) => { if (dragId.current) reorder(dragId.current, id); dragId.current = null; }}
                  // `reorder` puts the first id where the second one is, so one step is a move
                  // onto the neighbour - the same call a drop makes.
                  onMoveUp={i > 0 ? () => reorder(item.id, cells[i - 1]!.item.id) : undefined}
                  onMoveDown={i < cells.length - 1 ? () => reorder(item.id, cells[i + 1]!.item.id) : undefined}
                >
                  {el}
                </EditableWidget>
              </motion.div>
            ))}
          </div>
        </MotionConfig>

        <CatalogDrawer open={edit && catalogOpen} layout={layout} onAdd={add} onClose={() => setCatalogOpen(false)} />
      </div>
    </div>
  );
}
