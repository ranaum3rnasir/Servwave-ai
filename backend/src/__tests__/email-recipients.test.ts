/**
 * email-recipients.test.ts
 *
 * Guard: no transactional email may be addressed to EMAIL_FROM.
 *
 * `EMAIL_FROM` is the app's no-reply sending identity, not a mailbox anyone reads.
 * The `[Internal] Payment received` alert was sent with `to: env.EMAIL_FROM` and
 * every single one came back from Resend as `last_event: "suppressed"` - the
 * provider drops mail addressed to it, so the feature silently did nothing for
 * its entire life. Worse, the send *succeeds* at the API layer, so the backend
 * logged "alert sent" each time.
 *
 * Internal notifications belong in the in-app notification system (`emit()`),
 * which resolves real recipients through the §3 routing matrix. This test is a
 * source-level guard so a future self-addressed sender fails CI instead of
 * failing silently in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const EMAIL_LIB = join(__dirname, '..', 'lib', 'email.ts');

describe('transactional email recipients', () => {
  it('never addresses an email to EMAIL_FROM', () => {
    const source = readFileSync(EMAIL_LIB, 'utf8');

    // Strip comments so the prose above/below a sender cannot trip the match.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\bto:\s*(env|process\.env)\.EMAIL_FROM\b/.test(line));

    expect(
      offenders,
      `email.ts addresses mail to EMAIL_FROM (the no-reply sender) - Resend suppresses it, ` +
        `so nobody receives it. Route internal notifications through emit() instead.\n` +
        offenders.map((o) => `  line ${o.n}: ${o.line}`).join('\n'),
    ).toEqual([]);
  });
});
