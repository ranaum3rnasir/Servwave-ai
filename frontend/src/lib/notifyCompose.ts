/**
 * notifyCompose - the compose state for the ONE dialog that still offers a hand-composed
 * customer email: the board's unschedule confirm.
 *
 * Customer notifications for a booked or moved trip come only from the org's automations
 * (scheduling-notifications slice 01). The job visit dialog, the lead walkthrough form and the
 * board's reschedule confirm carry no composer and send NO notify keys, which every scheduling
 * route reads as "let the automation handle it". The routes still accept the keys, so the key
 * bags below stay: the unschedule door takes the NESTED object, and other clients may still send
 * the FLAT keys to /assign and /walkthrough/schedule.
 *
 * TWO NOTIFY VOCABULARIES SURVIVE ON THE WIRE, so this module exposes ONE key bag under TWO
 * wrappers rather than one payload builder that quietly fits neither:
 *   - `notifyKeys`      -> FLAT top-level keys, for POST /api/jobs/:id/assign and
 *                          POST /api/leads/:id/walkthrough/schedule.
 *   - `notifyVisitBody` -> the NESTED `notify` object, for every visit route on both parents.
 * Posting flat keys at the nested schema is not an error the user ever sees: Zod strips unknown
 * keys, so the request 200s, the toast says it worked, and no email is sent.
 *
 * Q1 (RATIFIED, both halves shipped - the default is ON per D23/user story 42, and the decline is
 * expressible on the wire): `notifyKeysShown` / `notifyVisitBodyShown` exist so a host that
 * ACTUALLY SHOWED the composer can make an explicit decline reach the wire as
 * `notify_customer: false`, instead of the `{}` a genuinely silent caller sends. That distinction
 * is NOT made inside the plain `notifyKeys` / `notifyVisitBody` below - see their doc - it is a
 * call the HOST makes, because only the host knows whether this particular attempt actually
 * rendered a composer for the user to decide with.
 */
/** The compose state, owned by whichever component hosts the dialog. */
export interface NotifyCompose {
  enabled: boolean;
  to: string;
  cc: string[];
  message: string;
}

/**
 * A closed composer. Also the reset value on every dialog close.
 *
 * `enabled: true` is the spec, not a preference: D23 says the opt-out is "defaulted on", and
 * user story 42 says the box "defaults to sending". The blast radius of this default is exactly
 * the hosts that render a composer - every wire effect goes through
 * `notifyKeysShown`/`notifyVisitBodyShown`, which only a host with the composer on screen may
 * call, so no dialog-less path can send because of this value.
 */
export const EMPTY_NOTIFY: NotifyCompose = { enabled: true, to: '', cc: [], message: '' };

/**
 * The compose state as request keys. Returns {} when the user did not ask for a send, so every
 * OTHER caller of these mutations (drag-resize, crew swap, plan-visit drop - none of which show
 * a dialog) stays silent BY CONSTRUCTION rather than by remembering to pass a flag.
 *
 * Empty strings are dropped rather than sent: an untouched To means "use the customer's saved
 * address", and an empty message means "use the default wording" - both of which the server
 * already does. Sending '' would instead fail email validation, or blank the email body.
 */
export function notifyKeys(n?: NotifyCompose) {
  if (!n?.enabled) return {};
  const to = n.to.trim();
  const message = n.message.trim();
  return {
    notify_customer: true as const,
    ...(to ? { notify_recipient_email: to } : {}),
    ...(n.cc.length > 0 ? { notify_cc_emails: n.cc } : {}),
    ...(message ? { notify_message: message } : {}),
  };
}

/** The same key bag, nested, for the visit routes on both parents. */
export function notifyVisitBody(n?: NotifyCompose) {
  const keys = notifyKeys(n);
  return 'notify_customer' in keys ? { notify: keys } : {};
}

/**
 * `notifyKeys`, but for a host that ACTUALLY RENDERED the composer for this specific submission.
 *
 * Q1 (RATIFIED): through plain `notifyKeys` an untick is byte-identical on the wire to a dialog
 * that never opened - `{}` either way - and the backend reads an absent `notify` as "let the
 * automation handle it", which is how a box labelled "Notify the customer" used to email the
 * customer when it was left OFF. `n` is required (not optional) here on purpose: calling this at
 * all is the host asserting "a composer was on screen for this attempt", so there is no bare
 * `undefined` case to silently do the wrong thing with. A host with no dialog must keep calling
 * plain `notifyKeys` (or send no notify key at all) - never this.
 */
export function notifyKeysShown(n: NotifyCompose) {
  if (!n.enabled) return { notify_customer: false as const };
  return notifyKeys(n);
}

/** The nested-object twin of `notifyKeysShown`, for the visit routes. */
export function notifyVisitBodyShown(n: NotifyCompose) {
  const keys = notifyKeysShown(n);
  return 'notify_customer' in keys ? { notify: keys } : {};
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Should the host block its confirm button?
 *
 * A "To" that is present but malformed blocks the send. An EMPTY one does not: the server falls
 * back to the customer's saved address, and the field is only ever prefilled with that address
 * in the first place.
 */
export function notifyBlocked(notify: NotifyCompose): boolean {
  return notify.enabled && Boolean(notify.to.trim()) && !EMAIL_RE.test(notify.to.trim());
}
