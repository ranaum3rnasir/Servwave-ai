import { isPhoneDevice } from './isPhoneDevice';

/**
 * Does this device place calls by the bridge, in a dialer that opens in the SAME tab?
 *
 * The transport is chosen by the DEVICE, never by the user's role (Ran, 2026-10-01; mobile slice 63):
 *
 *  - A phone, and the installed app on a touch device, always call by the bridge: the ServWave phone
 *    service rings the user's own phone first and, when they answer, dials the customer. The
 *    in-browser phone is never started there, and the dialer is a full-screen sheet in the current
 *    tab, because a Home Screen app and an in-app browser drop a new window and a phone suspends a
 *    background tab.
 *  - A computer uses the in-browser phone on the dedicated phone tab, for every role.
 *
 * "A phone" is `isPhoneDevice` (a finger as the primary pointer and a small screen). "The installed
 * app" is the standalone display mode; on its own it is not a signal, because ServWave installed as
 * a desktop app still has a mouse, can open the phone tab and keeps the in-browser phone, so the
 * installed app counts only on a touch device (a full-size tablet's Home Screen app included).
 *
 * Anything it cannot read answers "no", which keeps the computer behaviour. Read once per mount by
 * callers that hold controls: a mid-session flip (devtools emulation) must not swap a live control.
 */
export function usesBridgeTransport(): boolean {
  if (isPhoneDevice()) return true;
  return isInstalledApp() && hasTouchAsPrimaryPointer();
}

function hasTouchAsPrimaryPointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Running from the Home Screen or as an installed app (not in a browser tab). */
function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  // Safari on iPhone and iPad reports the Home Screen app through its own flag.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}
