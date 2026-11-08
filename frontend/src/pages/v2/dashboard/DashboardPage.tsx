import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Pencil, RotateCcw } from 'lucide-react';
import { motion, MotionConfig } from 'framer-motion';

import { useAuthStore } from '@/stores/auth.store';
import { useDashboard } from '@/lib/api/dashboard';
import { useDashboardLayout } from '@/lib/dashboard/useDashboardLayout';
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
 * NO LOADING, ERROR OR SKELETON STATE, deliberately. The page destructures only
 * `data`; every KPI reads through `?? 0`, so a first paint and a 403 look
 * identical - zeros and empty cards. That is the existing behaviour and adding
 * the kit's skeletons here would be a behaviour change, not a restyle, so it is
 * raised in the ledger as a follow-up instead.
 */
export default function DashboardPage() {
  useRecordVisit('dashboard');
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { data } = useDashboard({});
  const { layout, update, reorder, add, reset } = useDashboardLayout();

  const [edit, setEdit] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const dragId = useRef<string | null>(null);

  // Entering edit mode opens the catalog; leaving it closes it. One state
  // change, two effects, exactly as before.
  const toggleEdit = () => {
    setEdit((e) => {
      const next = !e;
      setCatalogOpen(next);
      return next;
    });
  };

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
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-brand bg-brand-subtle px-4 py-2.5">
          <p className="text-[12px] font-medium text-brand-emphasis">
            Edit mode - drag to reorder · ✕ to hide · the time pill sets each widget's range · add more from the catalog →
          </p>
          <Button type="button" variant="link" size={null} onClick={reset}>
            <RotateCcw /> Reset to default
          </Button>
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
            {layout
              .filter((item) => item.visible)
              .map((item) => {
                const def = V2_WIDGETS[item.id];
                if (!def) return null;
                const size = item.size ?? def.defaultSize;
                const range: TimeRange = item.range ?? def.defaultRange ?? '30d';
                const el = def.render({ data, range, navigate });
                if (!el) return null;
                return (
                  <motion.div
                    key={item.id}
                    layout="position"
                    layoutDependency={layout.map((i) => i.id).join()}
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                    className={SIZE_SPAN[size]}
                  >
                    <EditableWidget
                      id={item.id}
                      edit={edit}
                      range={range}
                      onHide={() => update(item.id, { visible: false })}
                      onRange={(r) => update(item.id, { range: r })}
                      onDragStart={(id) => (dragId.current = id)}
                      onDrop={(id) => { if (dragId.current) reorder(dragId.current, id); dragId.current = null; }}
                    >
                      {el}
                    </EditableWidget>
                  </motion.div>
                );
              })}
          </div>
        </MotionConfig>

        <CatalogDrawer open={edit && catalogOpen} layout={layout} onAdd={add} onClose={() => setCatalogOpen(false)} />
      </div>
    </div>
  );
}
