// #3021: every place the screens read text conversations, or pick a customer's conversation out of the list, is listed with
// the rule it follows. Which customers a conversation shows on is the server's answer, worked out at each read (#3013
// decision 5): the list and the open conversation carry them (`pair.customers`), and a customer's page asks the server for the
// conversations on that customer's numbers. A new read, or a new lookup of "this customer's conversation", fails here until
// it says which rule it follows.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : walk(full);
    return /\.(ts|tsx)$/.test(full) && !/\.(test|stories)\.(ts|tsx)$/.test(full) ? [full] : [];
  });

/** A read of conversations or texts from the server: the inbox list, one conversation, or a record's Communication tab. */
const READ = /\/api\/communication\/threads|\/communications[`'"]/g;
/** A lookup of a customer's conversation in a list the screen already holds. */
const LOOKUP = /\.customerId\s*===/g;

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

const SERVER = "the server's answer: it names the customers carrying the number and decides who reads what";
const SEND = 'which conversation a send continues is decided by the server (#3019 decision 2), not by this lookup';

const READS: Record<string, string[]> = {
  'lib/api/communication.ts': [`${SERVER}: the inbox list`, `${SERVER}: one conversation`, 'mark read', 'mark unread'],
  'lib/api/jobCommunications.ts': [`${SERVER}: a job's tab`, `${SERVER}: a lead's tab`],
  'components/communication/CustomerCommunicationsTab.tsx': [`${SERVER}: the conversations on the customer's numbers`],
  'components/jobs/overview/CustomerContactCard.tsx': [`${SERVER}: the job's tab, for its last contact`],
};

const LOOKUPS: Record<string, string[]> = {
  'components/communication/phone/SmsInboxView.tsx': [
    `a conversation the composer just started, before the server lists it (${SEND})`,
    // #3023 (#3013 decision 2): a link to a customer (?customerId=) no longer looks one up in the list: it opens the
    // conversation the server names for the customer's text box (the line's `conversationId`), else the composer.
    'the lead a lead page sent the person with, tied to that link\'s conversation',
    'the same lead, tied once the conversation exists',
    `the composer's send to a customer (${SEND})`,
    'the same lead, on the composer\'s first send',
    // #3023 (Ran, 2026-11-06, spec r3 M3): the first reply keeps the lead on the conversation the link was tied to, whichever
    // customer it is filed on: no customer lookup there any more (the server keeps the lead when it carries the number).
    'the composer\'s preselected customer (a directory entry, not a conversation)',
  ],
  'components/communication/phone/Dialer.tsx': [
    'the dialer\'s directory entry for a customer (not a conversation)',
    `the dialer's text pane for a customer (${SEND})`,
  ],
};

function inventory(re: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const n = code(readFileSync(file, 'utf8')).match(re)?.length ?? 0;
    if (n > 0) found[path.relative(SRC, file)] = n;
  }
  return found;
}

const counts = (listed: Record<string, string[]>) => Object.fromEntries(Object.entries(listed).map(([f, r]) => [f, r.length]));

describe('#3021: every read of text conversations on the screens is listed with its rule', () => {
  it('reads from the server', () => {
    expect(inventory(READ)).toEqual(counts(READS));
  });

  it("lookups of a customer's conversation in a list already held", () => {
    expect(inventory(LOOKUP)).toEqual(counts(LOOKUPS));
  });
});
