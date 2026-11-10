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
 * What a customer phone's Text needs to know about the person tapping it (Roles & Permissions, PRD 5).
 * `viewCustomers` is their View customers switch: the composer finds a customer by id through the customer
 * directory, which only a person who may view customers can read.
 */
export interface CustomerTextAccess {
  viewCustomers: boolean;
  /**
   * Text on the number a job's own page shows for its customer (#3017): the composer opens addressed to that number with
   * the job attached, whoever taps it, so the server texts the job's number and files the text on the job (#3016).
   */
  anchorOnJob?: boolean;
}

/** The query value that marks the number as a customer's, so the composer draws it under the copy rule. */
export const CUSTOMER_PHONE_OWNER = 'customer';

/**
 * The ServWave conversation with a number. By customer when the record is a customer (the inbox
 * opens that customer's thread, or starts one with them preselected); by number otherwise (a
 * vendor, a team member), which opens the composer pre-filled with it.
 *
 * A CUSTOMER's phone passes `customer`. A person who may view customers goes by customer, as above. A person who
 * may not has no directory to find the customer in, so the composer is opened addressed to the number the person
 * tapped instead, carrying the name and the job the number was tapped from (and the lead, only when tapped on the
 * lead's own page, `textCarriesLead`): the text is filed on that record, and the number is drawn under the copy
 * rule (`owner`). Tapped on a job's own page for the job's number (`anchorOnJob`), it goes that way for everyone.
 */
export function textPath(phone: string, context?: DialerEntityContext | null, customer?: CustomerTextAccess): string {
  const number = phone.trim();
  if (!customer) {
    if (context?.customerId) return `/communication/text?customerId=${encodeURIComponent(context.customerId)}`;
    return `/communication/text?to=${encodeURIComponent(number)}`;
  }
  const anchoredOnJob = Boolean(customer.anchorOnJob && context?.jobId);
  if (customer.viewCustomers && context?.customerId && !anchoredOnJob) {
    // Tapped on the lead's own page (`textCarriesLead`, set there and nowhere else): the lead rides along, so the
    // first reply on that customer's conversation is filed on the lead (SPEC-4 §6.8; the inbox drops it after that
    // reply or on any change of conversation). A record that merely has a lead (an estimate, a payment's customer)
    // keeps it on Call only.
    const lead = context.textCarriesLead && context.leadId ? `&leadId=${encodeURIComponent(context.leadId)}` : '';
    return `/communication/text?customerId=${encodeURIComponent(context.customerId)}${lead}`;
  }
  return numberTextPath(number, context);
}

/**
 * The composer addressed to a customer's number as tapped, carrying the name and the record it was tapped from: the job
 * always, the lead only from the lead's own page (`textCarriesLead`, SPEC-4 §6.8). The text is sent naming that number
 * with the record, so the server checks the number is the record's or its customer's and files the text on the record
 * (#3016, #3018).
 *
 * A lead's or job's card uses it for every number but the customer's primary as it stands (#3018): the record's own
 * number, a number the record changed one of the customer's to, the customer's own number under it, and the customer's
 * other phones. Going by the customer would text the record's number for the primary instead of the number tapped.
 */
export function numberTextPath(phone: string, context?: DialerEntityContext | null): string {
  const params = new URLSearchParams({ to: phone.trim(), owner: CUSTOMER_PHONE_OWNER });
  if (context?.customerName) params.set('name', context.customerName);
  if (context?.jobId) params.set('jobId', context.jobId);
  // The lead rides along only from the lead's own page, as above (SPEC-4 §6.8); the job always does.
  if (context?.textCarriesLead && context.leadId) params.set('leadId', context.leadId);
  return `/communication/text?${params.toString()}`;
}

/** The address parameters that open the Email page's compose window (read once, then stripped from the address). */
export const COMPOSE_PARAMS = ['compose', 'to', 'subject', 'body', 'customerId', 'jobId', 'invoiceId'] as const;

export interface ComposePathInput {
  to: string;
  subject: string;
  body?: string;
  customerId: string;
  jobId?: string;
  invoiceId?: string;
}

/**
 * The Email page with its compose window open and filled in. The body can hold an invoice's public pay link, so the
 * page reads `subject` and `body` once and removes them from the address (see InboxPage).
 */
export function composePath({ to, subject, body, customerId, jobId, invoiceId }: ComposePathInput): string {
  const params = new URLSearchParams({ compose: '1', to, subject });
  if (body) params.set('body', body);
  params.set('customerId', customerId);
  if (jobId) params.set('jobId', jobId);
  if (invoiceId) params.set('invoiceId', invoiceId);
  return `/communication/inbox?${params.toString()}`;
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
