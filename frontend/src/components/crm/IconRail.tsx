import { useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import { MessageSquare, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Heading } from '@/components/ui/heading';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';
import { useIsBelow, useMediaQuery } from '@/ui-kit/hooks/useMediaQuery';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { DetailRailContext, type RailMenuEntry } from '@/components/detail/detailRailContext';
import { ActivityPanel } from './ActivityPanel';
import { AttachmentsPanel } from './AttachmentsPanel';

type PanelType = 'activity' | 'attachments' | null;
type AllowedPanel = 'activity' | 'attachments';

interface IconRailProps {
  entityType: 'LEAD' | 'JOB' | 'INVOICE';
  entityId: string;
  children?: React.ReactNode;
  /** Which panels to include in the rail. Defaults to both. */
  panels?: AllowedPanel[];
}

function useIsXL() {
  return useMediaQuery(MEDIA.xl);
}

/** The top bar's bottom edge when the page has none to measure (a test, a bare mount). */
const TOPBAR_FALLBACK_PX = 50;

function topBarElement(): Element | null {
  return document.querySelector('[data-slot="topbar"]');
}

function subscribeToTopBar(onChange: () => void) {
  const bar = topBarElement();
  const observer = bar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onChange) : null;
  if (bar && observer) observer.observe(bar);
  window.addEventListener('resize', onChange);
  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', onChange);
  };
}

/**
 * Where the rail and its panel start: the real bottom edge of the top bar. A literal offset
 * drifts the moment the bar changes height (it is one row on a desktop and compacts on a short
 * window), which left a gap or overlapped the bar.
 */
function useTopBarBottom(): number {
  return useSyncExternalStore(
    subscribeToTopBar,
    () => {
      const bar = topBarElement();
      return bar ? Math.round(bar.getBoundingClientRect().bottom) : TOPBAR_FALLBACK_PX;
    },
    () => TOPBAR_FALLBACK_PX,
  );
}

const ALL_ICON_ITEMS: { key: AllowedPanel; icon: typeof MessageSquare; label: string }[] = [
  { key: 'activity', icon: MessageSquare, label: 'Activity' },
  { key: 'attachments', icon: Paperclip, label: 'Attachments' },
];

const DEFAULT_PANELS: AllowedPanel[] = ['activity', 'attachments'];

