import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Phone } from 'lucide-react';

import { DialerWorkspace } from '@/components/communication/phone/Dialer';
import { useCalls } from '@/lib/api/communication';
import { useMyOutboundNumber } from '@/lib/api/myOutboundNumber';
import { providerNumberIdOf } from '@/lib/api/providerNumberId';
import { useMyNumbers, type MyNumberOption } from '@/lib/api/phoneNumbers';
import {
  DIAL_STORAGE_KEY, PHONE_TAB_NAME, type PhoneDialMessage,
} from '@/lib/communication/phoneTabHandoff';
import {
  bringMainAppForward,
  useOfficeSoftphoneCallActive,
  useOfficeSoftphoneGeneration,
  usePhoneDeviceIdentity,
  usePhoneTabDeviceTeardown,
  useWarnBeforeUnloadDuringCall,
} from '@/lib/communication/phoneTabDevice';
import type { DialerEntityContext } from '@/stores/dialer.store';

import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';

/** How a caller-ID number reads on the page. The endpoint sends the number
 *  itself as `formatted` whenever it has one; with none (or a blank one), a
 *  neutral label. Never
 *  the phone service's own number id: that is how a call is placed, not
 *  something a person should see. */
function numberLabel(n: Pick<MyNumberOption, 'formatted'>): string {
  return n.formatted?.trim() || 'Unknown number';
}

/**
 * /v2/phone - the dedicated softphone tab.
 *
 * Deliberately NOT inside V2AppLayout, mirroring App.tsx: this is a standalone
 * tab a user keeps open alongside the app, not a page embedded in the app
 * chrome. Wrapping it in the v2 shell would give it a sidebar, a topbar and a
 * SECOND GlobalDialer - and the shell's own dialer plus this one would be two
 * device-owning surfaces where the architecture allows exactly one.
 *
 * This tab is the ONLY place the phone device runs (the main window boots
 * none). `DialerWorkspace surface="phone-tab"` is the one call site allowed to
 * boot the shared device, there is exactly ONE device-owning `Softphone` on the
 * page (the one inside that workspace), and this page owns the device's end:
 * usePhoneTabDeviceTeardown destroys it on unmount, on logout and when another
 * account signs in over this session (see lib/communication/phoneTabDevice.ts
 * for that and for the boot trigger).
 *
 * Handoff, window.name untainting, the caller-ID seed and the BroadcastChannel
 * receiver are carried across line for line from `pages/phone/PhoneShell.tsx`.
 * The chrome is the only substitution, and the caller-ID picker is the one real
 * change: a raw select becomes the kit Select, keeping the same accessible name
 * ("Calling from") and the same option labels.
 */
