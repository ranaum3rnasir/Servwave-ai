// Email slice 6 (inbound reply capture) - the Authentication-Results parser.
//
// This parser decides whether an inbound reply's `From` address is worth
// anything, so nearly every test below is an ADVERSARIAL one. The header is
// assembled by the receiving MTA out of values the SENDER controls (HELO,
// envelope-from, the domain inside a comment), which makes a naive
// /dmarc=(\w+)/ scan a spoofing primitive rather than a parser:
//
//  - `helo=dmarc=pass.evil.com` puts the literal text `dmarc=pass` into the
//    header from a hostile HELO string.
//  - `spf=none (... dmarc=pass ...)` puts it inside an RFC 5322 comment.
//  - A sender can PREPEND their own Authentication-Results header before the
//    message ever reaches us; only the one stamped by our own MTA counts, which
//    is what the authserv-id check is for.
//
// The safe parse is structural, not textual: strip comments, split on `;`, and
// take only the FIRST token of each segment as a method. Property values like
// `helo=` and `header.from=` are never methods however much they look like one.
//
// The real header this was written against (2026-08-05, Gmail -> Resend):
//   Authentication-Results: amazonses.com;
//    spf=none (spfCheck: 209.85.221.174 is neither permitted nor denied by
//    domain of servwave.com) client-ip=209.85.221.174;
//    envelope-from=art.nakamura@servwave.com; helo=mail-vk1-f174.google.com;
//    dkim=pass header.i=@servwave.com;
//    dmarc=pass header.from=servwave.com;
import { describe, it, expect } from 'vitest';
import { parseDmarcVerdict, INBOUND_AUTHSERV_ID } from '../lib/inbound-auth';

/** The verbatim header from the 2026-08-05 probe message, unwrapped. */
const REAL_SES_HEADER =
  'amazonses.com; ' +
  'spf=none (spfCheck: 209.85.221.174 is neither permitted nor denied by domain of servwave.com) ' +
  'client-ip=209.85.221.174; envelope-from=art.nakamura@servwave.com; helo=mail-vk1-f174.google.com; ' +
  'dkim=pass header.i=@servwave.com; ' +
  'dmarc=pass header.from=servwave.com;';

describe('INBOUND_AUTHSERV_ID', () => {
  it('is the SES authserv-id Resend inbound stamps', () => {
    // Not cosmetic: every verdict is discarded unless the authserv-id matches,
    // so this constant is the trust anchor. Confirmed against a real message.
    expect(INBOUND_AUTHSERV_ID).toBe('amazonses.com');
  });
});

describe('parseDmarcVerdict - the real header', () => {
  it('reads dmarc=pass out of the actual SES header', () => {
    expect(parseDmarcVerdict({ 'Authentication-Results': REAL_SES_HEADER })).toBe('PASS');
  });
});

describe('parseDmarcVerdict - verdict mapping', () => {
  it.each([
    ['pass', 'PASS'],
    ['fail', 'FAIL'],
    ['none', 'NO_POLICY'],
  ])('maps dmarc=%s to %s', (result, expected) => {
    expect(
      parseDmarcVerdict({ 'Authentication-Results': `amazonses.com; dmarc=${result}` }),
    ).toBe(expected);
  });

  it.each(['temperror', 'permerror'])(
    'maps dmarc=%s to UNAVAILABLE, not to a stronger state',
    (result) => {
      // A DNS failure during evaluation leaves us knowing exactly as much as a
      // missing header does. Mapping it to NO_POLICY would imply we established
      // the sender publishes no DMARC, which we did not.
      expect(
        parseDmarcVerdict({ 'Authentication-Results': `amazonses.com; dmarc=${result}` }),
      ).toBe('UNAVAILABLE');
    },
  );

  it('maps an unrecognised result to UNAVAILABLE rather than guessing', () => {
    expect(
      parseDmarcVerdict({ 'Authentication-Results': 'amazonses.com; dmarc=wat' }),
    ).toBe('UNAVAILABLE');
  });
});

describe('parseDmarcVerdict - absence', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns UNAVAILABLE for %s headers', (_label, headers) => {
    expect(parseDmarcVerdict(headers)).toBe('UNAVAILABLE');
  });

  it('returns UNAVAILABLE for an empty headers object', () => {
    expect(parseDmarcVerdict({})).toBe('UNAVAILABLE');
  });

  it('returns UNAVAILABLE when no Authentication-Results header is present', () => {
    expect(parseDmarcVerdict({ From: 'a@b.com', Subject: 'hi' })).toBe('UNAVAILABLE');
  });

  it('returns UNAVAILABLE when the header carries spf and dkim but no dmarc', () => {
    // dkim=pass alone is NOT a substitute: a valid signature from some unrelated
    // domain proves nothing about the From header's domain. Only DMARC asserts
    // alignment, which is the property this whole check exists for.
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'amazonses.com; spf=pass smtp.mailfrom=b.com; dkim=pass header.i=@other.com',
      }),
    ).toBe('UNAVAILABLE');
  });

  it('returns UNAVAILABLE for an empty header value', () => {
    expect(parseDmarcVerdict({ 'Authentication-Results': '' })).toBe('UNAVAILABLE');
  });
});

