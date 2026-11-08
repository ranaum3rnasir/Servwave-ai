import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Heading } from '@/components/ui/heading';
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
  const [isXL, setIsXL] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1280px)');
    setIsXL(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsXL(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isXL;
}

const ALL_ICON_ITEMS: { key: AllowedPanel; icon: typeof MessageSquare; label: string }[] = [
  { key: 'activity', icon: MessageSquare, label: 'Activity' },
  { key: 'attachments', icon: Paperclip, label: 'Attachments' },
];

const DEFAULT_PANELS: AllowedPanel[] = ['activity', 'attachments'];

export function IconRail({ entityType, entityId, children, panels = DEFAULT_PANELS }: IconRailProps) {
  const [activePanel, setActivePanel] = useState<PanelType>(null);
  const isXL = useIsXL();
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

  return (
    <div className="flex">
      {/* Main content */}
      <div
        className="flex-1 min-w-0 transition-[margin] duration-200"
        style={{ marginRight: panelOpen && isXL ? '360px' : '40px' }}
      >
        {children}
      </div>

      {/* Icon rail */}
      <div className="fixed right-0 top-[64px] bottom-0 w-10 bg-surface-light border-l border-border flex flex-col items-center pt-3 gap-2 z-30">
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
          this consolidation. Left as a documented residual; only the
          unsaved-note confirm below (a real modal, no background-interaction
          requirement) was migrated, onto the canonical ConfirmDialog. */}
      <div
        className={cn(
          'fixed right-10 top-[64px] bottom-0 w-80 bg-surface-light border-l border-border shadow-lg z-20 flex flex-col transition-transform duration-200',
          panelOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <Heading level={3}>
            {activePanel === 'activity' ? 'Activity' : activePanel === 'attachments' ? 'Attachments' : ''}
          </Heading>
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
        <div className="flex-1 overflow-y-auto">
          {activePanel === 'activity' && (
            <ActivityPanel entityType={entityType} entityId={entityId} />
          )}
          {activePanel === 'attachments' && (
            <AttachmentsPanel entityType={entityType} entityId={entityId} />
          )}
        </div>
      </div>

      {/* Overlay backdrop on smaller screens */}
      {panelOpen && !isXL && (
        <div className="fixed inset-0 z-10" onClick={close} />
      )}

      {/* Unsaved-note discard confirmation (#488) */}
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
    </div>
  );
}
