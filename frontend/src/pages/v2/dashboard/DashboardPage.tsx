import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Pencil, Plus, RotateCcw } from 'lucide-react';
import { motion, MotionConfig } from 'framer-motion';

import { useAuthStore } from '@/stores/auth.store';
import { isTileError, useDashboard, useDashboardCoversLayout } from '@/lib/api/dashboard';
import { useDashboardLayout } from '@/lib/dashboard/useDashboardLayout';
import { useIsMobile, useMediaQuery } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { SIZE_SPAN, type TimeRange } from '@/lib/dashboard/layoutTypes';
import EditableWidget from '@/components/dashboard/EditableWidget';
import CatalogDrawer from '@/components/dashboard/CatalogDrawer';

import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { NewMenu } from './components/newMenu';
import { TileError } from './components/tileError';
import { WidgetCard } from './components/widgetCard';
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

// The placeholders drawn while the layout is read: the sizes of a first row of small tiles and a row of wider ones.
// They stand for no tile in particular, so a tile the person may not have is never hinted at.
const LOADING_CELLS = [SIZE_SPAN.kpi, SIZE_SPAN.kpi, SIZE_SPAN.kpi, SIZE_SPAN.kpi, SIZE_SPAN.half, SIZE_SPAN.half];

/**
 * `/v2` - the customisable home page, on the CRM UI kit.
 *
 * WHAT IS IMPORTED, NOT REBUILT. The customisation system is business logic
 * and every piece of it is used as it stands:
 *
 *   useDashboardLayout   the per-user layout, kept on the server (the same on
 *                        every device) and saved the moment it changes, and
 *                        its reorder arithmetic
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
 *      div entirely rather than leaving an empty box (`smart_insights` before
 *      the first answer lands). A tile with an answer and nothing to show does
 *      not veto: it keeps its cell and says so in one plain line (S09.2);
 *   3. `item.size` is honoured on read even though no control ever writes it.
 *
 * LOADING STATE: the ledger's follow-up. `isLoading` (true only for the first
 * fetch - no cached data yet) is threaded into every widget's render ctx
 * alongside `data`. KPI tiles show the kit's `Skeleton` in place of the value
 * (`KpiCard`'s `loading` prop); the three list widgets that would otherwise
 * assert something false before data arrives (Needs Attention's "All clear",
 * Today's Schedule's "Nothing scheduled", Recent Activity's "No recent
 * activity") show a `Spinner` instead, via `WidgetCard`'s `loading` prop.
 *
 * ERROR STATE: a read that failed (or a tile the server marked `{ error: true }`
 * because its loader failed or ran out of time) is drawn as `TileError`, one
 * plain line with a retry, never as the zero a widget reads through `?? 0`:
 * "the answer is zero" (S09.2's plain lines) and "no answer" are different
 * things on this page. Widgets that render an empty
 * visual rather than a false claim (the charts, the funnel, the donuts) are
 * unchanged on purpose - reproducing them mid-fetch is a smaller gap than the
 * one this closes.
 */