describe('parseDmarcVerdict - case handling', () => {
  it.each([
    'authentication-results',
    'AUTHENTICATION-RESULTS',
    'Authentication-Results',
  ])('finds the header under key casing %s', (key) => {
    expect(parseDmarcVerdict({ [key]: 'amazonses.com; dmarc=pass' })).toBe('PASS');
  });

  it('accepts an uppercased method and result', () => {
    // RFC 8601 keywords are case-insensitive.
    expect(parseDmarcVerdict({ 'Authentication-Results': 'AmazonSES.com; DMARC=PASS' })).toBe('PASS');
  });
});

describe('parseDmarcVerdict - authserv-id is the trust anchor', () => {
  it('ignores a verdict from an authserv-id that is not ours', () => {
    // A relay or the sender themselves can stamp their own Authentication-Results.
    // Trusting any authority but our own MTA lets a sender assert their own pass.
    expect(
      parseDmarcVerdict({ 'Authentication-Results': 'evil-relay.example; dmarc=pass' }),
    ).toBe('UNAVAILABLE');
  });

  it('ignores an authserv-id that merely ends with ours', () => {
    // `notamazonses.com` is registrable by anyone; a suffix test would trust it.
    expect(
      parseDmarcVerdict({ 'Authentication-Results': 'notamazonses.com; dmarc=pass' }),
    ).toBe('UNAVAILABLE');
  });

  it('accepts our authserv-id carrying an RFC 8601 version token', () => {
    // `authserv-id [ CFWS ] [ version ]` - SES may emit `amazonses.com 1;`.
    expect(
      parseDmarcVerdict({ 'Authentication-Results': 'amazonses.com 1; dmarc=pass' }),
    ).toBe('PASS');
  });
});

describe('parseDmarcVerdict - adversarial input', () => {
  it('does not read a verdict out of a comment', () => {
    // The comment body is MTA-generated text quoting sender-controlled values.
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'amazonses.com; spf=none (helpfully claims dmarc=pass here)',
      }),
    ).toBe('UNAVAILABLE');
  });

  it('prefers the real verdict over one planted in a comment', () => {
    expect(
      parseDmarcVerdict({
        'Authentication-Results':
          'amazonses.com; spf=none (attacker says dmarc=pass); dmarc=fail header.from=b.com',
      }),
    ).toBe('FAIL');
  });

  it('does not treat a property value as a method', () => {
    // A hostile HELO of `dmarc=pass.evil.com` puts the literal text in the header.
    expect(
      parseDmarcVerdict({
        'Authentication-Results':
          'amazonses.com; spf=none; helo=dmarc=pass.evil.com; dmarc=fail header.from=b.com',
      }),
    ).toBe('FAIL');
  });

  it('does not read a verdict from a lone property value', () => {
    expect(
      parseDmarcVerdict({ 'Authentication-Results': 'amazonses.com; helo=dmarc=pass.evil.com' }),
    ).toBe('UNAVAILABLE');
  });

  it('handles a nested comment without leaking its contents', () => {
    // RFC 5322 comments nest. A single-level strip would leave `dmarc=pass`
    // exposed after consuming only the inner parentheses.
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'amazonses.com; spf=none (outer (inner) dmarc=pass)',
      }),
    ).toBe('UNAVAILABLE');
  });

  it('is not fooled by a method name that merely ends in dmarc', () => {
    expect(
      parseDmarcVerdict({ 'Authentication-Results': 'amazonses.com; xdmarc=pass' }),
    ).toBe('UNAVAILABLE');
  });

  it('takes FAIL when two stamped verdicts disagree', () => {
    // A prepended header plus our MTA's genuine one. Disagreement resolves
    // toward distrust, never toward pass.
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'amazonses.com; dmarc=pass\namazonses.com; dmarc=fail',
      }),
    ).toBe('FAIL');
  });

  it('returns UNAVAILABLE when two verdicts disagree without a fail', () => {
    // Cannot tell which is ours, so the evidence is worthless - but it is not
    // affirmative forgery either.
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'amazonses.com; dmarc=pass\namazonses.com; dmarc=none',
      }),
    ).toBe('UNAVAILABLE');
  });

  it('accepts agreeing duplicate verdicts', () => {
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'amazonses.com; dmarc=pass\namazonses.com; dmarc=pass',
      }),
    ).toBe('PASS');
  });

  it('ignores a foreign authserv-id stamped alongside ours', () => {
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'evil-relay.example; dmarc=pass\namazonses.com; dmarc=fail',
      }),
    ).toBe('FAIL');
  });

  it('survives an unterminated comment without hanging or throwing', () => {
    expect(
      parseDmarcVerdict({ 'Authentication-Results': 'amazonses.com; spf=none (never closed' }),
    ).toBe('UNAVAILABLE');
  });

  it('tolerates folded whitespace inside the value', () => {
    // Header unfolding leaves newline + leading whitespace mid-value.
    expect(
      parseDmarcVerdict({
        'Authentication-Results': 'amazonses.com;\r\n  dkim=pass header.i=@b.com;\r\n  dmarc=pass header.from=b.com',
      }),
    ).toBe('PASS');
  });
});
