/**
 * why-lines.test.ts - every why line of the alert chain, word for word as the PRDs quote it.
 *
 * PRD 6 (M6 "Why line") gives the step 2 and step 3 lines with a full stop; PRD 7 and PRD 8 quote their own the same way;
 * PRD 10 quotes its three reply reasons and the main mailbox reason without one. The expected texts below are typed from
 * the PRDs, never built with the code's own builders, so a wording change has to be made on purpose.
 */

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../lib/prisma', () => ({ prisma: {} }));

import {
  ESTIMATE_WITHOUT_LEAD_OR_JOB_STEM,
  INVOICE_WITHOUT_JOB_OR_LEAD_STEM,
  NOBODY_LINKED_TO_NUMBER_REASON,
  UNMATCHED_REPLY_MESSAGE,
  dispatcherMadeChangeStem,
  dispatcherUnavailableStem,
  nobodyCanLine,
  nobodyCanOpenLine,
  nobodyWhoCanOpenRecordLine,
  noDispatcherStem,
  whyLine,
} from '../services/notifications/whyLines';

describe('the why lines of PRD 6', () => {
  it('ends the step 2 lines with a full stop', () => {
    expect(whyLine(noDispatcherStem('job'))).toBe('This job has no Dispatcher.');
    expect(whyLine(noDispatcherStem('lead'))).toBe('This lead has no Dispatcher.');
    expect(whyLine(ESTIMATE_WITHOUT_LEAD_OR_JOB_STEM)).toBe('This estimate has no lead or job.');
    expect(whyLine(INVOICE_WITHOUT_JOB_OR_LEAD_STEM)).toBe('This invoice has no job or lead.');
    expect(whyLine(dispatcherMadeChangeStem('job'))).toBe("This job's Dispatcher made this change.");
    expect(whyLine(dispatcherUnavailableStem('lead'))).toBe("This lead's Dispatcher is not available.");
  });

  it('adds step 3 as "and nobody who can review jobs can open it."', () => {
    expect(nobodyCanOpenLine(noDispatcherStem('job'), 'review jobs')).toBe(
      'This job has no Dispatcher and nobody who can review jobs can open it.',
    );
  });

  it('ends the lines of an alert with no Dispatcher step with a full stop', () => {
    expect(nobodyCanLine('approve this order')).toBe('Nobody can approve this order.');
    expect(nobodyCanLine('change company settings')).toBe('Nobody can change company settings.');
    expect(nobodyWhoCanOpenRecordLine('close jobs', 'job')).toBe('Nobody who can close jobs can open this job.');
  });
});

describe('the reason lines of the later PRDs', () => {
  it("keeps PRD 8's sentence, full stop included", () => {
    expect(NOBODY_LINKED_TO_NUMBER_REASON).toBe('Nobody is linked to this number and nobody sees every call and text.');
  });

  it('keeps PRD 10 as it quotes the reasons, without a full stop', async () => {
    const reply = await import('../services/notifications/emailReplyAlerts.js');
    expect(reply.NO_ONE_ON_JOB_REASON).toBe('This job has no Dispatcher or Sold By who can take this reply');
    expect(reply.NO_ONE_ON_LEAD_REASON).toBe('This lead has no Dispatcher or Owner who can take this reply');
    expect(reply.NOBODY_LINKED_REASON).toBe('Nobody is linked to the main mailbox');
  });
});

describe("the words of PRD 10's reply from an address we didn't send to", () => {
  it('is quoted with a hyphen and no full stop', () => {
    expect(UNMATCHED_REPLY_MESSAGE).toBe("A reply from an address we didn't send to - check and link it");
  });
});

describe('one place for the wording', () => {
  // A sender that types the stem of a line by hand would drift from the PRD the next time one of them is edited.
  const dir = path.join(__dirname, '..', 'services', 'notifications');
  const code = (file: string) =>
    readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'whyLines.ts' && f !== 'emailReplyAlerts.ts');

  it.each([
    ['has no Dispatcher'],
    ["Dispatcher made this change"],
    ["Dispatcher is not available"],
    ['has no lead or job'],
    ['has no job or lead'],
    ['and nobody can'],
    ['Nobody is linked'],
  ])('no sender hard-codes "%s"', (fragment) => {
    const offenders = files.filter((f) => code(f).includes(fragment));
    expect(offenders).toEqual([]);
  });
});
