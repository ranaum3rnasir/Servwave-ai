import { lazy, Suspense } from 'react';
import { Phone } from 'lucide-react';

import { formatPhone } from '@/lib/utils';
import { usePhoneSheetStore, type CallPhase } from '@/stores/phoneSheet.store';
import { Button } from '@/ui-kit/components/ui/button';

/**
 * The same-tab dialer's two surfaces (mobile slice 63), mounted once in the staff layout.
 *
 * On a phone and in the installed app a Call never opens a window or a tab. It opens the dialer as a
 * full-screen sheet over the page the user is on (`PhoneSheet`), pre-filled with the number and the
 * record; the call goes by the bridge, so the user's own phone rings first. When the user minimises
 * the sheet with a call in progress it becomes a small call bar (`PhoneCallBar`) that stays on screen
 * while they move around the app. The call itself lives in the one dialer the sheet keeps mounted, so
 * minimising and navigating never drop it.
 *
 * This file is what the staff entry bundle carries, so it stays small: the sheet (and the dialer
 * inside it) is its own chunk, loaded the first time a phone user taps Call.
 */
const PhoneSheet = lazy(() => import('./PhoneSheet'));

export function PhoneSheetHost() {
  const mode = usePhoneSheetStore((s) => s.mode);
  if (mode === 'closed') return null;
  return (
    <Suspense fallback={null}>
      <PhoneSheet />
    </Suspense>
  );
}

const PHASE_TEXT: Record<CallPhase, string> = {
  idle: '',
  calling: 'Calling',
  placed: 'Call in progress',
  active: 'On a call',
  ringing: 'Incoming call',
  ended: 'Call ended',
};

/**
 * The call bar: one row directly under the top bar (in the page's flow, so it never covers a page's
 * own header or a sticky Save row) while a minimised call is going or has just ended. Tap Open to
 * bring the dialer back.
 */
export function PhoneCallBar() {
  const mode = usePhoneSheetStore((s) => s.mode);
  const call = usePhoneSheetStore((s) => s.call);
  const expand = usePhoneSheetStore((s) => s.expand);
  const close = usePhoneSheetStore((s) => s.close);
  if (mode !== 'bar') return null;

  const ended = call.phase === 'ended';
  return (
    <div
      role="region"
      aria-label={ended ? 'Call ended' : 'Call in progress'}
      className={
        ended
          ? 'flex shrink-0 items-center gap-3 border-b bg-muted px-4 py-1 text-foreground'
          : 'flex shrink-0 items-center gap-3 bg-success px-4 py-1 text-on-fill'
      }
    >
      <Phone className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 leading-tight" aria-live="polite">
        <p className="truncate text-sm font-semibold">{PHASE_TEXT[call.phase]}</p>
        {call.number && <p className="truncate text-xs">{formatPhone(call.number)}</p>}
      </div>
      {ended && (
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          Dismiss
        </Button>
      )}
      <Button
        type="button"
        variant={ended ? 'outline' : 'secondary'}
        size="sm"
        aria-label={ended ? 'Open dialer' : 'Open call'}
        onClick={expand}
      >
        Open
      </Button>
    </div>
  );
}
