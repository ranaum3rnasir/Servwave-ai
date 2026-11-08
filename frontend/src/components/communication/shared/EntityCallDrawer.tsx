/**
 * Entity-tab call detail — the right-side slide-in behind a clicked call row on
 * the Job / Customer / Lead Communication tabs.
 *
 * It fetches the full CallSession by id and renders the comm hub's existing
 * `CallDetailDrawer` (recording player + lazy transcript + call insights +
 * answered-by + attach-to-job), so a call opens the SAME detail experience here
 * as in the hub. Opening a call also fires the drawer's lazy transcript fetch,
 * hydrating a transcript CTM finished after the `end` webhook.
 *
 * `CallDetailDrawer` lives in the calls-hub module and pulls the CallsView +
 * Dialer graph, so it is lazy-loaded here: that heavy code splits OUT of the
 * Job/Customer/Lead page bundles and only loads when a call is actually opened.
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useCall } from '@/lib/api/communication';
import { toast } from '@/components/ui/use-toast';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

const CallDetailDrawer = lazy(() =>
  import('@/components/communication/phone/CallsView').then((m) => ({
    default: m.CallDetailDrawer,
  })),
);

interface EntityCallDrawerProps {
  callId: string;
  onClose: () => void;
}

/** The hub drawer's right-side frame, reused for the loading / error / suspense
 *  states so the panel is present the instant a row is clicked. Uses the same
 *  Sheet shell (right side, sm:max-w-md) as the real CallDetailDrawer it
 *  precedes, so the frame doesn't visibly change shape when the lazy-loaded
 *  drawer swaps in. */
function DrawerShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col items-center justify-center gap-0 p-0 sm:max-w-md"
      >
        <SheetTitle className="sr-only">Call details</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}

function Spinner() {
  return (
    <span role="status" className="flex items-center gap-2 text-sm text-text-secondary">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading call…
    </span>
  );
}

export function EntityCallDrawer({ callId, onClose }: EntityCallDrawerProps) {
  const { data: call, isLoading } = useCall(callId);

  if (call) {
    return (
      <Suspense
        fallback={
          <DrawerShell onClose={onClose}>
            <Spinner />
          </DrawerShell>
        }
      >
        <CallDetailDrawer call={call} onClose={onClose} onToast={(m) => toast({ description: m })} />
      </Suspense>
    );
  }

  // Loading (or a rare not-found) — the same right-side frame so the open feels
  // instant and the backdrop still closes it.
  return (
    <DrawerShell onClose={onClose}>
      {isLoading ? (
        <Spinner />
      ) : (
        <p className="px-6 text-center text-sm text-text-secondary">Couldn't load this call.</p>
      )}
    </DrawerShell>
  );
}
