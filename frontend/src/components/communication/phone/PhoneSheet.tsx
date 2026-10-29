import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';

import { isCallInProgress, usePhoneSheetStore } from '@/stores/phoneSheet.store';
import { Button } from '@/ui-kit/components/ui/button';
import { useOverlay } from '@/ui-kit/hooks/useOverlay';
import { cn } from '@/ui-kit/lib/utils';
import { Softphone } from './Softphone';

/**
 * The same-tab dialer (mobile slice 63): a full-screen sheet over the page the user is on.
 *
 * It is how Call works on a phone and in the installed app, where a new window or tab is dropped.
 * The dialer inside is the ordinary one on its bridge path (it never starts the in-browser phone:
 * `surface` is left at its inline default), so the user's own phone rings first and, when they
 * answer, the customer is dialled from the business number.
 *
 * Minimising it with a call in progress does NOT unmount the dialer: the sheet is only hidden, so
 * the call, its outcome poll and its attribution carry on while the call bar (PhoneSheetHost) shows
 * on every page. Closing, or finishing the call, is what unmounts it.
 *
 * Shown or hidden by `mode`; the sheet owns the modal behaviours while it is up (focus moves in and
 * back, Tab stays inside, Escape minimises, the page behind does not scroll).
 */
export default function PhoneSheet() {
  const mode = usePhoneSheetStore((s) => s.mode);
  const call = usePhoneSheetStore((s) => s.call);
  const prefillNumber = usePhoneSheetStore((s) => s.prefillNumber);
  const context = usePhoneSheetStore((s) => s.context);
  const collapse = usePhoneSheetStore((s) => s.collapse);
  const close = usePhoneSheetStore((s) => s.close);
  const consumePrefill = usePhoneSheetStore((s) => s.consumePrefill);
  const reportCall = usePhoneSheetStore((s) => s.reportCall);

  const expanded = mode === 'sheet';
  const inProgress = isCallInProgress(call);
  const ref = useRef<HTMLDivElement>(null);
  const minimise = useCallback(() => collapse(), [collapse]);
  useOverlay(expanded, ref, minimise);

  // Leaving the page from inside the sheet (the dialer's link to My Profile) shows that page: the
  // sheet goes back to a call bar when a call is going, and away otherwise.
  const { pathname } = useLocation();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (usePhoneSheetStore.getState().mode === 'sheet') collapse();
  }, [pathname, collapse]);

  const showHint = call.phase === 'idle' || call.phase === 'calling';

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Dialer"
      aria-hidden={!expanded}
      data-slot="phone-sheet"
      className={cn(
        // Above page content and the navigation drawer, level with other full-screen sheets. It
        // reserves the status bar, the home indicator and the on-screen keyboard like they do.
        'bg-kit-card fixed inset-x-0 top-0 z-50 h-[calc(100dvh-var(--keyboard-inset,0px))] flex-col',
        'pt-[env(safe-area-inset-top,0px)] pb-[var(--safe-bottom,0px)] pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]',
        expanded ? 'flex' : 'hidden',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b py-1 pr-2 pl-4">
        <p role="heading" aria-level={2} className="text-base font-bold tracking-tight">
          Dialer
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={inProgress ? 'Minimise dialer' : 'Close dialer'}
          onClick={inProgress ? minimise : close}
        >
          {inProgress ? <ChevronDown aria-hidden /> : <X aria-hidden />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {showHint && (
          <p className="text-muted-foreground mb-3 text-center text-sm">
            Your phone will ring first, answer to connect.
          </p>
        )}
        <Softphone
          prefillNumber={prefillNumber}
          onConsumedPrefill={consumePrefill}
          entityContext={context}
          onCallStatus={reportCall}
          onEnded={close}
        />
      </div>
    </div>
  );
}
