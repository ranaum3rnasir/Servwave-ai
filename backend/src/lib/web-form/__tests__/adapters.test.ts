import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseWebFormSubmission, isWebFormProvider } from '../adapters';
import { logger } from '../../logger';

/**
 * A submission as the plugin actually sends it (verified against the plugin
 * distribution v1.57.3, plan §2a): flat JSON, no wrapper, field slugs with the
 * dashes rewritten to UNDERSCORES, plus the `form_title` / `entry_time` pair the
 * plugin appends to every delivery.
 */
const SUBMISSION = {
  name_1: 'Dana',
  name_2: 'Okafor',
  phone_1: '(609) 555-0123',
  email_1: 'Dana.Okafor@Example.test',
  textarea_1: 'Looking for a quote on a new front door.',
  text_1: 'Afternoons',
  select_1: 'Replacement',
  current_url: 'https://example.test/contact?utm_campaign=spring',
  referer_url: 'https://www.google.com/',
  form_title: 'Request a Quote',
  entry_time: '2026-09-18 09:41:07',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('web-form adapters', () => {
  it('knows exactly the one provider', () => {
    expect(isWebFormProvider('forminator')).toBe(true);
    expect(isWebFormProvider('typeform')).toBe(false);
    expect(isWebFormProvider('')).toBe(false);
  });

  it('rejects a body that is not a JSON object', () => {
    expect(parseWebFormSubmission('forminator', null)).toBeNull();
    expect(parseWebFormSubmission('forminator', 'string')).toBeNull();
    expect(parseWebFormSubmission('forminator', [])).toBeNull();
    expect(parseWebFormSubmission('forminator', 42)).toBeNull();
  });

  it('maps the underscore slugs onto the normalised shape', () => {
    const e = parseWebFormSubmission('forminator', SUBMISSION)!;
    expect(e.provider).toBe('forminator');
    expect(e.formTitle).toBe('Request a Quote');
    expect(e.firstName).toBe('Dana');
    expect(e.lastName).toBe('Okafor');
    expect(e.phone).toBe('+16095550123');
    expect(e.email).toBe('dana.okafor@example.test');
    expect(e.message).toBe('Looking for a quote on a new front door.');
    expect(e.selection).toBe('Replacement');
    expect(e.landingPageUrl).toBe('https://example.test/contact?utm_campaign=spring');
    expect(e.referringUrl).toBe('https://www.google.com/');
    expect(e.vendorSubmissionId).toBeNull();
  });

  it('maps NOTHING from the dashed slugs the form builder shows', () => {
    // The builder labels them `name-1` / `phone-1`; the webhook rewrites the
    // dashes to underscores before sending. Keying the map on dashes would map
    // nothing at all, and would do it silently on every live submission.
    const e = parseWebFormSubmission('forminator', {
      'name-1': 'Dana',
      'phone-1': '(609) 555-0123',
      'email-1': 'dana@example.test',
      form_title: 'Request a Quote',
    })!;
    expect(e.firstName).toBeNull();
    expect(e.phone).toBeNull();
    expect(e.email).toBeNull();
    expect(e.extras).toMatchObject({ 'name-1': 'Dana', 'phone-1': '(609) 555-0123' });
  });

  it('uses text_1 for the message only when textarea_1 is absent or empty', () => {
    const both = parseWebFormSubmission('forminator', SUBMISSION)!;
    expect(both.message).toBe('Looking for a quote on a new front door.');

    const absent = parseWebFormSubmission('forminator', { text_1: 'Afternoons', form_title: 'F' })!;
    expect(absent.message).toBe('Afternoons');

    const empty = parseWebFormSubmission('forminator', { textarea_1: '   ', text_1: 'Afternoons', form_title: 'F' })!;
    expect(empty.message).toBe('Afternoons');
  });

  it('keeps every unmapped key verbatim in extras and warns, which is the drift alarm', () => {
    const e = parseWebFormSubmission('forminator', { ...SUBMISSION, radio_1: 'Homeowner', number_1: 4 })!;
    expect(e.extras).toMatchObject({ radio_1: 'Homeowner', number_1: '4' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keys the field map does not know'));
    const line = (logger.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(line).toContain('radio_1');
    expect(line).toContain('number_1');
    // Keys only. A warning that quoted the values would put a submitted name
    // or phone number in the logs on every drift.
    expect(line).not.toContain('Homeowner');
  });

  it('keeps a payload key that collides with an Object.prototype member, in extras AND in the drift alarm', () => {
    // The unmapped-key test was `if (map[key]) continue` - a truthiness read of
    // a plain object, so it resolves through Object.prototype. Five keys an
    // attacker picks were therefore dropped from `extras` and never reached the
    // drift warning: a five-key blind spot in both "never lose a value" and the
    // only alarm that tells us the agency changed the form.
    //
    // Parsed from text, not written as a literal: `__proto__` is an own key on a
    // JSON.parse result and a prototype assignment in an object literal, and the
    // wire is what this has to be faithful to.
    const body = JSON.parse(
      '{"form_title":"F","phone_1":"6095550123","constructor":"a","toString":"b","valueOf":"c","hasOwnProperty":"d","__proto__":"e"}',
    );
    const e = parseWebFormSubmission('forminator', body)!;

    const line = (logger.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    for (const [key, value] of [
      ['constructor', 'a'],
      ['toString', 'b'],
      ['valueOf', 'c'],
      ['hasOwnProperty', 'd'],
      ['__proto__', 'e'],
    ]) {
      expect([key, Object.prototype.hasOwnProperty.call(e.extras, key)]).toEqual([key, true]);
      expect([key, e.extras[key]]).toEqual([key, value]);
      expect(line).toContain(key);
    }
  });

  it('does not warn about the envelope keys the plugin appends to every delivery', () => {
    // form_title / entry_time / page_id / form_type / render_id ride along on
    // every submission. Warning about them would fire the alarm 100% of the
    // time and make it worthless.
    const e = parseWebFormSubmission('forminator', {
      ...SUBMISSION,
      page_id: '12',
      form_type: 'default',
      render_id: 'abc',
    })!;
    expect(logger.warn).not.toHaveBeenCalled();
    expect(e.extras).toMatchObject({ entry_time: '2026-09-18 09:41:07', page_id: '12' });
  });

  it('never uses entry_time as the authoritative timestamp, read in ANY zone', () => {
    // `entry_time` is `Y-m-d H:i:s` in the SITE's local zone with no offset, so
    // ANY reading of it - as UTC, as the server's own local time, or with an
    // invented offset - silently shifts every lead.
    //
    // TWO THINGS THE PREVIOUS VERSION OF THIS TEST COULD NOT DO. It had only a
    // lower bound, so it caught a UTC parse and missed a plain local one:
    // `new Date('2026-09-18 09:41:07')` read in PDT lands AFTER Date.now() and
    // sailed straight through. And its fixture was an absolute date, so what it
    // caught at all drifted with the wall clock.
    //
    // So: the fixture is generated exactly one day in the past, and the
    // assertion is a millisecond-wide window around this very call. No reading
    // of a day-old timestamp, in any zone on earth, lands inside it.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const entryTime =
      `${dayAgo.getFullYear()}-${pad(dayAgo.getMonth() + 1)}-${pad(dayAgo.getDate())} ` +
      `${pad(dayAgo.getHours())}:${pad(dayAgo.getMinutes())}:${pad(dayAgo.getSeconds())}`;

    const before = Date.now();
    const e = parseWebFormSubmission('forminator', { ...SUBMISSION, entry_time: entryTime })!;
    const after = Date.now();

    expect(e.submittedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(e.submittedAt.getTime()).toBeLessThanOrEqual(after);
    // And it survives verbatim, which is what reconciliation needs it for.
    expect(e.extras.entry_time).toBe(entryTime);
  });

  it('takes the vendor entry id from whichever hidden-field key carries it', () => {
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, entry_id: '4471023' })!.vendorSubmissionId).toBe('4471023');
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, submission_id: 91 })!.vendorSubmissionId).toBe('91');
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, entry: 'E-7' })!.vendorSubmissionId).toBe('E-7');
  });

  it('lifts recognised ad-tracking values into trackingParams while leaving them in extras', () => {
    const e = parseWebFormSubmission('forminator', { ...SUBMISSION, utm_campaign: 'spring', gclid: 'Cj0abc' })!;
    expect(e.trackingParams).toEqual({ utm_campaign: 'spring', gclid: 'Cj0abc' });
    expect(e.extras).toMatchObject({ utm_campaign: 'spring', gclid: 'Cj0abc' });
  });

  it('drops a phone that does not normalise rather than keeping a number nobody can dial', () => {
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, phone_1: '12' })!.phone).toBeNull();
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, phone_1: '16095550123' })!.phone).toBe('+16095550123');
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, email_1: 'not an email' })!.email).toBeNull();
  });

  it('flattens a multi-select group, the one array shape the plugin actually sends', () => {
    const e = parseWebFormSubmission('forminator', { ...SUBMISSION, select_1: ['Repair', 'Replacement'] })!;
    expect(e.selection).toBe('Repair, Replacement');
  });

  it('gives up on an array nested past a small depth rather than recursing until the stack is gone', () => {
    // A ~10KB body can nest an array 5000 deep - far under any body-size limit -
    // and an unbounded recursion here throws RangeError inside the parse the
    // receiver runs BEFORE it has answered. Express 4 does not adopt a rejected
    // promise from an async handler, so the plugin got NO RESPONSE AT ALL and
    // the submission was destroyed rather than deferred.
    let deep: unknown = '6095550123';
    for (let i = 0; i < 5000; i++) deep = [deep];

    const e = parseWebFormSubmission('forminator', { form_title: 'F', phone_1: deep });
    expect(e).not.toBeNull();
    // Refused, not flattened: the raw value still reaches the stored payload.
    expect(e!.phone).toBeNull();
  });

  it('caps the form title, which every log line on this path quotes', () => {
    // formTitle is not just stored - the receiver and the processor both put it
    // in their log lines, and those lines are the only alarm this endpoint has.
    // A 95KB title from a public form floods them.
    const e = parseWebFormSubmission('forminator', { ...SUBMISSION, form_title: 'F'.repeat(95_000) })!;
    expect(e.formTitle).toHaveLength(200);
  });

  it('treats every field as optional: a thin payload still parses', () => {
    const e = parseWebFormSubmission('forminator', {})!;
    expect(e).not.toBeNull();
    expect(e.formTitle).toBeNull();
    expect(e.firstName).toBeNull();
    expect(e.phone).toBeNull();
    expect(e.email).toBeNull();
    expect(e.extras).toEqual({});
  });
});

