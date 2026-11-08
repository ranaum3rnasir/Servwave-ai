import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useFeature } from '@/lib/entitlements';
import { requestPhoneAccessToken } from '@/lib/api/phoneNumbers';
import { isCtmSoftphoneEnabled, type CtmSoftphone, type SoftphoneFault } from './ctmSoftphone';
import {
  ensureOfficeSoftphone,
  getOfficeSoftphoneFault,
  isOfficeSoftphoneReady,
  markOfficeSoftphoneCallDialled,
  markOfficeSoftphoneCallHungUp,
  subscribeOfficeSoftphoneReady,
  subscribeOfficeSoftphoneFault,
} from './officeSoftphone';
import { usePhoneTabBootGate } from './phoneTabDevice';
import { isPhoneDevice } from '@/lib/device/isPhoneDevice';

/**
 * Slice 4 — office WebRTC softphone lifecycle.
 *
 * Returns a handle for any signed-in user of a communication-enabled org,
 * whatever their role, WHEN the softphone flag is on AND the caller is the
 * `/phone` tab (`surface: 'phone-tab'`) AND the browser is not on a phone
 * (isPhoneDevice); otherwise `null`, and the caller keeps the existing
 * callback-bridge / `tel:` path unchanged. This is the "device axis": the
 * DEVICE selects the transport, never the role (Ran, 2026-10-03) - a
 * browser not on a phone (computer or tablet) gets the browser phone, a phone
 * gets the bridge, for every role.
 *
 * The flag defaults OFF, so this changes no current behavior until it is flipped
 * on for the pilot during live QA.
 *
 * Fix B (warm singleton): the CtmSoftphone device lives in officeSoftphone.ts
 * as a page-load-scoped singleton that survives this hook mounting/unmounting.
 * This hook only gets-or-creates it and subscribes; it never destroys it. The
 * owner of the device's lifetime is the `/phone` tab (PhoneTabPage, via
 * usePhoneTabDeviceTeardown in phoneTabDevice.ts), which tears it down on
 * unmount and on logout. There is no main-window warm-up any more: the device
 * runs only in the `/phone` tab.
 * `ready` is seeded synchronously from the singleton's latch (isOfficeSoftphoneReady)
 * so a hook mounted AFTER the device already finished booting reports ready
 * immediately, then this hook subscribes for any FUTURE ready transition.
 *
 * Task A2 (the boot gate): `ensureOfficeSoftphone` only runs when
 * `surface === 'phone-tab'`. It defaults to `'inline'` (no boot), so the
 * main-app GlobalDialer popup (via `Softphone.tsx`) never registers a device;
 * the `/phone` route is the sole surface that passes `'phone-tab'`. WHEN the
 * phone tab boots is decided by usePhoneTabBootGate (phoneTabDevice.ts): by
 * default as soon as the tab mounts (the 'mount' trigger), or, if that is ever
 * switched to 'first-gesture', inside the user's first gesture in the tab.
 */
/** The caller-info payload carried by the device's 'incoming' event
 *  (bridged from CTM's `ctm:incomingCall` in ctmSoftphone.ts). The exact
 *  field names are unconfirmed pending live QA (see ctmSoftphone.ts's
 *  EVENT_MAP note), so this is passed through opaquely rather than parsed. */
export type IncomingCallInfo = Record<string, unknown>;

export interface OfficeSoftphone {
  /** True once the embed script loaded, the device mounted, and the token set. */
  ready: boolean;
  /**
   * Why the device is not ready, once that is knowable — null while it is
   * simply still booting, and null again if it eventually boots. Mutually
   * exclusive with `ready` (officeSoftphone.ts enforces it).
   *
   * This rides the SAME handle as `ready` deliberately. Every surface that can
   * show a softphone — the main app's GlobalDialer popup and the dedicated
   * `/phone` tab alike — reads the device only through this hook, so one field
   * here covers both. It stays null on the bridge/`tel:` path for the same
   * reason `ready` is irrelevant there: the hook returns null outright, so no
   * inline caller can ever be told a device failed that it never booted.
   */
  fault: SoftphoneFault | null;
  /**
   * True while the device is not booted yet only because the boot trigger is
   * waiting for the user's first gesture in this tab (phoneTabDevice.ts,
   * 'first-gesture' mode). Nothing is connecting yet, so the UI must say so
   * instead of "Connecting…". Always false with the 'mount' trigger.
   */
  awaitingStart: boolean;
  /** Place an outbound call through the browser (optionally with a resolved
   *  caller-ID TPN — the per-call picker lands in slice 5). */
  call(e164: string, fromTpnId?: string): void;
  mute(on: boolean): void;
  hangup(): void;
  /** Answer the ringing call on the REAL device (Task C1) — calls the
   *  wrapper's device answer(), not a local state simulation. */
  answer(): void;
  /** Subscribe to a real inbound ring (Task C1). Fires with the caller info
   *  carried by the device's 'incoming' event. Returns an unsubscribe fn. */
  onIncoming(cb: (info: IncomingCallInfo) => void): () => void;
}

