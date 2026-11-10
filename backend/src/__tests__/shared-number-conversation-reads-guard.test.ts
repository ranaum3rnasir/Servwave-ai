import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * #3021: the guard behind "a shared-number conversation shows on every customer with the number".
 *
 * Which customers a text conversation shows on, and who reads its texts, is worked out at read time from the customers
 * carrying its number (#3013 decisions 4 and 5). Every place in the backend (src, scripts, seeds) that reads texts or
 * conversations is listed here, read from the source, with the rule it reads by, so a new read (a list, a badge, a page, an
 * alert, an export) cannot be added without saying which rule it follows. Counted per file:
 *   - a read on the text models with any client (prisma, db, tx): find, count, group, aggregate;
 *   - raw SQL reading messages, message_threads or the read markers, schema-qualified too;
 *   - a relation filter from another model into texts (`messages: { some ... }`, `message_threads: { none ... }`), and a
 *     nested include or select of a conversation's texts.
 * The reads a person sees are driven over HTTP on a real database in shared-number-conversation-db.test.ts.
 */

const BACKEND = path.resolve(__dirname, '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' || name === 'copilot' ? [] : walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

/** A read on the text models, with any client. */
const READ = /\.(?:message|messageThread|messageThreadReadState)\s*\.\s*(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|groupBy|aggregate)\s*\(/g;
/** Raw SQL reading the text tables (`$queryRaw`, `$queryRawUnsafe` or any string), schema-qualified too. */
const RAW = /(?:FROM|JOIN)\s+(?:"?public"?\s*\.\s*)?"?(?:messages|message_threads|message_thread_read_states)"?(?![\w])/gi;
/** A relation into texts from another model: a filter on them, or a nested include / select of them. */
const RELATION = /\b(?:message_threads|messages|sent_messages|read_states)\s*:\s*(?:true\b|\{\s*(?:some|every|none|where|select|include|orderBy)\b)/g;

/** Source without comments, so a mention in a comment is never a read. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

// The rules a read follows.
const INBOX = 'the inbox list: Communication scope (textsInSectionScopeForReq); names every customer carrying the number (attachCarriers)';
const OPEN = 'opening one conversation or one text: textReadScopeForReq with it as the target, so any customer carrying its number counts (decision 4)';
// #3023 (Ran, 2026-11-06, after spec r3): who may CONTINUE a conversation is decided per conversation (a customer they open
// carries its number, or they read any text in it). A read under it answers with no text of the conversation.
const CONTINUE = 'continuing one conversation: textContinueScopeForReq with it as the target (per conversation, #3023); answers with none of its texts';
const PAGE = "a customer's Communication tab: the conversations on the numbers the customer carries now (numbersCustomerCarries, decision 5)";
const RECORD = "a lead's or a job's Communication tab: the texts tied to it (#3022 owns the window), record reach";
const BADGE = 'the unread badge: Communication scope, as the inbox list';
const ALERT = 'an alert: who reads the quoted text (conversationReaders asks the same rule, carriers included)';
const NOT_SHOWN = 'not a list a person sees';
const NOT_TEXTS = 'not a text (another model\'s relation of the same name)';

/** Every file that reads texts or conversations, each read in source order with its rule. */
const READS: Record<string, string[]> = {
  'src/controllers/comm-threads.controller.ts': [
    `${BADGE}: the person's read markers on the page's conversations`,
    INBOX,
    `${INBOX}: the texts of each listed conversation`,
    OPEN,
    `${OPEN}: its texts`,
    `${OPEN} (mark read / unread)`,
    `${NOT_SHOWN}: POST /threads, the internal create, answers with the conversation it made`,
    `${NOT_SHOWN}: whether the conversation a send by number joins is one the sender may continue (the Access Communication gate, #3023; its id only)`,
    `${OPEN} (#3023: the conversation Text on a customer opens, named only when the person can read it; its id only)`,
    `${CONTINUE} (the line above a reply's text box, #3023: the conversation's numbers only, refused as the reply is)`,
    `${CONTINUE} (a reply in it)`,
    `${NOT_SHOWN}: a send from a customer with no number keeps the conversation it always had`,
    `${NOT_SHOWN}: a refused send removes the conversation it just made while it holds no text`,
    `${NOT_SHOWN}: a send the delivery check refused removes the conversation it made while it holds no text`,
    `${OPEN} (#3024 the attach menu for a text: its conversation)`,
    `${OPEN} (#3024 the attach menu for a text: the conversation holding it)`,
    `${OPEN} (re-tie a text to a job: its conversation)`,
    `${OPEN} (re-tie a text to a job: the conversation holding it)`,
    `${OPEN} (re-tie a text to a job: the text after the write)`,
    `${OPEN} (re-tie a text to a lead: the text before the write)`,
    `${OPEN} (re-tie a text to a lead: its conversation)`,
    `${OPEN} (re-tie a text to a lead: the conversation holding it)`,
    `${OPEN} (re-tie a text to a lead: the text after the write)`,
  ],
  'src/controllers/comm-whatsapp-email.controller.ts': [
    `${NOT_TEXTS}: a WhatsApp chat's messages (list)`, `${NOT_TEXTS}: a WhatsApp chat's messages (one chat)`,
    `${NOT_TEXTS}: a WhatsApp chat's messages (send)`,
    BADGE, `${BADGE}: the texts of each conversation`, `${NOT_TEXTS}: the WhatsApp badge's messages`,
  ],
  'src/controllers/copilot.controller.ts': [`${NOT_TEXTS}: the copilot's own chat messages`],
  'src/lib/job-communications.ts': [RECORD.replace("a lead's or a job's", "a job's"), PAGE, RECORD.replace("a lead's or a job's", "a lead's")],
  'src/lib/communication/communicationScope.ts': [
    `${INBOX}: the conversations a person's own texts are in (reply attribution)`,
    `${INBOX}: reply attribution's candidates`,
    `${INBOX}: a conversation is listed when it holds a text the person reads`,
    `${OPEN}: the target's number`,
    `${OPEN}: the conversation holding the target text`,
  ],
  'src/lib/communication/conversationReaders.ts': [ALERT, `${ALERT}: the conversation's texts`],
  'src/services/notifications/conversationAlertRecipients.ts': [
    `${ALERT}: the quoted text`, `${ALERT}: reply attribution on its number`,
  ],
  'src/services/lead-contact.service.ts': [`${NOT_SHOWN}: whether a lead holds a text (lead contact status)`],
  'src/services/automations/smsRecord.ts': [
    `${NOT_SHOWN}: an automated text to a customer with no number keeps the conversation it always had`,
    `${NOT_SHOWN}: an automated text to a member of staff`,
  ],
  'src/lib/ctm/smsThread.ts': [
    `${NOT_SHOWN}: the pair find (#3019)`,
    `${NOT_SHOWN}: the latest conversation with a number (decision 2)`,
    // A conversation from before pairs (#3019, `findConversationFromBeforePairs`, shared by the find-or-create door and the
    // existence check): which un-keyed conversation a new text joins, never a list anyone is shown.
    // An unsent reply whose other party has no text with a company number takes the conversation's latest company number
    // of any text (Ran, 2026-11-06, #3019 r7, `takingTheLatestNumber`): five reads that only pick the conversation's id.
    `${NOT_SHOWN}: before pairs, the conversations an unsent reply may take the latest company number of`,
    `${NOT_SHOWN}: before pairs, ... holding an unsent reply of this pair`,
    `${NOT_SHOWN}: before pairs, ... where none of that other party's texts has a company number`,
    `${NOT_SHOWN}: before pairs, ... holding some text with a company number`,
    `${NOT_SHOWN}: before pairs, ... the company number of its latest such text (compared to our number, never returned)`,
    `${NOT_SHOWN}: before pairs, it holds a text of this pair through our number`,
    `${NOT_SHOWN}: before pairs, it holds a main-line text of this pair that is no unsent reply`,
    `${NOT_SHOWN}: before pairs, it holds an unsent reply of this pair (main line)`,
    `${NOT_SHOWN}: before pairs, ... while no text in the conversation has a company number`,
    `${NOT_SHOWN}: before pairs, the conversation holding this pair`,
    `${NOT_SHOWN}: before pairs, a conversation already keyed by that other party`,
    `${NOT_SHOWN}: before pairs, a conversation the fill-in has not reached`,
    `${NOT_SHOWN}: before pairs, ... none of its texts names a number`,
    `${NOT_SHOWN}: a vendor's conversation, or a number that is no phone number`,
    `${NOT_SHOWN}: the existence check, a vendor or a non-number`,
    `${NOT_SHOWN}: a member of staff's conversation`,
  ],
  'src/lib/ctm/ingest.ts': [
    `${NOT_SHOWN}: a duplicate event`, `${NOT_SHOWN}: the send's own row`, `${NOT_SHOWN}: a status update's row`,
  ],
  // The reply rule (#3020, `tieIncomingText`, called once by each door that stores an incoming text: the webhook in
  // lib/ctm/ingest.ts and a text recorded as received in comm-threads.controller.ts) reads the conversation's texts we sent
  // in the 30 days before the reply, selecting only their time, job label and the lead's and job's id and status. It returns
  // a lead id, a job id and that job's label to stamp on the incoming text; no text body, number or customer leaves it, so
  // it names no customer to anyone. Who then reads the tied text is the open-conversation rule's (a lead's or a job's
  // reach, decision 4).
  'src/lib/sms-reply-router.ts': [
    `${NOT_SHOWN}: the reply rule's candidate texts (the lead or job an incoming text is tied to, #3020); names no customer`,
  ],
  'src/lib/ctm/sendSms.ts': [`${NOT_SHOWN}: a duplicate send`],
  'src/lib/purge.ts': [
    `${NOT_SHOWN}: the conversations of a lead being deleted`,
    `${NOT_SHOWN}: the conversations a customer purge would delete (keep the shared ones, #3019)`,
    `${NOT_SHOWN}: the numbers those conversations' texts store`,
    `${NOT_SHOWN}: a customer's conversations, in the company purge`,
  ],
  'src/lib/comm-usage.ts': [`${NOT_SHOWN}: the company's text count for the usage meter (no text or customer named)`],
  'scripts/text-company-number-fill-in.ts': [`${NOT_SHOWN}: the fill-in's texts`, `${NOT_SHOWN}: the fill-in's count`],
  'scripts/text-other-party-number-fill-in.ts': [`${NOT_SHOWN}: the fill-in's texts`],
  'scripts/sms-conversation-pair-split.ts': [
    `${NOT_SHOWN}: the split's conversations`, `${NOT_SHOWN}: their texts`, `${NOT_SHOWN}: read markers`,
    `${NOT_SHOWN}: read markers`, `${NOT_SHOWN}: a conversation's last activity`, `${NOT_SHOWN}: the conversations a split empties`,
    `${NOT_SHOWN}: read markers`, `${NOT_SHOWN}: texts`,
  ],
};

const files = [path.join(BACKEND, 'src'), path.join(BACKEND, 'scripts'), path.join(BACKEND, 'prisma')]
  .flatMap((dir) => { try { return walk(dir); } catch { return []; } });

/** How many reads of texts each file holds, of every kind. */
function readsIn(file: string): number {
  const text = code(readFileSync(file, 'utf8'));
  return [READ, RAW, RELATION].reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

describe('#3021: every read of texts or conversations is listed with the rule it reads by', () => {
  it('no file reads texts without being listed, and every listed file holds exactly its listed reads', () => {
    const found: Record<string, number> = {};
    for (const file of files) {
      const n = readsIn(file);
      if (n > 0) found[path.relative(BACKEND, file)] = n;
    }
    const listed = Object.fromEntries(Object.entries(READS).map(([file, reads]) => [file, reads.length]));
    expect(found).toEqual(listed);
  });

  it('the guard sees every shape of read (shorthand, prebuilt where, nested relation, raw and schema-qualified SQL)', () => {
    const probe = code(`
      const a = await tx.message.findMany({ where });
      const b = await db.messageThread.count(prebuilt);
      const c = await prisma.customer.findMany({ where: { message_threads: { some: {} } } });
      const d = await prisma.$queryRawUnsafe('SELECT 1 FROM "public"."messages" m');
      const e = await prisma.$queryRaw\`SELECT 1 FROM public.message_threads t JOIN message_thread_read_states r ON true\`;
      const f = await prisma.messageThread.findFirst({ include: { messages: { where: {} } } });
      // prisma.message.findMany() in a comment is not a read
    `);
    const count = [READ, RAW, RELATION].reduce((n, re) => n + (probe.match(re)?.length ?? 0), 0);
    expect(count).toBe(8);
  });

  it('every single read of a text conversation names its target, so the customers carrying its number are asked about', () => {
    const scope = code(readFileSync(path.join(BACKEND, 'src/lib/communication/communicationScope.ts'), 'utf8'));
    expect(scope).toMatch(/export async function textReadScopeForReq\(req: Request, target: TextTarget\)/);
    const callers = files.flatMap((file) => {
      const text = code(readFileSync(file, 'utf8'));
      return [...text.matchAll(/textReadScopeForReq\(([^)]*)\)/g)].map((m) => `${path.relative(BACKEND, file)}: ${m[1]}`);
    }).filter((c) => !c.includes('req: Request, target'));
    expect(callers).toEqual([
      "src/controllers/comm-threads.controller.ts: req, { threadId: req.params.id as string }",
      "src/controllers/comm-threads.controller.ts: req, { threadId: req.params.id as string }",
      // #3023: the conversation Text on a customer opens is named only when the person can read it.
      "src/controllers/comm-threads.controller.ts: req, { threadId: conversation.id }",
      "src/controllers/comm-threads.controller.ts: req, { messageId: req.params.id as string }",
      "src/controllers/comm-threads.controller.ts: req, { messageId: req.params.id as string }",
      "src/controllers/comm-threads.controller.ts: req, { messageId: req.params.id as string }",
    ]);
  });

  // #3023 (Ran, 2026-11-06, after spec r3): the reply door, its line, and the conversations with a number a person may continue
  // moved from the read rule to the continue rule (per conversation). Each still names its target, so the customers carrying
  // the number are asked about.
  it('every check of who may continue a text conversation names its target too', () => {
    const scope = code(readFileSync(path.join(BACKEND, 'src/lib/communication/communicationScope.ts'), 'utf8'));
    expect(scope).toMatch(/export async function textContinueScopeForReq\(req: Request, target: TextTarget\)/);
    const callers = files.flatMap((file) => {
      const text = code(readFileSync(file, 'utf8'));
      return [...text.matchAll(/textContinueScopeForReq\(([^)]*)\)/g)].map((m) => `${path.relative(BACKEND, file)}: ${m[1]}`);
    }).filter((c) => !c.includes('req: Request, target'));
    expect(callers).toEqual([
      "src/controllers/comm-threads.controller.ts: req, { otherPartyE164: otherParty }",
      "src/controllers/comm-threads.controller.ts: req, { threadId: q.threadId }",
      "src/controllers/comm-threads.controller.ts: req, { threadId: req.body.threadId }",
    ]);
  });
});