export default function DashboardPage() {
  useRecordVisit('dashboard');
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const dashboard = useDashboard({});
  const { data: answer, isLoading, isError, isFetching, refetch } = dashboard;
  const { layout, loaded, loading, failed: layoutFailed, retry: retryLayout, retrying: retryingLayout, update, reorder, add, reset } = useDashboardLayout();
  // The read computes only the tiles the layout showed when it was sent: when the layout shows one it holds nothing for,
  // the page reads once more, and a tile still without figures after that is one the server could not build.
  const { isWaiting, hasFailed } = useDashboardCoversLayout(dashboard, layout, loaded);
  // The server decides which tiles this person has (their switches), with the category, mode and label of each.
  // Hiding a tile on screen is never the security; this only draws what the server sent. Until the layout is read
  // the page cannot know which tiles to draw, so it draws plain placeholders that name none.
  const tileMeta = new Map((answer?.tiles ?? []).map((t) => [t.id, t]));

  const [edit, setEdit] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const dragId = useRef<string | null>(null);
  const phone = useIsMobile();
  // Reordering by arrows exists on touch screens only (EditableWidget's `touch:` buttons); everywhere else it is a drag.
  const touch = useMediaQuery('(pointer: coarse)');
  const reorderHint = touch ? (phone ? 'use the arrows to reorder' : 'drag or use the arrows to reorder') : 'drag to reorder';

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

  // Whether a tile has no usable answer: the whole read failed (nothing to draw from), or the server marked this tile as
  // one it could not build. Either way it says so with a way to try again; an answer of zero is a different thing.
  const tileFailed = (id: string): boolean => (answer ? isTileError((answer.data as Record<string, unknown>)[id]) || hasFailed(id) : isError);

  // The widgets that actually have a cell, in order. A hidden widget, an id the registry no longer
  // knows and a widget that vetoes its own cell are all skipped (see the render-loop notes above),
  // so Move up / Move down step over them: the neighbour is the next widget the user can SEE.
  const cells = layout
    .filter((item) => item.visible)
    .map((item) => {
      const def = V2_WIDGETS[item.id];
      if (!def) return null;
      if (answer && !tileMeta.has(item.id)) return null; // not a tile this person has
      const size = item.size ?? def.defaultSize;
      const range: TimeRange = item.range ?? def.defaultRange ?? '30d';
      const failed = tileFailed(item.id);
      // A tile with no answer yet (just added, its figures on the way) is drawn as loading, never as a zero.
      const waiting = !failed && isWaiting(item.id);
      const el = failed ? (
        <WidgetCard>
          <TileError title={def.title} onRetry={() => { void refetch(); }} retrying={isFetching} />
        </WidgetCard>
      ) : def.render({ data: waiting ? undefined : answer?.data, tile: tileMeta.get(item.id), range, navigate, isLoading: isLoading || waiting });
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
            {/* Not offered while the layout is unknown: an edit saved over a layout the page never saw would wipe it. */}
            {!layoutFailed && (
              <Button type="button" size="sm" variant={edit ? 'secondary' : 'default'} onClick={toggleEdit}>
                {edit ? <><Check /> Done</> : <><Pencil /> Customize home page</>}
              </Button>
            )}
          </>
        }
      />

      {/* Edit toolbar. `Reset to my role's default` overwrites the saved layout
          immediately with no confirmation - reproduced as-is and logged. The server puts back the default of the
          person's role. It is offered only once the saved layout has been read, so it never replaces one the page
          could not see. */}
      {edit && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand bg-brand-subtle px-4 py-2.5">
          <p className="text-[0.75rem] font-medium text-brand-emphasis">
            {phone
              ? `Edit mode - ${reorderHint} · ✕ to hide · the time pill sets each widget's range`
              : `Edit mode - ${reorderHint} · ✕ to hide · the time pill sets each widget's range · add more from the catalog →`}
          </p>
          <div className="flex items-center gap-3">
            {!catalogOpen && (
              <Button type="button" size="sm" variant="secondary" onClick={() => setCatalogOpen(true)}>
                <Plus /> Add widgets
              </Button>
            )}
            {loaded && (
              <Button type="button" variant="link" size={null} onClick={reset}>
                <RotateCcw /> Reset to my role's default
              </Button>
            )}
          </div>
        </div>
      )}

      {/* A person whose switches unlock no tile has a working, empty page: say so plainly (the customize button above
          stays, for when their access changes). */}
      {answer && answer.tiles.length === 0 && (
        <p className="mb-4 rounded-lg border border-border bg-surface-light px-4 py-6 text-center text-sm text-text-secondary">
          No tiles are available with your access.
        </p>
      )}

      {/* The person has tiles they could add, but their layout holds none to draw (a role that starts empty, or every tile
          hidden): say what to do rather than leave a blank page. */}
      {loaded && answer && answer.tiles.length > 0 && cells.length === 0 && (
        <p className="mb-4 rounded-lg border border-border bg-surface-light px-4 py-6 text-center text-sm text-text-secondary">
          Nothing is on your home page yet. Use Customize home page to add tiles.
        </p>
      )}

      {/* The layout could not be read: say so with a way to try again, never an empty page. */}
      {layoutFailed && (
        <WidgetCard>
          <TileError title="your home page" onRetry={retryLayout} retrying={retryingLayout} />
        </WidgetCard>
      )}

      {loading && (
        <div role="status" aria-busy="true" className="grid grid-cols-12 gap-3.5">
          <span className="sr-only">Loading your home page</span>
          {LOADING_CELLS.map((span, i) => (
            <Skeleton key={i} className={cn('h-28 rounded-lg', span)} />
          ))}
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

        <CatalogDrawer open={edit && catalogOpen} layout={layout} tiles={answer?.tiles ?? []} categories={answer?.categories ?? []} onAdd={add} onClose={() => setCatalogOpen(false)} />
      </div>
    </div>
  );
}
