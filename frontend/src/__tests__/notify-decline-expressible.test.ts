/**
 * Q1 (RATIFIED, decline-expressible half) - `notifyKeysShown` / `notifyVisitBodyShown`.
 *
 * Before this fix, `notifyKeys(n)` returned `{}` both when no composer ever existed
 * (`n === undefined`) AND when a composer was shown and left off (`n.enabled === false`) -
 * an untick was byte-identical on the wire to a dialog that never opened. The backend reads an
 * absent `notify` as "let the automation handle it", which is exactly how a box labelled
 * "Notify the customer" ends up emailing the customer when it is left OFF.
 *
 * These pin the fix at the one place it is testable without a host: the shape the wire actually
 * carries for each of the three states the contract names -
 *   - composer shown, box off  -> explicit `notify_customer: false`
 *   - composer shown, box on   -> `notify_customer: true` + whatever recipient/message/cc keys
 *   - no composer ever shown   -> untouched, byte-identical to today (plain notifyKeys/
 *                                 notifyVisitBody, called with `undefined`)
 *
 * `notifyKeysShown` / `notifyVisitBodyShown` take a REQUIRED `NotifyCompose`, not an optional
 * one - calling them at all is the host asserting "a composer was on screen for this attempt".
 * The one real host left (SchedulePage's unschedule-confirm dialog) wires through exactly this
 * contract. The reschedule confirm and the job visit dialog no longer carry a composer at all:
 * customer notifications for a booked or moved trip come only from the org's automations
 * (scheduling-notifications slice 01), so those doors send no notify key, ever.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_NOTIFY,
  notifyKeys,
  notifyKeysShown,
  notifyVisitBody,
  notifyVisitBodyShown,
  type NotifyCompose,
} from '@/lib/notifyCompose';

const OFF: NotifyCompose = { ...EMPTY_NOTIFY, enabled: false };
const ON: NotifyCompose = { enabled: true, to: 'customer@example.com', cc: [], message: 'See you then.' };

describe('notifyKeysShown - the flat vocabulary (assign, walkthrough/schedule)', () => {
  it('composer shown, box off -> explicit notify_customer: false', () => {
    expect(notifyKeysShown(OFF)).toEqual({ notify_customer: false });
  });

  it('composer shown, box on -> notify_customer: true plus the recipient/message keys', () => {
    expect(notifyKeysShown(ON)).toEqual({
      notify_customer: true,
      notify_recipient_email: 'customer@example.com',
      notify_message: 'See you then.',
    });
  });

  it('is a strictly wider set of states than plain notifyKeys: "on" answers identically', () => {
    // Nothing about the tick-on path changes - only the off path gains a body.
    expect(notifyKeysShown(ON)).toEqual(notifyKeys(ON));
  });
});

describe('notifyVisitBodyShown - the nested vocabulary (every visit route)', () => {
  it('composer shown, box off -> { notify: { notify_customer: false } }', () => {
    expect(notifyVisitBodyShown(OFF)).toEqual({ notify: { notify_customer: false } });
  });

  it('composer shown, box on -> nests the same keys notifyVisitBody would send today', () => {
    expect(notifyVisitBodyShown(ON)).toEqual(notifyVisitBody(ON));
    expect(notifyVisitBodyShown(ON)).toEqual({
      notify: {
        notify_customer: true,
        notify_recipient_email: 'customer@example.com',
        notify_message: 'See you then.',
      },
    });
  });
});

describe('the silent path is untouched - a host that never shows a composer must still send nothing', () => {
  // This is the exact scenario a host encodes as `payload.notify ? notifyKeysShown(payload.notify) : {}`
  // (or the nested twin): when no composer exists, `payload.notify` is `undefined`, so the ternary's
  // false branch runs and the Shown functions are never even called - drag-resize, crew swap and
  // the plan-visit drop all still contribute nothing to the request body.
  it('plain notifyKeys(undefined) is still {} - unchanged from before this fix', () => {
    expect(notifyKeys(undefined)).toEqual({});
  });

  it('plain notifyVisitBody(undefined) is still {} - unchanged from before this fix', () => {
    expect(notifyVisitBody(undefined)).toEqual({});
  });

  it('the host-level ternary a silent caller uses sends no notify key at all', () => {
    const payload: { notify?: NotifyCompose } = {}; // no `notify` property - exactly what a silent caller constructs
    const body = { scheduled_start: '2026-08-27T13:00:00Z', ...(payload.notify ? notifyVisitBodyShown(payload.notify) : {}) };
    expect(body).not.toHaveProperty('notify');
    expect('notify_customer' in body).toBe(false);
  });
});

describe('EMPTY_NOTIFY - the D23 default', () => {
  // Q1's second ratified half, shipped by the release owner: D23 says the opt-out is
  // "defaulted on" and user story 42 says the box "defaults to sending". The decline stays
  // expressible (the describes above), so an untick still reaches the wire as an explicit false.
  it('defaults to enabled: true', () => {
    expect(EMPTY_NOTIFY.enabled).toBe(true);
  });
});
