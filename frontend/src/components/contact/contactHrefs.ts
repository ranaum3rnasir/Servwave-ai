import type { DialerEntityContext } from '@/stores/dialer.store';

/**
 * The contact action's pure decisions (mobile slice 50). Everything that builds a telephone or text
 * URL, a maps link or a conversation path lives in THIS folder; a static guard
 * (`__tests__/contact-action-only-telephone-urls.guard.test.ts`) fails the build when a telephone
 * URL appears in live staff code anywhere else.
 */

/** What Call does: the ServWave dialer, or the device's own call. */
export type CallRoute = 'dialer' | 'device';

/**
 * What Call does for a phone number.
 *
 * - No phone service (or no right to place calls): the device call. There is no dialer.
 * - Otherwise the ServWave dialer, pre-filled and attributed, on every device and for every site.
 *
 * Which dialer is the DEVICE's choice and is made in `lib/communication/phoneTabHandoff.ts` (the
 * phone tab on a computer, a same-tab sheet on a phone and in the installed app; mobile slice 63),
 * never here and never by the site: the per-site "what Call does on a phone" option is gone.
 */
export function callRoute(canDial: boolean): CallRoute {
  return canDial ? 'dialer' : 'device';
}

/** The device's own call link. */
export function telHref(phone: string): string {
  return `tel:${phone.trim()}`;
}

/** The device's own text link, for an org with no ServWave conversation to open. */
export function smsHref(phone: string): string {
  return `sms:${phone.trim()}`;
}

/**
 * The ServWave conversation with a number. By customer when the record is a customer (the inbox
 * opens that customer's thread, or starts one with them preselected); by number otherwise (a
 * vendor, a team member), which opens the composer pre-filled with it.
 */
export function textPath(phone: string, context?: DialerEntityContext | null): string {
  if (context?.customerId) return `/communication/text?customerId=${encodeURIComponent(context.customerId)}`;
  return `/communication/text?to=${encodeURIComponent(phone.trim())}`;
}

/**
 * A link that opens the device's native maps app for an address.
 *
 * iPhone and iPad hand the Apple Maps link to the Maps app. Everywhere else the universal search
 * link opens the maps app on Android and the web map on a computer.
 */
export function mapsHref(address: string, opts: { ios: boolean }): string {
  const query = encodeURIComponent(address);
  return opts.ios
    ? `https://maps.apple.com/?q=${query}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/** Is this an Apple touch device (iPhone, iPad, including an iPad that reports itself as a Mac)? */
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1;
}

/**
 * Hand a link to the device (the dialer, the messages app). Its own function so a test can watch
 * it: jsdom does not navigate.
 */
export function openDeviceLink(href: string): void {
  window.location.assign(href);
}

/** The address parameters that open the Email page's compose window (read once, then stripped from the address). */
export const COMPOSE_PARAMS = ['compose', 'to', 'subject', 'body', 'customerId', 'jobId', 'invoiceId'] as const;
