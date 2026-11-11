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

/**
 * The site's forms carry their tracking values in numbered HIDDEN fields
 * (`hidden_1`..`hidden_12`), whose names say nothing about what they hold.
 * Only the per-org field_map can say "hidden_3 is the click id" (#3448).
 */
describe('hidden tracking fields, pointed at by the field_map (#3448)', () => {
  const WITH_HIDDEN = {
    ...SUBMISSION,
    hidden_1: 'kitchen remodel',
    hidden_2: 'Cj0TESTgclid',
    hidden_3: '203.0.113.7',
    hidden_4: '4521',
    hidden_5: 'google',
  };
  const MAP = { hidden_1: 'keyword', hidden_2: 'gclid', hidden_3: 'ignore', hidden_4: 'submissionId', hidden_5: 'utm_source' };

  it('lifts a mapped hidden field into the tracking values under its target name', () => {
    const e = parseWebFormSubmission('forminator', WITH_HIDDEN, MAP)!;
    expect(e.trackingParams).toMatchObject({ keyword: 'kitchen remodel', gclid: 'Cj0TESTgclid', utm_source: 'google' });
  });

  it('takes the vendor submission id from the mapped hidden field', () => {
    expect(parseWebFormSubmission('forminator', WITH_HIDDEN, MAP)!.vendorSubmissionId).toBe('4521');
  });

  it('a field mapped to `ignore` is consumed silently: not a tracking value, not drift', () => {
    const warn = vi.spyOn(logger, 'warn');
    const e = parseWebFormSubmission('forminator', WITH_HIDDEN, MAP)!;
    expect(JSON.stringify(e.trackingParams)).not.toContain('203.0.113.7');
    expect(e.extras).not.toHaveProperty('hidden_3');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('keys the field map does not know'));
  });

  it('an explicitly mapped value wins over a same-named raw key', () => {
    const e = parseWebFormSubmission('forminator', { ...WITH_HIDDEN, gclid: 'raw-key-value' }, MAP)!;
    expect(e.trackingParams.gclid).toBe('Cj0TESTgclid');
  });

  it('an empty mapped hidden field leaves the raw key\'s value in place', () => {
    const e = parseWebFormSubmission('forminator', { ...WITH_HIDDEN, hidden_2: '', gclid: 'raw-key-value' }, MAP)!;
    expect(e.trackingParams.gclid).toBe('raw-key-value');
  });

  it('without a map the hidden fields stay unknown: kept verbatim and named in the drift alarm', () => {
    const warn = vi.spyOn(logger, 'warn');
    const e = parseWebFormSubmission('forminator', WITH_HIDDEN)!;
    expect(e.trackingParams).not.toHaveProperty('gclid');
    expect(e.extras.hidden_2).toBe('Cj0TESTgclid');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hidden_2'));
  });

  it('lifts a raw key literally named `keyword`, like the other tracking names', () => {
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, keyword: 'showroom' })!.trackingParams.keyword).toBe(
      'showroom',
    );
  });
});

describe('a form that names its phone field phone_2 (#3448)', () => {
  it('reads phone_2 as the phone when there is no phone_1', () => {
    const { phone_1: _drop, ...body } = SUBMISSION;
    const e = parseWebFormSubmission('forminator', { ...body, phone_2: '(609) 555-0188' })!;
    expect(e.phone).toBe('+16095550188');
    expect(e.extras).not.toHaveProperty('phone_2');
  });

  it('phone_1 still wins when a form carries both', () => {
    const e = parseWebFormSubmission('forminator', { ...SUBMISSION, phone_2: '(609) 555-0188' })!;
    expect(e.phone).toBe('+16095550123');
  });
});