export default function PhoneTabPage() {
  usePhoneTabDeviceTeardown();
  useWarnBeforeUnloadDuringCall();
  const callActive = useOfficeSoftphoneCallActive();
  // Everything that belongs to the signed-in account (the caller-ID pick, the
  // dial being seeded, the console) lives in PhoneTabWorkspace, keyed on WHO is
  // signed in (user + org). Another account signing in over this session (no
  // logout) remounts it with fresh state: the new account's own default caller
  // ID, an empty dial field, no previous context. Keyed on the account, not on
  // the device generation, because the generation also moves on teardowns that
  // change no account (React.StrictMode's simulated unmount in dev runs the
  // unmount teardown), and those must not wipe the dial.
  const identity = usePhoneDeviceIdentity();

  // The startup dials - the `?dial=` handoff and a stashed boot-race dial -
  // belong to the account that opened this tab. Exactly one claim succeeds per
  // page: the first workspace's. A later workspace (another account), and
  // StrictMode's second effect run, get false.
  const startupDialClaimed = useRef(false);
  const claimStartupDial = useCallback(() => {
    if (startupDialClaimed.current) return false;
    startupDialClaimed.current = true;
    return true;
  }, []);

  // Toast for the workspace's "ready, press Call" feedback. Page-local and on
  // its own timer, as in the legacy shell - this tab is outside the app chrome
  // and has no toaster of its own.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Untaint the browsing context on the way out. A tab keeps its `window.name`
  // across in-tab navigation, so leaving this tab would otherwise leave it
  // permanently branded, and every later Call button clicked FROM that tab
  // would find window.open(url, name) targeting its own name - an in-place
  // navigation rather than a new tab, so the dialer would silently stop
  // popping out for the rest of that tab's life.
  useEffect(
    () => () => {
      if (window.name === PHONE_TAB_NAME) window.name = '';
    },
    [],
  );

  return (
    <div className="bg-app flex min-h-screen flex-col">
      <header className="bg-kit-card flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="bg-brand-subtle text-brand flex size-8 items-center justify-center rounded-full">
            <Phone className="size-4" />
          </span>
          {/* role/aria-level rather than a heading tag: the design-system
              raw-tag ratchet counts h1-h6 and this module adds none. */}
          <p role="heading" aria-level={1} className="text-base font-semibold">
            ServWave Phone
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          {/* During a live call, leaving this tab would drop the call (the page
              owns the device), so the link brings the app forward elsewhere
              instead, and says so here in case the browser declines to raise
              the other tab. A modified or non-primary click is left to the
              browser (its own new tab or window), which never touches this
              one. With no call it navigates this tab, as it always has. */}
          <Link
            to="/"
            onClick={(e) => {
              if (!callActive) return;
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              bringMainAppForward();
              onToast('Your call continues in this tab.');
            }}
          >
            <ArrowLeft />
            Back to ServWave
          </Link>
        </Button>
      </header>

      <PhoneTabWorkspace
        key={identity ?? 'signed-out'}
        claimStartupDial={claimStartupDial}
        onToast={onToast}
      />

      {/* Always mounted, only its text changes: a live region that appears
          together with its first message is often not announced. */}
      <div
        role="status"
        className={
          toast
            ? 'bg-kit-card fixed bottom-6 right-6 z-[90] rounded-lg border px-4 py-3 text-sm font-medium shadow-lg'
            : 'sr-only'
        }
      >
        {toast ?? ''}
      </div>
    </div>
  );
}

/**
 * The account-scoped part of the phone tab: caller-ID picker, dial handoff and
 * the device-owning console. Remounted (keyed) by PhoneTabPage whenever the
 * signed-in account changes, so nothing here outlives the account it was for.
 */
