import type { DialerEntityContext } from '@/stores/dialer.store';

/**
 * Task B4 — cross-tab dial handoff. Every comms-gated "Call" affordance in
 * the main app (CustomerContactCard, JobCommunicationsTab,
 * LeadCommunicationsTab, the Customer/Lead detail pages, …) routes a dial
 * request through this module into the SINGLE `/phone` tab — the sole CTM
 * softphone device owner (Task A3) — instead of the legacy in-app
 * GlobalDialer popup.
 *
 *  - FIRST dial: navigate a window named `servwave-phone` straight to
 *    `/phone?dial=<e164>&ctx=<entity context>`. A brand-new tab reads the
 *    number + context off the URL on mount, so there's no boot race here.
 *  - Every SUBSEQUENT dial while that tab is still open must NEVER
 *    re-navigate it — that would drop a live call. Instead: broadcast the
 *    new number over `BroadcastChannel('servwave-phone')` and bring the tab
 *    forward with `window.open('', 'servwave-phone').focus()` — per the
 *    HTML spec, an EMPTY url does not navigate an already-open named
 *    browsing context, it just returns a reference to it.
 *  - `localStorage['servwave-phone-dial']` is a fallback for the boot race
 *    where the /phone tab hasn't finished mounting its BroadcastChannel
 *    listener yet when a broadcast dial lands.
 *
 * Non-comm-gated callers never import this — they keep their tel: fallback,
 * unchanged.
 */

export const PHONE_TAB_NAME = 'servwave-phone';

/** localStorage key the boot-race fallback writes/reads. Exported so the
 *  receiving `/phone` tab reads the exact same key (no string drift). */
export const DIAL_STORAGE_KEY = 'servwave-phone-dial';

export interface PhoneDialMessage {
  type: 'dial';
  phone: string;
  ctx: DialerEntityContext | null;
  ts: number;
}

/** Builds the `/phone` URL a first-open navigates to. Exported so the
 *  receiving side (the `/phone` tab reading its own boot URL) can reuse the
 *  same encoding contract. */
export function buildPhoneDialUrl(phone: string, ctx?: DialerEntityContext | null): string {
  const params = new URLSearchParams();
  params.set('dial', phone);
  if (ctx) {
    // JSON.stringify drops undefined-valued keys, so a context built from an
    // object with every field undefined serializes to "{}" — treat that the
    // same as "no context" rather than carrying an empty ctx param.
    const json = JSON.stringify(ctx);
    if (json !== '{}') params.set('ctx', json);
  }
  return `/phone?${params.toString()}`;
}

// This module's only notion of "is a /phone tab already open" is a tab THIS
// module opened — the window reference from the last `window.open` call.
// (A /phone tab opened some other way, e.g. a manually-typed URL in a fresh
// browser tab, is outside what a page-load-scoped JS module can track.)
let phoneWindowRef: Window | null = null;

function stashDialFallback(message: PhoneDialMessage): void {
  try {
    localStorage.setItem(DIAL_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Best-effort only — private browsing / storage-disabled must never
    // block placing a call.
  }
}

function broadcastDial(message: PhoneDialMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(PHONE_TAB_NAME);
  channel.postMessage(message);
  channel.close();
}

/**
 * Route a dial request into the `/phone` tab: opens it (navigated straight
 * to the number) on the first call in this page's lifetime; on every call
 * after that, reuses + focuses the same tab WITHOUT re-navigating it.
 */
export function requestCall(phone: string, ctx?: DialerEntityContext | null): void {
  const tabAlreadyOpen = phoneWindowRef !== null && !phoneWindowRef.closed;

  if (!tabAlreadyOpen) {
    phoneWindowRef = window.open(buildPhoneDialUrl(phone, ctx), PHONE_TAB_NAME);
    return;
  }

  const message: PhoneDialMessage = { type: 'dial', phone, ctx: ctx ?? null, ts: Date.now() };
  broadcastDial(message);
  stashDialFallback(message);
  window.open('', PHONE_TAB_NAME)?.focus();
}

/**
 * Open (or just focus) the `/phone` tab with NO number to dial — the header
 * dialer button's action. Shares `phoneWindowRef` with requestCall so the
 * header button and the entity Call buttons all land on the ONE device-owning
 * tab: a brand-new tab boots at bare `/phone`; an already-open tab is only
 * refocused, never re-navigated (that would drop a live call).
 */
export function openPhoneTab(): void {
  const tabAlreadyOpen = phoneWindowRef !== null && !phoneWindowRef.closed;

  if (!tabAlreadyOpen) {
    phoneWindowRef = window.open('/phone', PHONE_TAB_NAME);
    return;
  }

  window.open('', PHONE_TAB_NAME)?.focus();
}
