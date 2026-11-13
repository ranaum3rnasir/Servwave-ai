/* =============================================================================
   #2989: the send step's access check (emit's row-scope filter) is skipped only where the caller has checked access itself.

   `emit()` asks, for every alert about a record, whether each person can open that record (filterRecipientsByAccess). A caller
   can tell it not to ask: `readersChecked` (the people were already put through this alert's own access check) or `personal`
   (the alert is about the people it names, who may have just lost access). A person row can also be written without emit at
   all. Each of these is allowed only where it is listed below, with its reason, and only as many times as listed:
     - a new caller that skips the check, or a second skip in a listed file, fails here until someone decides it on purpose;
     - Spider's per-lead alert is the one #2989 added: its people come from Spider's batched rule, which applied the same row
       check to every lead of the run a moment before (services/spider/recipients.ts).
   The fallback token of a call or text alert (`fallbackPeople`) has its own guard (notification-fallback-people-guard.test.ts).
   Every other emit caller keeps the check; the list of them is in the second test, so a caller added later is seen.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

type Skip = 'readersChecked' | 'personal' | 'directRecipientWrite';

/** Where the check may be skipped, how many times, and why. */
const MAY_SKIP: Record<string, Partial<Record<Skip, number>> & { why: string }> = {
  'services/notifications/notificationService.ts': {
    readersChecked: 2, personal: 2, directRecipientWrite: 2,
    why: 'defines the two options on EmitArgs, reads them where the filter is decided (one helper, for emit and emitMany), and writes the recipient rows emit and emitMany (#2990) themselves filtered',
  },
  'services/notifications/emailReplyAlerts.ts': {
    readersChecked: 1,
    why: "a customer's email reply: its people were found among those who may read the conversation (the single read)",
  },
  'services/spider/sweep.ts': {
    readersChecked: 1, directRecipientWrite: 1,
    why: "Spider's per-lead alert and its red-frame-only record: the people come from Spider's rule, which kept only those who can open the lead (recipients.ts, #2989)",
  },
  'services/spider/summary.ts': {
    personal: 1,
    why: "a person's starting summary is about them alone: its leads are the ones Spider's rule, with its row check, named them for",
  },
  'controllers/lead.controller.ts': {
    personal: 1,
    why: '"Reassigned away": the person who just lost the lead may no longer open it, and they are the one person it is for',
  },
  'services/notifications/jobSchedulingAlerts.ts': {
    personal: 1,
    why: '"Unassigned from you": the person taken off the job may no longer open it, and they are the one person it is for',
  },
};

const PATTERNS: Record<Skip, RegExp> = {
  readersChecked: /\breadersChecked\b/g,
  // As a key (`personal: true`, `personal?: boolean`) or read off the arguments (`args.personal`).
  personal: /\bpersonal\s*\??\s*:|\.personal\b/g,
  // `createManyAndReturn` too (#3472: emitMany reads its rows back from the insert).
  directRecipientWrite: /\bnotificationRecipient\.create(Many)?(AndReturn)?\b/g,
};

const sourceFilesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFilesUnder(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });

/** Code only: comments and quoted words are not a skip. */
const codeOf = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");

/** Per file under src, how many times its code skips the check, by kind. Files that never skip are left out. */
export function skipsIn(files: Array<{ path: string; text: string }>): Record<string, Partial<Record<Skip, number>>> {
  const out: Record<string, Partial<Record<Skip, number>>> = {};
  for (const f of files) {
    const code = codeOf(f.text);
    for (const kind of Object.keys(PATTERNS) as Skip[]) {
      const n = code.match(PATTERNS[kind])?.length ?? 0;
      if (n > 0) (out[f.path] ??= {})[kind] = n;
    }
  }
  return out;
}

const allFiles = () => sourceFilesUnder(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));
const expected = () =>
  Object.fromEntries(Object.entries(MAY_SKIP).map(([path, { why: _why, ...counts }]) => [path, counts]));

describe("emit's access check is skipped only where the caller checked access itself (#2989)", () => {
  it('the scan can fail: it finds each kind of skip, and ignores comments and words in quotes', () => {
    expect(skipsIn([{ path: 'a.ts', text: 'await emit({ verb, object, entity, readersChecked: true });' }])).toEqual({ 'a.ts': { readersChecked: 1 } });
    expect(skipsIn([{ path: 'b.ts', text: 'await emit({ verb, personal: true });\nif (args.personal) go();' }])).toEqual({ 'b.ts': { personal: 2 } });
    expect(skipsIn([{ path: 'c.ts', text: 'await prisma.notificationRecipient.createMany({ data });' }])).toEqual({ 'c.ts': { directRecipientWrite: 1 } });
    expect(skipsIn([{ path: 'c2.ts', text: 'await prisma.notificationRecipient.createManyAndReturn({ data });' }])).toEqual({ 'c2.ts': { directRecipientWrite: 1 } });
    expect(skipsIn([{ path: 'd.ts', text: "// readersChecked: true\n/* personal: true */\nconst s = 'erase personal: data';" }])).toEqual({});
  });

  it('is skipped by no source file but the listed ones, and no more often than listed', () => {
    const files = allFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(skipsIn(files)).toEqual(expected());
  });

  it("every other emit caller keeps the check (the callers as they are, so a new one is looked at)", () => {
    const callers = allFiles()
      // emit, or emitMany (#2990: many alerts in one step, the same filter decision per alert).
      .filter((f) => /\bemit(Many)?\s*\(/.test(codeOf(f.text)) && /from '[^']*\/notificationService(\.js)?'/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual([
      'controllers/auth.controller.ts',
      'controllers/lead.controller.ts',
      'controllers/logistic-order.controller.ts',
      'controllers/password-reset.controller.ts',
      'controllers/user.controller.ts',
      'controllers/workflow.controller.ts',
      'lib/calendar-entries/notify.ts',
      'lib/ctm/ingest.ts',
      'lib/tasks/notify.ts',
      'lib/users/openRecords.ts',
      'services/notifications/addressNeededAlert.ts',
      'services/notifications/emailReplyAlerts.ts',
      'services/notifications/invoiceBillingAlerts.ts',
      'services/notifications/jobCompletedAlert.ts',
      'services/notifications/jobLifecycleAlerts.ts',
      'services/notifications/jobReviewAlerts.ts',
      'services/notifications/jobSchedulingAlerts.ts',
      'services/notifications/leadEstimateAlerts.ts',
      'services/notifications/logisticOrderAlerts.ts',
      'services/notifications/noRecordAlerts.ts',
      'services/notifications/visitFinishAlert.ts',
      'services/spider/summary.ts',
      'services/spider/sweep.ts',
    ]);
    // Of these, only the files listed above may skip it; for everyone else the scan found no skip at all.
    const skipping = new Set(Object.keys(skipsIn(allFiles())));
    for (const caller of callers) if (!MAY_SKIP[caller]) expect(skipping.has(caller), caller).toBe(false);
  });
});