export function useCtmSoftphone(handlers: {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: unknown) => void;
  /**
   * Device-boot gate (Task A2 — the dialer hook's "second boot path", the
   * other half of the #813 warm-singleton fix). Only the dedicated `/phone`
   * tab may cold-boot the shared CTM device; every inline caller (the
   * main-app GlobalDialer popup, entity call buttons, anything mounted
   * inside AppLayout) must stay a null handle so it falls back to the
   * existing callback-bridge / `tel:` path unchanged. Defaults to 'inline'
   * so every pre-existing call site is safe with zero changes — the future
   * `/phone` shell (Task A3) passes 'phone-tab' explicitly.
   */
  surface?: 'phone-tab' | 'inline';
}): OfficeSoftphone | null {
  const role = useAuthStore((s) => s.user?.role);
  const canComm = useFeature('phone');
  const surface = handlers.surface ?? 'inline';
  // `!!role` = someone is signed in: a remount after a logout teardown must
  // never boot a device for nobody.
  // `!onPhone` = never on a phone (Ran, 2026-10-02): mobile browsers
  // give the vendor's browser phone no working audio, so a phone always gets
  // null here and every call from it goes out as the bridge (the phone service
  // rings the user's own cell first). This is the ONE gate: the device, the
  // vendor embed script and the microphone prompt are all reached only through
  // ensureOfficeSoftphone below. See lib/device/isPhoneDevice.ts for the rule.
  // Read ONCE per mount, not every render: a mid-session flip (devtools device
  // emulation) must never null the handle of a booted device or a live call.
  const [onPhone] = useState(isPhoneDevice);
  const enabled =
    isCtmSoftphoneEnabled() &&
    canComm &&
    !!role &&
    surface === 'phone-tab' &&
    !onPhone;
  // Whether the device may boot yet (phoneTabDevice.ts owns the trigger). Until
  // it does, the handle is live but not ready, so the console reads
  // "Connecting…" and the Call button stays blocked.
  const bootArmed = usePhoneTabBootGate(enabled);
  const boot = enabled && bootArmed;

  const spRef = useRef<CtmSoftphone | null>(null);
  // Seed synchronously from the shared singleton's latch — a late subscriber
  // (a dialer opened after the device already finished booting) sees
  // ready=true on the very first render, with no need to wait for a fresh
  // 'ready' event (the event already fired once, in the past, and won't fire
  // again for this instance).
  const [ready, setReady] = useState(() => enabled && isOfficeSoftphoneReady());
  // Seeded from the getter for the same reason `ready` is: the 'fault' event
  // fires once, in the past, and a dialer opened afterwards must still see it.
  const [fault, setFault] = useState<SoftphoneFault | null>(() =>
    enabled ? getOfficeSoftphoneFault() : null,
  );

  // Keep handlers in a ref so the mount effect doesn't re-run when they change.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!boot) return;
    // Get-or-create the ONE shared device — idempotent, officeSoftphone.ts
    // owns whether this actually creates anything.
    const sp = ensureOfficeSoftphone({ getToken: requestPhoneAccessToken });
    spRef.current = sp;
    const offStart = sp.on('start', () => handlersRef.current.onStart?.());
    const offEnd = sp.on('end', () => handlersRef.current.onEnd?.());
    const offErr = sp.on('error', (e) => handlersRef.current.onError?.(e));
    // Future transitions to ready — the "already ready" case is covered by the
    // synchronous seed above; this only fires for a device that boots WHILE
    // this hook is mounted.
    const offReady = subscribeOfficeSoftphoneReady(() => setReady(true));
    // RE-READ, don't assume: this channel also transitions back to null when a
    // slow device finally boots, so the notification alone says "changed", not
    // "faulted".
    const offFault = subscribeOfficeSoftphoneFault(() => setFault(getOfficeSoftphoneFault()));
    return () => {
      offStart();
      offEnd();
      offErr();
      offReady();
      offFault();
      // The device is a page-load-scoped singleton, not owned by this hook —
      // it survives this hook unmounting. Its owner, the /phone tab
      // (usePhoneTabDeviceTeardown), tears it down on unmount and on logout.
    };
  }, [boot]);

  if (!enabled) return null;
  return {
    ready,
    fault,
    awaitingStart: !bootArmed,
    call(e164: string, fromTpnId?: string) {
      if (fromTpnId) spRef.current?.dialFrom(fromTpnId);
      spRef.current?.call(e164);
      // A call is live from the dial on, so leaving the tab must not drop it.
      if (spRef.current) markOfficeSoftphoneCallDialled();
    },
    mute(on: boolean) {
      spRef.current?.mute(on);
    },
    hangup() {
      spRef.current?.hangup();
      // An explicit Hang up ends the call now; don't wait for the device's 'end'.
      if (spRef.current) markOfficeSoftphoneCallHungUp();
    },
    answer() {
      // Task C1: the REAL device answer (ctmSoftphone.ts's answer() calls
      // el.answer?.()) — no local state simulation lives in this hook.
      spRef.current?.answer();
    },
    onIncoming(cb: (info: IncomingCallInfo) => void) {
      const off = spRef.current?.on('incoming', (payload) =>
        cb((payload ?? {}) as IncomingCallInfo),
      );
      return () => off?.();
    },
  };
}