export function IconRail({ entityType, entityId, children, panels = DEFAULT_PANELS }: IconRailProps) {
  const [activePanel, setActivePanel] = useState<PanelType>(null);
  const isXL = useIsXL();
  // Below md the rail reserves no width: its triggers move into the header's overflow menu and
  // its panel is an overlay sheet (mobile slice 56).
  const phone = useIsBelow('md');
  const barBottom = useTopBarBottom();
  const panelOpen = activePanel !== null;

  // Route panel exits through the shared unsaved-changes guard so a dirty note
  // draft (published by ActivityPanel) prompts before the panel unmounts (#488).
  const pendingLeave = useSettingsGuard((s) => s.pendingLeave);
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const resolvePending = useSettingsGuard((s) => s.resolvePending);
  const cancelPending = useSettingsGuard((s) => s.cancelPending);

  const toggle = useCallback(
    (panel: PanelType) =>
      requestLeave(() => setActivePanel((prev) => (prev === panel ? null : panel))),
    [requestLeave]
  );

  const close = useCallback(() => requestLeave(() => setActivePanel(null)), [requestLeave]);

  const icons = ALL_ICON_ITEMS.filter((item) => panels.includes(item.key));

  // What the header's overflow menu lists on a phone; null from md up, where the rail has a column.
  const menuEntries = useMemo<readonly RailMenuEntry[] | null>(
    () =>
      phone
        ? ALL_ICON_ITEMS.filter((item) => panels.includes(item.key)).map(({ key, icon: Icon, label }) => ({
            key,
            label,
            icon: <Icon />,
            open: () => toggle(key),
          }))
        : null,
    [phone, panels, toggle],
  );

  const activeLabel = ALL_ICON_ITEMS.find((item) => item.key === activePanel)?.label ?? '';
  const panelBody = (
    <>
      {activePanel === 'activity' && <ActivityPanel entityType={entityType} entityId={entityId} />}
      {activePanel === 'attachments' && <AttachmentsPanel entityType={entityType} entityId={entityId} />}
    </>
  );

  const discardDialog = (
    <ConfirmDialog
      open={!!pendingLeave}
      onOpenChange={(o) => !o && cancelPending()}
      title="Discard unsaved note?"
      description="Your note hasn't been added yet and will be lost if you leave."
      variant="destructive"
      confirmLabel="Discard note"
      cancelLabel="Keep editing"
      onConfirm={() => resolvePending()}
    />
  );

  return (
    <DetailRailContext.Provider value={menuEntries}>
      {/* One tree at every width, so crossing md (a rotation, a resized window) keeps the page's state. */}
      <div className="flex">
        {/* Main content. Below md it takes the whole width: no margin, no rail column. */}
        <div
          data-testid="icon-rail-content"
          className="flex-1 min-w-0 transition-[margin] duration-200"
          style={phone ? undefined : { marginRight: panelOpen && isXL ? '360px' : '40px' }}
        >
          {children}
        </div>

        {phone ? (
          // A modal sheet: focus moves in and is trapped, Escape closes, and the page behind is inert.
          // The kit's Sheet draws it full-screen below md. Leaving still goes through the unsaved-note guard.
          <Sheet open={panelOpen} onOpenChange={(open) => !open && close()}>
            <SheetContent
              side="right"
              intent="content"
              data-testid="icon-rail-sheet"
              // The opener is a header menu item, not a Dialog.Trigger, so Radix has nowhere to return
              // focus to: hand it back to the header's menu button.
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                document.querySelector<HTMLElement>('[data-slot="detail-actions-trigger"]')?.focus();
              }}
            >
              <SheetHeader>
                <SheetTitle>{activeLabel}</SheetTitle>
                <SheetDescription className="sr-only">{activeLabel} for this record</SheetDescription>
              </SheetHeader>
              <SheetBody className="p-0">{panelBody}</SheetBody>
            </SheetContent>
          </Sheet>
        ) : (
          <>
            <div
              data-testid="icon-rail"
              style={{ top: barBottom }}
              className="fixed right-[env(safe-area-inset-right,0px)] bottom-0 pb-[env(safe-area-inset-bottom,0px)] w-10 bg-surface-light border-l border-border flex flex-col items-center pt-3 gap-2 z-30"
            >
              {icons.map(({ key, icon: Icon, label }) => (
                // Segmented icon-rail toggle: the active state's persistent bg-primary/10 +
                // text-primary idle look has no matching Button cell - not Button-shaped, left raw.
                <button
                  key={key}
                  type="button"
                  onClick={() => toggle(key)}
                  title={label}
                  aria-label={label}
                  className={cn(
                    'flex items-center justify-center h-9 w-9 rounded-md transition-colors',
                    activePanel === key
                      ? 'bg-primary/10 text-primary'
                      : 'text-text-secondary hover:bg-background-light'
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </button>
              ))}
            </div>

            {/* Sliding panel — INTENTIONALLY NOT migrated onto the shared `Sheet`
                primitive (overlays consolidation pass). Sheet's SheetContent always
                renders a viewport-covering Radix Overlay (fixed inset-0, z-50) and,
                by default, aria-hides + pointer-traps everything outside the dialog
                while open. Both of those sit ABOVE the icon rail's trigger buttons
                (z-30) and would block the "switch directly to the other rail icon"
                / "re-click the open icon to close" interactions this panel relies
                on (see the always-on-top rail + low z-10 click-catcher below, kept
                from the pre-existing design on BOTH the XL and non-XL branches).
                A custom Radix composition that drops the Overlay and sets
                modal={false} could avoid that, but it stops being a drop-in Sheet
                and starts being a bespoke primitive again — against the point of
                this consolidation. Left as a documented residual at md and up.
                Below md there is no rail to keep reachable, so the panel IS a
                Sheet there (mobile slice 56); only the unsaved-note confirm below (a real modal, no background-interaction
                requirement) was migrated, onto the canonical ConfirmDialog. */}
            <div
              data-testid="icon-rail-panel"
              style={{ top: barBottom }}
              // Closed, the panel is only moved off-screen, so it is also taken out of the tab order and the
              // accessibility tree: it used to be reachable by keyboard while invisible.
              inert={!panelOpen}
              aria-hidden={panelOpen ? undefined : true}
              className={cn(
                // Never wider than the space left of the rail, so it fits any viewport that gets a rail.
                // Beside the rail, so it also clears the notch side (mobile slice 52); the bottom pads for the home
                // indicator, and closed it slides past its own width, the rail's 40 px and that inset so no sliver shows.
                'fixed right-[calc(40px+env(safe-area-inset-right,0px))] bottom-0 pb-[env(safe-area-inset-bottom,0px)] w-[min(20rem,calc(100vw-2.5rem-env(safe-area-inset-right,0px)))] bg-surface-light border-l border-border shadow-lg z-20 flex flex-col transition-transform duration-200',
                panelOpen ? 'translate-x-0' : 'translate-x-[calc(100%+40px+env(safe-area-inset-right,0px))]'
              )}
            >
              {/* Panel header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                <Heading level={3}>{activeLabel}</Heading>
                {/* Small close-X affordance, not Button-shaped - left raw. */}
                <button
                  type="button"
                  aria-label="Close panel"
                  onClick={close}
                  className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:bg-background-light transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Panel content */}
              <div className="flex-1 overflow-y-auto overscroll-contain">{panelBody}</div>
            </div>

            {/* Overlay backdrop on smaller screens */}
            {panelOpen && !isXL && (
              <div className="fixed inset-0 z-10" onClick={close} />
            )}
          </>
        )}

        {/* Unsaved-note discard confirmation (#488) */}
        {discardDialog}
      </div>
    </DetailRailContext.Provider>
  );
}
