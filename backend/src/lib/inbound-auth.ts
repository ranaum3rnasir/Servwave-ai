import type { InboundAuthVerdict } from '@prisma/client';

/**
 * Email slice 6 (inbound reply capture) - reading the receiving MTA's DMARC
 * verdict off an inbound message.
 *
 * WHY DMARC AND NOT dkim=/spf=. Only DMARC asserts ALIGNMENT between an
 * authenticated identifier and the `From` HEADER domain, which is the single
 * property this check needs. A bare `dkim=pass` can be a perfectly valid
 * signature from an unrelated domain and says nothing about the claimed sender;
 * `spf=pass` authenticates the envelope sender, which need not match `From`
 * either. Reading those directly would look stricter and be weaker.
 *
 * WHY THIS IS PARSED STRUCTURALLY RATHER THAN WITH /dmarc=(\w+)/. The header is
 * assembled by the MTA out of values the SENDER controls, so the literal text
 * `dmarc=pass` can appear in it without any DMARC evaluation having passed:
 *
 *   - a hostile HELO of `dmarc=pass.evil.com` lands as `helo=dmarc=pass.evil.com`
 *   - the SPF comment quotes the sender's own domain and envelope-from
 *   - a sender may PREPEND an entire forged Authentication-Results header before
 *     the message ever reaches our MTA
 *
 * The structural parse defeats all three: comments are stripped before anything
 * is read, only the FIRST token of each `;`-delimited segment can be a method
 * (so `helo=` is a property, never a method), and a record whose authserv-id is
 * not ours is discarded wholesale.
 *
 * WHY HAND-ROLLED. The repo's standing rule is to reach for a vetted library at
 * parsing edges. The credible option here is `mailauth`, which pulls in a full
 * DKIM/SPF/DMARC verification stack - a large new dependency inside a security
 * path, to use one small function. Weighed against ~60 lines whose entire risk
 * surface is covered by the adversarial cases in inbound-auth.test.ts, the
 * dependency looked like the larger exposure. Revisit if the parsing needs grow
 * past this one header.
 */

/**
 * The authserv-id our own receiving MTA stamps, and the trust anchor for every
 * verdict below - a record identified by anything else is thrown away.
 *
 * Resend's inbound runs on Amazon SES (`inbound-smtp.us-east-1.amazonaws.com`),
 * confirmed against a real message on 2026-08-05. A CONSTANT rather than config:
 * if Resend ever changes it, every verdict degrades to UNAVAILABLE, which is the
 * safe direction (unverified, never falsely verified) and is visible in the UI
 * rather than silent.
 */
export const INBOUND_AUTHSERV_ID = 'amazonses.com';

/** RFC 8601 DMARC results we recognise. Anything else is not a verdict. */
const RESULT_MAP: Record<string, InboundAuthVerdict> = {
  pass: 'PASS',
  fail: 'FAIL',
  none: 'NO_POLICY',
  // temperror/permerror are deliberately absent: a DNS failure during
  // evaluation leaves us knowing exactly what a missing header would, so they
  // fall through to UNAVAILABLE rather than earning a state of their own.
};

/**
 * Removes RFC 5322 comments, which nest, and which is where MTA-generated text
 * quoting sender-controlled values lives.
 *
 * Parentheses inside a quoted-string are literal and must not open a comment.
 * An unterminated comment swallows the rest of the value, which is the correct
 * failure: the remainder is unparseable, so it yields no verdict.
 */
function stripComments(value: string): string {
  let depth = 0;
  let inQuote = false;
  let out = '';

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    if (inQuote) {
      if (ch === '\\') {
        out += ch + (value[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === '"') inQuote = false;
      out += ch;
      continue;
    }

    if (depth > 0) {
      // Quoted-pair inside a comment: `\)` is a literal, not a terminator.
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }

    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === '"') inQuote = true;
    out += ch;
  }

  return out;
}

/**
 * Splits a header value into separate Authentication-Results RECORDS.
 *
 * A bare newline starts a new record; a newline followed by whitespace is RFC
 * 5322 folding WITHIN one record and is unfolded to a space. Getting this
 * backwards would either merge a forged record into a genuine one or split a
 * genuine one in half.
 */
function splitRecords(value: string): string[] {
  return value
    .split(/\r?\n(?![ \t])/)
    .map((record) => record.replace(/\r?\n[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Pulls the dmarc result out of ONE record, or null if the record is not ours
 * or states no DMARC result.
 */
function dmarcResultOf(record: string): string | null {
  const segments = stripComments(record).split(';');

  // Segment 0 is `authserv-id [ CFWS ] [ version ]`. Compare the first token
  // EXACTLY - a suffix test would trust `notamazonses.com`, which anyone can
  // register.
  const authservId = segments[0]?.trim().split(/\s+/)[0]?.toLowerCase();
  if (authservId !== INBOUND_AUTHSERV_ID) return null;

  for (const segment of segments.slice(1)) {
    // Only the FIRST token of a segment can be a method; everything after it is
    // a property (`header.from=`, `helo=`, `client-ip=`). This is what stops a
    // hostile `helo=dmarc=pass.evil.com` from reading as a verdict.
    const token = segment.trim().split(/\s+/)[0];
    if (!token) continue;

    const eq = token.indexOf('=');
    if (eq <= 0) continue;

    if (token.slice(0, eq).toLowerCase() !== 'dmarc') continue;
    return token.slice(eq + 1).toLowerCase();
  }

  return null;
}

/**
 * The DMARC verdict on an inbound message's `From` header.
 *
 * Returns UNAVAILABLE rather than throwing on anything malformed, absent or
 * contradictory - the caller's job is to route the message, and a message must
 * never be lost because its headers were strange. UNAVAILABLE means "fall back
 * to comparing the address string, and do not call the result verified".
 */
export function parseDmarcVerdict(
  headers: Record<string, string> | null | undefined,
): InboundAuthVerdict {
  if (!headers) return 'UNAVAILABLE';

  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'authentication-results');
  if (!key) return 'UNAVAILABLE';

  const raw = headers[key];
  if (!raw) return 'UNAVAILABLE';

  const verdicts = splitRecords(raw)
    .map(dmarcResultOf)
    .filter((result): result is string => result !== null)
    .map((result) => RESULT_MAP[result] ?? 'UNAVAILABLE');

  if (verdicts.length === 0) return 'UNAVAILABLE';
  if (verdicts.every((verdict) => verdict === verdicts[0])) return verdicts[0];

  // Records disagree, so at least one was not stamped by the MTA we think it
  // was. Resolve toward distrust: an explicit fail anywhere wins, and otherwise
  // the evidence is worthless rather than affirmatively damning.
  return verdicts.includes('FAIL') ? 'FAIL' : 'UNAVAILABLE';
}
