import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * PRD 10, S10.6: the guard behind "every reader of received mail asks the Email plan feature".
 *
 * While the company's Email plan feature is off, received mail is stored as ever but shown nowhere. That holds because every
 * place that reads email rows goes through ONE gate (lib/communication/communicationScope.ts, `emailFeatureOn`, `NO_EMAIL`),
 * not because each route remembers to. This fails the day a file starts reading `emails`, `email_threads`, their attachments
 * or their read marks without being declared here: a new reader must either use the gate or say, in this list, why it
 * reads no one's mail to show it.
 */

const SRC = path.resolve(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });

const READS_BY_CLIENT = /\.(email|emailThread|emailAttachment|emailReadState)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\b/;
const READS_BY_SQL = /\b(from|join)\s+"?(emails|email_threads|email_attachments|email_read_states)\b/i;
const READS_BY_RELATION = /\bemail_read_states\s*:/;

/** A file that reads email rows, and what makes that safe while the feature is off. */
const READERS: Record<string, { why: string; mentions?: RegExp }> = {
  'controllers/comm-whatsapp-email.controller.ts': {
    why: 'the Email page and the unread badge: every query is filtered by a communicationScope reader, which answers "no row" while the feature is off',
    mentions: /emailReadWhereForReq\(/,
  },
  'lib/communication/communicationScope.ts': { why: 'is the gate', mentions: /emailFeatureOn\(req\)/ },
  'lib/communication/mailboxList.ts': { why: 'the mailbox list and its counts, answered empty before any read', mentions: /emailFeatureOn\(req\)/ },
  'lib/communication/needsReview.ts': {
    why: 'the Needs review list\'s scope and counts (S10.18): answers "no row" while the feature is off, before any read',
    mentions: /emailFeatureOn\(req\)/,
  },
  'lib/communication/recordPeopleThreads.ts': {
    why: 'the record people\'s statement: asked only by communicationScope\'s Email section, which is not built while the feature is off',
  },
  'lib/job-communications.ts': { why: 'the record tabs: the email source is not read when the tab is built without email', mentions: /emailHiddenFrom\(/ },
  'controllers/resend-webhook.controller.ts': {
    why: 'the delivery webhook: sent mail\'s delivery status by provider id; nothing it reads is returned to anyone, and it announces a reply only after the feature check',
    mentions: /orgEmailFeatureOn\(/,
  },
  'lib/communication/conversationReaders.ts': {
    why: 'who may read a conversation, for the alert filter: asks the plan feature first via orgEmailFeatureOn and answers nobody while it is off; nothing it reads is returned',
    mentions: /orgEmailFeatureOn\(/,
  },
  'lib/inbound-email.ts': {
    why: 'stores received mail (S10.18: reads only the record conversation a held reply is filed in, to reuse it): it stores whatever the plan feature says (kept mail is kept, hidden like the rest); nothing it reads is returned to anyone',
  },
  'lib/inbound-attachments.ts': {
    why: 'brings a stored received message\'s files over (S10.17): reads only which stored copies still have files on their way and which it already stored, to finish the store, whatever the plan feature says (kept mail keeps its files, hidden like the message); nothing it reads is returned to anyone',
  },
  'services/notifications/emailReplyAlerts.ts': {
    why: 'the customer-reply alert (S10.10): reads the conversation and the mail that went out to decide who to ring, after asking the plan feature, and rings nobody while it is off; nothing it reads is returned',
    mentions: /orgEmailFeatureOn\(/,
  },
};

describe('every reader of received mail is behind the Email plan feature', () => {
  const found = walk(SRC)
    .map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => READS_BY_CLIENT.test(text) || READS_BY_SQL.test(text) || READS_BY_RELATION.test(text));

  it('reads email rows in no file this list does not declare', () => {
    const undeclared = found.map((f) => f.rel).filter((rel) => !(rel in READERS));
    expect(undeclared, 'a new reader of email rows must use the gate in communicationScope.ts (emailFeatureOn / NO_EMAIL), then be declared in READERS').toEqual([]);
  });

  it('names no file that no longer reads email rows', () => {
    expect(Object.keys(READERS).filter((rel) => !found.some((f) => f.rel === rel))).toEqual([]);
  });

  it.each(Object.entries(READERS).filter(([, r]) => r.mentions))('%s uses the gate it is declared to use', (rel, reader) => {
    const file = found.find((f) => f.rel === rel);
    expect(file?.text).toMatch(reader.mentions!);
  });

  it('keeps the gate itself: every Email page reader of communicationScope refuses first', () => {
    const text = readFileSync(path.join(SRC, 'lib/communication/communicationScope.ts'), 'utf8');
    for (const fn of ['emailsInSectionWhereForReq', 'emailReadWhereForReq', 'emailSectionForReq']) {
      const body = text.slice(text.indexOf(`export async function ${fn}(`));
      expect(body.slice(0, body.indexOf('\n}')), fn).toMatch(/emailFeatureOn\(req\)/);
    }
  });
});
