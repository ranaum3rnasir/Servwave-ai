import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * #3020: the guard behind "a reply lands on the lead that texted".
 *
 * Every place in the backend (src, scripts, prisma) that writes a text row is listed here, read from the source, so a new
 * place cannot tie an incoming text to a lead or a job any other way than by the one reply rule (lib/sms-reply-router.ts):
 *   - every text create (a Prisma create/createMany/upsert on any client, a nested create under a conversation, or raw SQL
 *     into messages, schema-qualified too), and what it writes; the two that can store an INCOMING text take its lead and
 *     job from the reply rule;
 *   - every other write to a text row, and what it is for (none ties a text by a rule; a person's re-tie is a choice);
 *   - every caller of the reply rule, each a door that stores an incoming text.
 * The rule itself is driven through the incoming-text webhook on a real database in sms-reply-tie-db.test.ts, and the
 * composer's recorded-as-received door by comm-attribution.test.ts.
 */

const BACKEND = path.resolve(__dirname, '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' || name === 'copilot' ? [] : walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

/** The source without comments, so a mention in a comment is never a call. */
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const FILES = ['src', 'scripts', 'prisma'].flatMap((d) => walk(path.join(BACKEND, d)));
const rel = (file: string) => path.relative(BACKEND, file).split(path.sep).join('/');

/** A text create: on the model (any client), nested under a conversation, or raw SQL into messages. */
const CREATE = /\.message\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\s*\(|\bmessages\s*:\s*\{\s*(?:create|createMany|connectOrCreate)\b|INSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?messages"?\b/gi;
/** Any other write to a text row: on the model, or raw SQL. */
const OTHER_WRITE = /\.message\s*\.\s*(?:update|updateMany|updateManyAndReturn)\s*\(|UPDATE\s+(?:"?public"?\s*\.\s*)?"?messages"?\s+SET\b/gi;
/** A call of the reply rule (not its definition, not an import). */
const RULE = /(?<!function\s)\btieIncomingText\s*\(/g;

const count = (re: RegExp, text: string) => (text.match(re) ?? []).length;

/** Every file that creates a text row, and what each create writes. */
const CREATES: Record<string, { creates: string[]; storesIncoming: boolean }> = {
  'src/lib/ctm/ingest.ts': {
    creates: ['an incoming text the phone system delivers (tied by the reply rule), or a text it reports sending (tied to nothing)'],
    storesIncoming: true,
  },
  'src/controllers/comm-threads.controller.ts': {
    creates: [
      'a text a person sends (tied to the lead or job it is sent from), or records as received (tied by the reply rule unless a lead or job is named)',
    ],
    storesIncoming: true,
  },
  'src/services/automations/smsRecord.ts': {
    creates: ['an automated text: outbound only, tied to the job it is about'],
    storesIncoming: false,
  },
};

/** Every other write to a text row, per file, and what each is for. */
const OTHER_WRITES: Record<string, string[]> = {
  'src/lib/ctm/ingest.ts': [
    'a delivery state reported again for a stored text (status and company number only)',
    'the message id stamped on a text we sent that the provider reports back (status and company number only)',
    'a lean delivery state (status only)',
  ],
  'src/controllers/comm-threads.controller.ts': [
    'a person re-ties a text to a job, or unties it (PATCH /api/communication/sms/:id/job): a choice, not a rule',
    'a person re-ties a text to a lead, or unties it (PATCH /api/communication/sms/:id/lead): a choice, not a rule',
  ],
  'src/lib/ctm/sendSms.ts': Array(5).fill('a send\'s delivery outcome (status, message id, company number only)'),
  'scripts/sms-conversation-pair-split.ts': ['moves texts between conversations (#3019): their lead and job stay as they are'],
  'scripts/text-company-number-fill-in.ts': ['fills a text\'s company number', 'fills a text\'s company number'],
  'scripts/text-other-party-number-fill-in.ts': ['fills a text\'s other party number (#3014)'],
};

/** Every caller of the reply rule, and the door it is. */
const RULE_DOORS: Record<string, string> = {
  'src/lib/ctm/ingest.ts': 'an incoming text the phone system delivers (the webhook, and the backfill through the same ingest)',
  'src/controllers/comm-threads.controller.ts':
    'POST /api/communication/sms with direction "in": a text recorded as received (the conversation step only; no own-number lookup for a signed-in person)',
};

describe('#3020: every place that writes a text row ties an incoming text by the one reply rule', () => {
  it('every text create is listed, and only the listed ones store an incoming text', () => {
    const found = Object.fromEntries(
      FILES.map((f) => [rel(f), count(CREATE, code(f))] as const).filter(([, n]) => n > 0),
    );
    expect(found).toEqual(Object.fromEntries(Object.entries(CREATES).map(([f, v]) => [f, v.creates.length])));
  });

  it('every other write to a text row is listed', () => {
    const found = Object.fromEntries(
      FILES.map((f) => [rel(f), count(OTHER_WRITE, code(f))] as const).filter(([, n]) => n > 0),
    );
    expect(found).toEqual(Object.fromEntries(Object.entries(OTHER_WRITES).map(([f, v]) => [f, v.length])));
  });

  it('the reply rule is called by exactly the doors that store an incoming text, once each', () => {
    const found = Object.fromEntries(
      FILES.map((f) => [rel(f), count(RULE, code(f))] as const).filter(([, n]) => n > 0),
    );
    const storesIncoming = Object.entries(CREATES).filter(([, v]) => v.storesIncoming).map(([f]) => f).sort();
    expect(Object.keys(RULE_DOORS).sort()).toEqual(storesIncoming);
    expect(found).toEqual(Object.fromEntries(Object.keys(RULE_DOORS).map((f) => [f, 1])));
  });

  it('the webhook stores the lead and job the rule gives, and only for an incoming text', () => {
    const ingest = code(path.join(BACKEND, 'src/lib/ctm/ingest.ts'));
    expect(ingest).toMatch(/const tie = direction === 'in' \? await tieIncomingText\(/);
    expect(ingest).toMatch(/job_id: tie\.jobId,\s*job_label: tie\.jobLabel,\s*lead_id: tie\.leadId,/);
    // The phone match never carries a lead into a text (the unreachable branch is gone).
    expect(ingest).not.toMatch(/lead_id: match\?\.leadId/);
  });

  it('a text recorded as received stores the lead and job the rule gives, unless the request names them', () => {
    const controller = code(path.join(BACKEND, 'src/controllers/comm-threads.controller.ts'));
    expect(controller).toMatch(/replyTie = await tieIncomingText\(/);
    expect(controller).toMatch(/if \(replyTie\.jobId\) jobStamp = \{ job_id: replyTie\.jobId, job_label: replyTie\.jobLabel \}/);
    expect(controller).toMatch(/lead_id: leadId \?\? replyTie\.leadId/);
    // The own-number step resolves the number for the whole company: a signed-in door never hands it a number (P2-1).
    expect(controller).toMatch(/tieIncomingText\(prisma, orgId, \{ threadId: thread\.id, at: new Date\(\), from: null \}\)/);
  });
});