describe('the per-org field_map override', () => {
  it('overrides a default key, leaving the rest of the map intact', () => {
    // `select_1` and `text_1` are POSITIONAL: the agency reordering the form
    // changes what they mean without changing their name. That is an UPDATE to
    // this column, not a deploy.
    const e = parseWebFormSubmission('forminator', SUBMISSION, { text_1: 'selection', select_1: null })!;
    expect(e.selection).toBe('Afternoons');
    expect(e.extras.select_1).toBe('Replacement');
    // Everything the override did not name is untouched.
    expect(e.message).toBe('Looking for a quote on a new front door.');
    expect(e.firstName).toBe('Dana');
    expect(e.phone).toBe('+16095550123');
  });

  it('breaks an override collision by map order, not by the order the plugin serialised the body', () => {
    // Two slugs onto one key is only reachable through an override. The first
    // slug in the resolved map with a non-empty value wins, so the outcome is
    // decided by something an operator can read.
    const e = parseWebFormSubmission('forminator', SUBMISSION, { select_1: 'message', textarea_1: null })!;
    expect(e.message).toBe('Replacement');
    expect(e.extras.textarea_1).toBe('Looking for a quote on a new front door.');
  });

  it('maps a slug the default map has never heard of', () => {
    const e = parseWebFormSubmission('forminator', { text_2: '609-555-0123', form_title: 'F' }, { text_2: 'phone' })!;
    expect(e.phone).toBe('+16095550123');
    expect(e.extras).not.toHaveProperty('text_2');
  });

  it('retires a default mapping when the override is null, sending the slug to extras', () => {
    const e = parseWebFormSubmission('forminator', SUBMISSION, { select_1: null })!;
    expect(e.selection).toBeNull();
    expect(e.extras.select_1).toBe('Replacement');
  });

  it('ignores garbage rather than letting operator-entered JSON break the intake', () => {
    for (const garbage of [null, 'nonsense', 42, [], { name_1: 42 }, { name_1: 'notAKey' }]) {
      const e = parseWebFormSubmission('forminator', SUBMISSION, garbage)!;
      expect(e).not.toBeNull();
      // The default map still applies underneath the ignored entry.
      expect(e.firstName).toBe('Dana');
      expect(e.phone).toBe('+16095550123');
    }
  });
});
