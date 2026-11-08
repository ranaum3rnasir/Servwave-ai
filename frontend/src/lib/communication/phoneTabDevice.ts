import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import {
  getOfficeSoftphoneGeneration,
  isOfficeSoftphoneCallActive,
  subscribeOfficeSoftphoneCall,
  subscribeOfficeSoftphoneGeneration,
  teardownOfficeSoftphone,
} from './officeSoftphone';

/**
 * The /phone tab's ownership of the phone device: WHEN it boots, and WHEN it
 * is destroyed.
 *
 * The /phone tab (PhoneTabPage) is the only place in the app that runs the
 * device. The vendor allows ONE device per browser - its device takes an
 * exclusive navigator lock ("ctm.phone.device") and a loser never boots - so a
 * second device anywhere else (the old main-window warm-up) would take the lock
 * and leave this tab saying "Phone active in another tab" while its calls rode
 * on a window the user could close at any moment.
 *
 * ── The boot trigger ────────────────────────────────────────────────────────
 * Default 'mount': the device boots as soon as the page mounts. A Call from a
 * customer or job opens this tab with the number filled in, and the user's one
 * press of Call should place the call, not merely start the device.
 *
 * Why that is believed safe: a 2026-07-16 live finding, recorded on the old
 * main-window warm-up, said the device never reaches `ctm:ready` without user
 * activation in its own window (warming on page load sat on "Connecting…" for
 * ever with the mic granted). The 2026-08-26 vault note (Learnings/A-Vendor-
 * Gate-Inside-A-Hidden-Iframe-Hangs-The-Boot) traced that same symptom to the
 * vendor's 8-hourly station check, which ctmSoftphone.ts now opts out of and
 * rescues. The outbound call itself is placed by a click, and in-browser
 * inbound ringing is off (BROWSER_INBOUND_ANSWER_ENABLED), so no audio has to
 * start without a gesture. The staging verifier confirms Ready with no gesture
 * in real Chrome.
 *
 * If that ever proves wrong, flip PHONE_TAB_BOOT_TRIGGER to 'first-gesture':
 * the device then boots inside the user's first pointerdown / keydown /
 * touchstart in THIS tab (or at once if the tab already has sticky
 * activation), and until then the console says "Click anywhere to start the
 * phone" rather than "Connecting…". A tab opened by window.open() does not
 * inherit the opening click's activation.
 *
 * ── Teardown ────────────────────────────────────────────────────────────────
 * The device is a page-load singleton (officeSoftphone.ts) that outlives any
 * one consumer, so somebody has to own its destruction. That is this tab, via
 * usePhoneTabDeviceTeardown(): on unmount, and on logout. A logout in ANOTHER
 * tab reaches this one as Supabase's SIGNED_OUT event (shared storage), which
 * lib/auth-listener.ts turns into isAuthenticated=false in the auth store - the
 * same change a logout in this tab makes - so watching that one flag covers
 * both. ProtectedRoute also unmounts the page on that flag, which runs the
 * unmount teardown; watching the flag directly keeps teardown independent of
 * the route tree above the page.
 */
export type PhoneTabBootTrigger = 'first-gesture' | 'mount';

/** The switch. See the note above before changing it. */
export const PHONE_TAB_BOOT_TRIGGER: PhoneTabBootTrigger = 'mount';

// Capture phase on the document, so a descendant's stopPropagation() cannot
// hide the user's first interaction from us.
const BOOT_GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

/** True when this window has already had a user gesture (sticky activation). */
function windowHasUserActivation(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } })
    .userActivation;
  return ua?.hasBeenActive === true;
}

/**
 * Whether the device may boot yet. With trigger 'mount' that is always; with
 * 'first-gesture' it turns true on the first gesture in this window (or at
 * once if the window already has sticky activation) and stays true. Listens
 * only while `enabled` and not yet armed.
 */
export function usePhoneTabBootGate(
  enabled: boolean,
  trigger: PhoneTabBootTrigger = PHONE_TAB_BOOT_TRIGGER,
): boolean {
  const [armed, setArmed] = useState(() => trigger === 'mount' || windowHasUserActivation());

  useEffect(() => {
    if (!enabled || armed) return;
    const arm = () => setArmed(true);
    BOOT_GESTURE_EVENTS.forEach((type) => document.addEventListener(type, arm, true));
    return () => {
      BOOT_GESTURE_EVENTS.forEach((type) => document.removeEventListener(type, arm, true));
    };
  }, [enabled, armed]);

  return armed;
}