function PhoneTabWorkspace({
  claimStartupDial,
  onToast,
}: {
  /** True for exactly one caller per page: whoever may apply the startup
   *  dials (URL handoff, boot-race stash). */
  claimStartupDial: () => boolean;
  onToast: (msg: string) => void;
}) {
  // The device-owning console is keyed on the device generation: once a
  // teardown destroys a device this subtree outlives (an account switch, or
  // StrictMode's simulated unmount in dev), the console remounts with fresh
  // latches and boots a fresh device, instead of showing the destroyed one's
  // "Ready". Its dial still comes from this workspace's state, so it survives.
  const deviceGeneration = useOfficeSoftphoneGeneration();
  const { data: myNumbers } = useMyNumbers();
  const { data: resolvedOutboundNumber } = useMyOutboundNumber();
  const { data: calls = [] } = useCalls();
  const [searchParams] = useSearchParams();

  const resolvedDefaultTpnId =
    resolvedOutboundNumber && !('none' in resolvedOutboundNumber)
      ? providerNumberIdOf(resolvedOutboundNumber)
      : undefined;

  // Only rows the softphone can dial from are caller-ID choices: a row with no
  // phone-service id is dropped here, so it is never an option with an empty
  // value and never counts toward "more than one number".
  const numbers = (myNumbers?.numbers ?? []).flatMap((n) => {
    const providerId = providerNumberIdOf(n);
    return providerId ? [{ ...n, providerId }] : [];
  });
  const soleNumber = numbers.length === 1 ? numbers[0] : undefined;
  // Undefined = "no explicit pick yet" (Softphone falls through to its own
  // resolved default); a truthy string is the user's active pick.
  const [selectedTpnId, setSelectedTpnId] = useState<string | undefined>(undefined);
  // The same pick as ServWave's own number id, for the bridge call (a phone
  // never boots the browser phone, so its calls go out as the bridge).
  const selectedNumberId = selectedTpnId
    ? numbers.find((n) => n.providerId === selectedTpnId)?.phone_number_id
    : undefined;

  // The dial the workspace should seed + auto-pick. `nonce` bumps per dial so
  // re-dialing the SAME number still re-fires the workspace's seed/auto-pick
  // effect (its openNumber value alone would not change).
  const [dial, setDial] = useState<{
    number: string;
    ctx: DialerEntityContext | null;
    nonce: number;
  } | null>(null);
  const nonceRef = useRef(0);
  const pushDial = (number: string, ctx: DialerEntityContext | null) => {
    nonceRef.current += 1;
    setDial({ number, ctx, nonce: nonceRef.current });
  };
  /** Seeds a dial message into the console; false when it is not one. */
  const applyDial = (msg: PhoneDialMessage | null | undefined): boolean => {
    if (!msg || msg.type !== 'dial' || !msg.phone) return false;
    pushDial(msg.phone, msg.ctx ?? null);
    return true;
  };

  // Seed the picker's selection to the resolved primary number as soon as it is
  // known, UNLESS the caller already made an explicit pick.
  useEffect(() => {
    if (selectedTpnId === undefined && resolvedDefaultTpnId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- `undefined` means "the caller has not picked yet" and must stay distinguishable from a real pick, so the default can only be written once the async lookup resolves; deriving it during render would silently override a pick made before the number arrived
      setSelectedTpnId(resolvedDefaultTpnId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDefaultTpnId]);

  // Startup dials, applied once per page by the workspace that claims them:
  //  - the first-open handoff (dial number + entity context off the URL);
  //  - a stashed dial (localStorage) for the boot race where a dial landed
  //    before this tab's channel listener mounted. Only a very recent stash
  //    counts, and it is removed either way, so it never re-dials later.
  useEffect(() => {
    if (!claimStartupDial()) return;
    const number = searchParams.get('dial');
    if (number) {
      const ctxRaw = searchParams.get('ctx');
      let ctx: DialerEntityContext | null = null;
      if (ctxRaw) {
        try {
          ctx = JSON.parse(ctxRaw) as DialerEntityContext;
        } catch {
          ctx = null;
        }
      }
      pushDial(number, ctx);
    }
    try {
      const raw = localStorage.getItem(DIAL_STORAGE_KEY);
      if (raw) {
        const msg = JSON.parse(raw) as PhoneDialMessage;
        if (msg && typeof msg.ts === 'number' && Date.now() - msg.ts < 10_000) applyDial(msg);
        localStorage.removeItem(DIAL_STORAGE_KEY);
      }
    } catch {
      /* storage blocked - ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subsequent dials into this already-open tab arrive over the
  // BroadcastChannel. Never re-navigates - the live call is never dropped. The
  // sender also stashes each dial for the boot race; once the channel copy is
  // applied that stash is spent, so it is removed - otherwise a workspace
  // mounted within its 10-second window (another account) could replay it.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(PHONE_TAB_NAME);
    ch.onmessage = (e) => {
      if (!applyDial(e.data as PhoneDialMessage)) return;
      try {
        localStorage.removeItem(DIAL_STORAGE_KEY);
      } catch {
        /* storage blocked - ignore */
      }
    };
    return () => ch.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex flex-1 flex-col items-center p-6">
      <div className="w-full max-w-3xl space-y-3">
        {numbers.length > 1 ? (
          <div className="max-w-xs">
            <Label
              htmlFor="phone-tab-caller-id"
              className="text-muted-foreground mb-1 block text-[11px] font-semibold uppercase tracking-wide"
            >
              Calling from
            </Label>
            <SelectField
              id="phone-tab-caller-id"
              value={selectedTpnId ?? ''}
              onValueChange={setSelectedTpnId}
              aria-label="Calling from"
              options={numbers.map((n) => ({
                value: n.providerId,
                label: `${numberLabel(n)}${n.is_org_default ? ' (Company)' : ''}`,
              }))}
            />
          </div>
        ) : soleNumber ? (
          <div className="max-w-xs">
            <span className="text-muted-foreground mb-1 block text-[11px] font-semibold uppercase tracking-wide">
              Calling from
            </span>
            <p className="bg-kit-card rounded-md border px-3 py-2 text-sm">
              {numberLabel(soleNumber)}
            </p>
          </div>
        ) : null}

        <DialerWorkspace
          key={deviceGeneration}
          surface="phone-tab"
          callerIdOverride={selectedTpnId}
          callerIdNumberId={selectedNumberId}
          calls={calls}
          onToast={onToast}
          openNumber={dial?.number ?? null}
          openContext={dial?.ctx ?? null}
          openNonce={dial?.nonce}
        />
      </div>
    </main>
  );
}
