import { useState } from 'react';
import { X } from 'lucide-react';
import { WIDGETS } from './widgetRegistry';
import type { DashboardLayout } from '@/lib/dashboard/layoutTypes';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { fieldKindProps } from '@/ui-kit/lib/fieldKind';
import { useIsMobile } from '@/hooks/useIsMobile';

const CATS = ['Operations', 'Financial', 'Sales', 'Pipeline', 'Team', 'KPI'] as const;

/**
 * The add-widget catalog. From md up it is the rail beside the widgets, as it always was. Below md
 * (mobile slice 48) a 256 px rail would take most of a phone's width, so it is a bottom sheet the
 * page opens on purpose (the edit toolbar's Add widgets), leaving the widgets themselves in view
 * while their order is being changed.
 */
export default function CatalogDrawer({
  open,
  layout,
  onAdd,
  onClose,
}: {
  open: boolean;
  layout: DashboardLayout;
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const phone = useIsMobile();
  if (!open) return null;

  const onPage = new Set(layout.filter((i) => i.visible).map((i) => i.id));
  const items = Object.values(WIDGETS).filter((w) => w.title.toLowerCase().includes(q.toLowerCase()));

  const search = (
    <input
      {...fieldKindProps('search')}
      value={q}
      onChange={(e) => setQ(e.target.value)}
      placeholder="Search widgets & reports…"
      aria-label="Search widgets"
      className="m-3 w-[calc(100%-1.5rem)] rounded-lg border border-border px-3 py-2 text-xs mobile:!text-base focus:border-primary focus:outline-none"
    />
  );

  const list = (
    <>
      {CATS.map((cat) => {
        const inCat = items.filter((w) => w.category === cat);
        if (!inCat.length) return null;
        return (
          <div key={cat} className="px-3 pb-1">
            <p className="text-[9px] font-bold uppercase tracking-wider text-text-secondary mt-2 mb-1">{cat}</p>
            {inCat.map((w) => {
              const added = onPage.has(w.id);
              return (
                <div key={w.id} className="flex items-center gap-2 px-2 py-1.5 border border-border-soft rounded-lg mb-1.5 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-semibold text-text-primary" title={w.title}>{w.title}</span>
                  {added ? (
                    <span className="shrink-0 text-text-soft font-bold" title="Already on your page">✓</span>
                  ) : (
                    // hover:scale-110 pop has no equivalent in any Button variant (none use a
                    // scale transform); forcing tone="link" would swap it for an underline and
                    // change the current look, so left raw per the no-invented-treatment rule.
                    // 44 px on a touch screen (slice 48): the glyph stays the same size inside it.
                    <button type="button" onClick={() => onAdd(w.id)} className="shrink-0 text-primary font-extrabold text-base leading-none hover:scale-110 transition-transform touch:grid touch:size-11 touch:place-items-center" aria-label={`Add ${w.title}`}>＋</button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div className="m-3 p-2.5 border border-dashed border-border bg-background-light rounded-lg text-[11px] text-text-secondary font-semibold text-center cursor-not-allowed" title="Coming soon">
        ➕ Add a custom graph
        <span className="block text-[9px] font-medium text-text-soft mt-0.5">coming soon</span>
      </div>
    </>
  );

  if (phone) {
    return (
      <Sheet open onOpenChange={(next) => { if (!next) onClose(); }}>
        <SheetContent side="bottom" pad={0} gap={0} className="max-h-[85dvh] overflow-y-auto overscroll-contain">
          <div className="border-b border-border px-4 py-3 pr-14">
            <SheetTitle className="text-sm font-bold">＋ Add to home page</SheetTitle>
            <SheetDescription className="sr-only">Choose the widgets that show on your home page.</SheetDescription>
          </div>
          {search}
          {list}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside className="w-64 shrink-0 bg-surface-light border border-border rounded-xl overflow-y-auto overscroll-contain max-h-[82vh] sticky top-4 self-start">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <Heading level={3} weight="bold">＋ Add to home page</Heading>
        <Button
          type="button"
          onClick={onClose}
          variant="ghost"
          tone="subtle"
          size={null}
          aria-label="Close widget catalog"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {search}
      {list}
    </aside>
  );
}