describe('what live forms actually send (#3448)', () => {
  it('treats an unfilled placeholder as empty, mapped or not', () => {
    const e = parseWebFormSubmission(
      'forminator',
      { ...SUBMISSION, hidden_10: '__gclid__', hidden_7: '__keyword__', utm_source: '__utm_source__', utm_term: '{keyword}' },
      { hidden_10: 'gclid', hidden_7: 'keyword' },
    )!;
    // Only the real value from the landing URL (`?utm_campaign=spring`) survives.
    expect(e.trackingParams).toEqual({ utm_campaign: 'spring' });
  });

  it('fills the click id and keyword from the landing page\'s own query string', () => {
    const e = parseWebFormSubmission(
      'forminator',
      {
        ...SUBMISSION,
        hidden_2: 'https://www.example.com/contact/?gclid=Cj0TESTgclid&keyword=custom+cabinets&utm_source=google&page=2',
        hidden_10: '__gclid__',
      },
      { current_url: null, hidden_2: 'landingPageUrl', hidden_10: 'gclid' },
    )!;
    expect(e.landingPageUrl).toBe(
      'https://www.example.com/contact/?gclid=Cj0TESTgclid&keyword=custom+cabinets&utm_source=google&page=2',
    );
    expect(e.trackingParams).toEqual({ gclid: 'Cj0TESTgclid', keyword: 'custom cabinets', utm_source: 'google' });
  });

  it('never lets the landing URL override a real mapped value, and survives a landing value that is not a URL', () => {
    const e = parseWebFormSubmission(
      'forminator',
      { ...SUBMISSION, current_url: 'https://www.example.com/?gclid=from-url', hidden_10: 'from-field' },
      { hidden_10: 'gclid' },
    )!;
    expect(e.trackingParams.gclid).toBe('from-field');
    expect(parseWebFormSubmission('forminator', { ...SUBMISSION, current_url: 'not a url' })!.trackingParams).toEqual({});
  });

  it('does not count the plugin\'s own envelope keys as drift', () => {
    const warn = vi.spyOn(logger, 'warn');
    parseWebFormSubmission('forminator', { ...SUBMISSION, form_uid: '6abb60a3ed5e4', _wp_http_referer: '/contact/', _forminator_user_ip: '' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the referring page, one click before the form (#3448)', () => {
  const MAP = { hidden_2: 'referringUrl' };

  it('fills the click id and keyword from a SAME-SITE referring page', () => {
    const e = parseWebFormSubmission(
      'forminator',
      {
        ...SUBMISSION,
        // Live forms send the plugin's own referrer slot empty (all 35 stored submissions).
        referer_url: '',
        current_url: 'https://www.example.test/contact/',
        hidden_2: 'https://example.test/showroom/?gclid=Cj0TESTgclid&keyword=custom+cabinets',
      },
      MAP,
    )!;
    expect(e.referringUrl).toBe('https://example.test/showroom/?gclid=Cj0TESTgclid&keyword=custom+cabinets');
    expect(e.trackingParams).toEqual({ gclid: 'Cj0TESTgclid', keyword: 'custom cabinets' });
  });

  it('never takes tracking values from an OUTSIDE referrer: they describe someone else\'s campaign', () => {
    const e = parseWebFormSubmission(
      'forminator',
      {
        ...SUBMISSION,
        // Live forms send the plugin's own referrer slot empty (all 35 stored submissions).
        referer_url: '',
        current_url: 'https://example.test/contact/',
        hidden_2: 'https://partner.example/?utm_source=newsletter&gclid=theirs',
      },
      MAP,
    )!;
    expect(e.trackingParams).toEqual({});
  });

  it('the form\'s own page wins over the referring page', () => {
    const e = parseWebFormSubmission(
      'forminator',
      {
        ...SUBMISSION,
        // Live forms send the plugin's own referrer slot empty (all 35 stored submissions).
        referer_url: '',
        current_url: 'https://example.test/contact/?utm_source=own-page',
        hidden_2: 'https://example.test/showroom/?utm_source=previous-page',
      },
      MAP,
    )!;
    expect(e.trackingParams.utm_source).toBe('own-page');
  });
});

describe('placeholders in mapped fields (#3448, review)', () => {
  it('a placeholder submission id counts as no id at all', () => {
    expect(
      parseWebFormSubmission('forminator', { ...SUBMISSION, hidden_11: '__submission_id__' }, { hidden_11: 'submissionId' })!
        .vendorSubmissionId,
    ).toBeNull();
  });

  it('a second slug mapped to the same target still gets its turn when the first is a placeholder', () => {
    const e = parseWebFormSubmission(
      'forminator',
      { ...SUBMISSION, current_url: 'https://example.test/c/', hidden_10: '__gclid__', hidden_13: 'Cj0SECOND' },
      { hidden_10: 'gclid', hidden_13: 'gclid' },
    )!;
    expect(e.trackingParams.gclid).toBe('Cj0SECOND');
  });
});

describe('the drift alarm is one bounded, printable line', () => {
  it('strips line breaks from sender-chosen key names and the form title, and caps the key list', () => {
    const warn = vi.spyOn(logger, 'warn');
    const body: Record<string, unknown> = { ...SUBMISSION, form_title: 'Quote\n[web-form] forged line', 'evil\r\nkey': 'x' };
    for (let i = 0; i < 100; i++) body[`extra_${i}`] = 'x';
    parseWebFormSubmission('forminator', body);
    const line = String(warn.mock.calls.find((c) => String(c[0]).includes('does not know'))?.[0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('evil??key');
    expect(line).toMatch(/,\+\d+ more\)$/);
  });
});

