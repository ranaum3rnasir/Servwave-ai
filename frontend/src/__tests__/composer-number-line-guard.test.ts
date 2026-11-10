/**
 * #3023 (parent #3013, row 2): one line above EVERY text box names both numbers. The line is `TextingFromLine`
 * (components/communication/shared/TextingFromLine.tsx), proven in its three wordings by texting-from-line.test.tsx; every
 * text box below is driven with it in composer-number-line.test.tsx.
 *
 * This guard reads the source: a text is sent only through the send hooks in lib/api (the only code that posts to the send
 * route), and every screen that calls one of them is listed here with its text boxes, each drawing the line. A new text box
 * (a new caller of a send hook, or a second post to the send route) fails here until it draws the line and is listed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The source without its comments. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f), src: code(f) }));

/** The only code that talks to the send route: the send hooks, and the line's own read. */
const SEND_ROUTE: Readonly<Record<string, string[]>> = {
  'lib/api/communication.ts': ['useSendSms (the inbox and the dialer)', 'useSendingNumbers (the line itself, a read)'],
  'lib/api/jobCommunications.ts': ['useSendLeadSms (a lead\'s Communication tab)', 'useSendJobSms (a job\'s Communication tab)'],
};

/** Every screen that sends a text, with its text boxes; each draws the line above the box. */
const TEXT_BOXES: Readonly<Record<string, string[]>> = {
  'components/communication/phone/SmsInboxView.tsx': [
    'a reply in the open conversation',
    'New message: to a customer (Text on a customer\'s page) or to a number (Text on a lead\'s or job\'s card or header)',
  ],
  'components/communication/phone/Dialer.tsx': ['the message panel during a call'],
  'components/communication/LeadCommunicationsTab.tsx': ['the lead\'s text box'],
  'components/communication/JobCommunicationsTab.tsx': ['the job\'s text box'],
};

const SEND_HOOK = /\buse(?:SendSms|SendLeadSms|SendJobSms)\s*\(/;

describe('every text box draws the line naming both numbers (#3023)', () => {
  it('only the send hooks talk to the send route', () => {
    const talking = FILES.filter((f) => /['"`]\/api\/communication\/sms(?:['"`/?]|\$\{)/.test(f.src)).map((f) => f.path).sort();
    expect(talking).toEqual(Object.keys(SEND_ROUTE).sort());
  });

  it('every screen that sends a text is listed', () => {
    const sending = FILES.filter((f) => !f.path.startsWith('lib/api/') && SEND_HOOK.test(f.src)).map((f) => f.path).sort();
    expect(sending).toEqual(Object.keys(TEXT_BOXES).sort());
  });

  it.each(Object.entries(TEXT_BOXES))('%s draws the line above each of its text boxes', (path, boxes) => {
    const src = FILES.find((f) => f.path === path)!.src;
    expect(src.match(/<TextingFromLine\b/g) ?? []).toHaveLength(boxes.length);
  });
});