/** Who the device belongs to: the user and their org, or null when signed out. */
export function usePhoneDeviceIdentity(): string | null {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const orgId = useAuthStore((s) => s.user?.organization_id ?? null);
  return userId ? `${userId}:${orgId ?? ''}` : null;
}

/**
 * Destroys the phone device when the owning page unmounts, when the session
 * ends while it is still mounted, and when a different user or org signs in
 * over this session without a logout (another tab can do that, and
 * isAuthenticated then never flips, so the device and its token would still be
 * the previous account's). Call it once, from PhoneTabPage, and key the
 * device-owning subtree on useOfficeSoftphoneGeneration() so it remounts and
 * boots a fresh device for the new account.
 */
export function usePhoneTabDeviceTeardown(): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const identity = usePhoneDeviceIdentity();
  const previousIdentity = useRef(identity);

  useEffect(() => {
    if (!isAuthenticated) teardownOfficeSoftphone();
  }, [isAuthenticated]);

  useEffect(() => {
    const previous = previousIdentity.current;
    previousIdentity.current = identity;
    if (previous !== null && identity !== null && identity !== previous) teardownOfficeSoftphone();
  }, [identity]);

  // Empty dependency list: the cleanup runs exactly once, on real unmount.
  useEffect(() => () => teardownOfficeSoftphone(), []);
}

/**
 * The device generation (officeSoftphone.ts): changes on every teardown. Key
 * the device-owning subtree on it so that, after a teardown it outlives (an
 * account switch), it remounts with fresh state and boots a fresh device
 * rather than holding the destroyed one's "Ready".
 */
export function useOfficeSoftphoneGeneration(): number {
  return useSyncExternalStore(subscribeOfficeSoftphoneGeneration, getOfficeSoftphoneGeneration);
}

/** True while a call is live on this tab's device. */
export function useOfficeSoftphoneCallActive(): boolean {
  return useSyncExternalStore(subscribeOfficeSoftphoneCall, isOfficeSoftphoneCallActive);
}

/**
 * While a call is live, asks the browser to confirm before this tab is closed,
 * reloaded or browsed away: any of those destroys the page that owns the device
 * and drops the call. Call it once, from PhoneTabPage.
 *
 * The listener exists only while a call is live; it is removed when the call
 * ends, on logout (whose teardown ends the call) and on unmount. Logging out
 * is meant to end the call, so it must never be held up by this prompt -
 * including a logout that navigates the page before React has re-rendered.
 * The handler therefore re-checks both conditions at the moment it fires, not
 * just when it was attached.
 */
export function useWarnBeforeUnloadDuringCall(): void {
  const callActive = useOfficeSoftphoneCallActive();

  useEffect(() => {
    // Logout needs no condition here: its teardown ends the call, which
    // removes the listener; the handler's own check covers the moment before.
    if (!callActive) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isOfficeSoftphoneCallActive() || !useAuthStore.getState().isAuthenticated) return;
      e.preventDefault();
      // Older Chrome only shows the prompt when returnValue is set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [callActive]);
}

/**
 * Brings the main app forward WITHOUT leaving this tab, for "Back to ServWave"
 * during a live call: navigating this tab would unmount the page, destroy the
 * device and drop the call. Focuses the app tab that opened this one when it is
 * still open and on our own origin, else opens the app in a new tab. (Browsers may decline to raise
 * another tab from script; the opener is still the right target, and nothing
 * here can end the call either way.)
 */
export function bringMainAppForward(): void {
  const opener = window.opener as Window | null;
  if (opener && !opener.closed && isSameOrigin(opener)) {
    opener.focus();
    return;
  }
  window.open('/', '_blank');
}

/** Only our own app may be raised: reading another origin's location throws. */
function isSameOrigin(other: Window): boolean {
  try {
    return other.location.origin === window.location.origin;
  } catch {
    return false;
  }
}
