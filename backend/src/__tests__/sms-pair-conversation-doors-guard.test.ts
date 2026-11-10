import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * #3019: the guard behind "one conversation per pair of numbers".
 *
 * Every place in the backend (src, scripts, seeds) that finds or creates a text conversation is listed here, read from the
 * source, so a new door cannot key a customer's or an unknown number's conversation any other way:
 *   - every conversation create (a Prisma create/upsert, a nested create, or raw SQL into message_threads), and whether it is
 *     the pair's (it stores both numbers) or why it is not;
 *   - every caller of the shared pair find-or-create (lib/ctm/smsThread.ts), each one a door driven over HTTP on a real
 *     database in sms-pair-conversation-db.test.ts (or the split script's own suite);
 *   - every other single-conversation find, and what it is for;
 *   - every place that sets a conversation's other party, each decided by the one own-number rule (trap 8).
 * It fails the day a new place finds or creates a conversation (a new file, or one more call in a listed file) without being
 * listed, or a listed pair create stops storing the pair.
 */

const BACKEND = path.resolve(__dirname, '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' || name === 'copilot' ? [] : walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

/** A conversation create: on the model (any client: prisma, db, tx), nested under a text, or raw SQL (schema-qualified too). */
const CREATE = /\.messageThread\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\s*\(|\bthread\s*:\s*\{\s*(?:create|connectOrCreate)\b|INSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?message_threads"?/gi;
/** A single-conversation find on the model. */
const FIND_ONE = /\.messageThread\s*\.\s*(?:findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow)\s*\(/g;
/** A call of the shared pair find-or-create (not its definition, not an import). */
const PAIR_DOOR = /(?<!function\s)\b(findOrCreateSmsThreadByNumber|existingSmsThreadForNumber|findOrCreatePairConversation|existingPairConversation|latestPairConversationWith|findPairConversation)\s*\(/g;

/** Every file that creates a conversation: how many creates store the pair, and why each other one does not. */
const CREATES: Record<string, { pair: number; notAPair: string[] }> = {
  'src/lib/ctm/smsThread.ts': {
    pair: 1,
    notAPair: [
      "a vendor's conversation, or a number that is no phone number at all: keyed as before (vendor conversations are unchanged)",
      "a member of staff's conversation (staff conversations are unchanged)",
    ],
  },
  'src/controllers/comm-threads.controller.ts': {
    pair: 0,
    notAPair: [
      'POST /api/communication/threads: the internal create from a number, which knows none of our numbers (no screen calls it; the split script keys what it makes)',
      'a send from a customer with no number to text: nothing can be delivered, so there is no pair',
    ],
  },
  'src/services/automations/smsRecord.ts': {
    pair: 0,
    notAPair: [
      'an automated text to a customer with no number to text: nothing can be delivered, so there is no pair',
      "an automated text to a member of staff (staff conversations are unchanged)",
    ],
  },
  'scripts/sms-conversation-pair-split.ts': { pair: 1, notAPair: [] },
};

/** Every caller of the shared pair find-or-create, and the door it is. */
const PAIR_DOORS: Record<string, { calls: string[]; door: string }> = {
  'src/lib/ctm/ingest.ts': { calls: ['findOrCreateSmsThreadByNumber'], door: 'an incoming text, and a text the phone system reports sending (the webhook)' },
  'src/controllers/comm-threads.controller.ts': {
    calls: [
      'latestPairConversationWith', 'latestPairConversationWith', 'existingSmsThreadForNumber', 'existingPairConversation',
      'findOrCreatePairConversation', 'existingSmsThreadForNumber', 'findOrCreateSmsThreadByNumber', 'findOrCreatePairConversation',
    ],
    door: 'POST /api/communication/sms: a number typed into the composer, a send from a customer, a lead or a job (each '
      + 'continuing the latest conversation with the number, #3023), and a reply from a number no longer in use (filed in '
      + 'the main-line conversation, #3023); GET /api/communication/sms/numbers reads the same latest conversation, and '
      + 'peeks (makes nothing) at the conversation a number\'s or a customer\'s text would join, which Text on a customer opens '
      + '(#3023). Only the latest conversation a text continues is kept to the ones the person may continue '
      + '(conversationsTheyMayContinue, per conversation); the pair\'s own conversation is joined whoever can read it (Ran, '
      + '2026-11-06: never a second conversation for a pair)',
  },
  'src/services/automations/smsRecord.ts': { calls: ['findOrCreatePairConversation'], door: 'an automated text to a customer' },
  'src/lib/ctm/smsThread.ts': {
    calls: ['findPairConversation', 'existingPairConversation', 'findOrCreatePairConversation', 'existingPairConversation'],
    door: 'the shared helpers themselves (the find-or-create and the number door\'s peek ask the pair\'s peek, which asks the '
      + 'pair find; the number door calls the pair door)',
  },
};

/** Every other single-conversation find, per file, and what each one is for. None of them keys a conversation by a number. */
const OTHER_FINDS: Record<string, string[]> = {
  'src/lib/ctm/smsThread.ts': [
    'the pair find (findPairConversation)',
    'a conversation from before pairs that already holds a text of this pair (findConversationFromBeforePairs)',
    'whether the customer (or unknown number) already has a conversation keyed by this number (findConversationFromBeforePairs)',
    'before any keyed one: a conversation from before pairs whose texts name no number yet (findConversationFromBeforePairs)',
    "a vendor's conversation, or a number that is no phone number or is one of our own (keyed as before)",
    "the existence check: a vendor's conversation, or a number that is no phone number",
    "a member of staff's conversation",
  ],
  'src/controllers/comm-threads.controller.ts': [
    'GET /threads/:id (open one conversation, by id)',
    'mark read / unread (by id)',
    'a reply in a conversation (by id, for a person who may continue it, #3023); it then leaves from that conversation\'s number',
    'the line above a reply\'s text box (by id, for a person who may continue it, like the reply itself) (#3023)',
    'whether the conversation a send by number joins is one the sender may continue: the Access Communication gate (by id) (#3023)',
    'the conversation Text on a customer opens, only when the person can read it (by id) (#3023)',
    'a send from a customer with no number to text: the conversation it always had, never a pair\'s',
    '#3024 the attach menu for a text (the text\'s conversation)',
    're-tie a text to a job (the text\'s conversation)',
    're-tie a text to a lead (the text\'s conversation)',
  ],
  'src/services/automations/smsRecord.ts': [
    'an automated text to a customer with no number to text: the conversation it always had, never a pair\'s',
    "an automated text to a member of staff",
  ],
  'src/lib/communication/conversationReaders.ts': ['open one conversation for a record (by id)'],
  'src/lib/communication/communicationScope.ts': [
    "#3021: the number of the one conversation a read is about (by id, or by a text in it), to ask who carries it",
  ],
  'scripts/sms-conversation-pair-split.ts': ["the split: a conversation's last activity, by id"],
};

/** A conversation delete: on the model (any client), or raw SQL (schema-qualified too). */
const DELETE = /\.messageThread\s*\.\s*(?:delete|deleteMany)\s*\(|DELETE\s+FROM\s+(?:"?public"?\s*\.\s*)?"?message_threads"?/gi;

/**
 * Every file that deletes a conversation, and what each delete removes. Deleting a customer keeps a conversation someone
 * else still carries the number of (Ran, 2026-11-05; customer-purge-shared-conversation-db.test.ts): a new delete of a
 * customer's or a lead's conversations must apply the same rule, or say here why it need not.
 */
const DELETES: Record<string, string[]> = {
  'src/controllers/comm-threads.controller.ts': [
    'a send refused after it made a conversation: that conversation, only while it holds no text',
    'a send the delivery check refused: the conversation it had just made, only while it holds no text',
  ],
  'src/lib/purge.ts': [
    "a customer's leads' conversations, in the customer purge after the shared ones were kept and detached (the lead purge has no route)",
    "the customer's own conversations, after the shared ones were kept and detached (keepSharedConversations)",
    'every conversation of a company being purged (end-to-end teardown and the synthetic company only, name-guarded)',
  ],
  'scripts/sms-conversation-pair-split.ts': ['the split: a conversation left with no text'],
};

/**
 * Trap 8 (#3014's one own-number rule, lib/communication/otherPartyNumber.ts): one of our own numbers is never a
 * conversation's other party. Every place that sets a conversation's other party, read from the source:
 *   - a pair's `otherPartyE164` (an object property, shorthand too: the pair handed to the pair find-or-create, and the
 *     number door's option);
 *   - the number handed to latestPairConversationWith;
 *   - every `other_party_e164` property given a value, wherever the object is built (inline in a Prisma create, update,
 *     upsert or nested create, or a prebuilt data or where object), on a conversation or a text (a conversation is keyed
 *     from its texts' stored numbers);
 *   - raw SQL writing message_threads.other_party_e164 (schema-qualified, and the Unsafe variants, too: any raw write
 *     fails until it is listed).
 * Each one is either a value that calls the rule itself (`otherPartyE164(` or `otherPartyNumber(`), a name the same file
 * declares from it, a function's parameter whose callers are checked (listed below), or a value listed below that carries
 * a number the rule already decided.
 */
const DECIDED_ELSEWHERE: Record<string, string[]> = {
  'src/lib/ctm/smsThread.ts': [
    'pair.otherPartyE164', // the pair a door handed in, each door checked here
  ],
  'src/controllers/comm-threads.controller.ts': [
    't.other_party_e164', // the inbox answer reads back a conversation's stored pair
    'keyed.other_party_e164!', // #3023: a reply from a number no longer in use keeps its conversation's stored other party
    'target.otherParty', // #3023: the line's peek at the conversation a customer's text joins: customerDoorTarget decides it by the rule
  ],
  'src/lib/communication/conversationReaders.ts': [
    'thread.other_party_e164', // #3021: the alert filter reads back a conversation's stored pair to match its row in memory
  ],
  'scripts/text-other-party-number-fill-in.ts': [
    'number', // #3014's fill-in: every source is otherPartyNumber(…, ownNumbers) (text-other-party-number-writers-guard)
  ],
  'scripts/sms-conversation-pair-split.ts': [
    't.other_party_e164', // a text's stored other party (#3014 writers and fill-in, guarded by text-other-party-number-writers-guard)
    'pair.otherPartyE164', // a pair built from a text's stored other party, or an already keyed conversation's stored pair
    'unit.keyAs.otherPartyE164', // the same, keying a conversation in place
    'home.pair.otherPartyE164', // the same
  ],
};

/** A call's own parameter that carries a number the rule decided at its caller, per file: `name` -> why. */
const DECIDED_BY_CALLER: Record<string, Record<string, string>> = {
  'src/lib/ctm/smsThread.ts': {
    otherPartyE164: "latestPairConversationWith's number: each call of it is checked here",
  },
  'src/services/automations/smsRecord.ts': {
    otherParty: "findOrCreateThread's number: recordOutboundSms, its only caller, decides it by the rule",
  },
  'src/controllers/comm-threads.controller.ts': {
    // Not a conversation's other party being set: the number whose conversations a person may continue, asked of the continue
    // rule (textContinueScopeForReq). Its callers pass the rule's answer or a conversation's stored other party.
    otherParty: "conversationsTheyMayContinue's number (#3023): a read target, each caller's value decided by the rule",
  },
};

/** The value at `from` up to the end of its expression (a comma, a closing bracket or a semicolon at its own depth). */
function valueAt(text: string, from: number): { value: string; end: string } {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return { value: text.slice(from, i).trim(), end: ch };
      depth--;
    } else if ((ch === ',' || ch === ';' || ch === '\n') && depth === 0) return { value: text.slice(from, i).trim(), end: ch };
  }
  return { value: text.slice(from).trim(), end: '' };
}

/** A value that calls the one own-number rule. */
const CALLS_THE_RULE = /\b(?:otherPartyE164|otherPartyNumber)\s*\(/;

/**
 * A value that is the rule's answer and nothing else: the rule's call (awaited, in brackets, with a `!` or a fallback to
 * no number at most). A fallback to another number (`?? normalizeNAPhone(n)`) is not the rule's answer.
 */
function isTheRule(value: string): boolean {
  if (!CALLS_THE_RULE.test(value)) return false;
  let rest = value;
  for (let m = rest.match(CALLS_THE_RULE); m; m = rest.match(CALLS_THE_RULE)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < rest.length; close++) {
      if (rest[close] === '(') depth++;
      else if (rest[close] === ')' && --depth === 0) break;
    }
    rest = `${rest.slice(0, m.index!)}RULE${rest.slice(close + 1)}`;
  }
  // The number door's option, else the rule: the option is an `otherPartyE164:` property at each caller, checked here too.
  rest = rest.replace(/^opts\.otherPartyE164\s*!==\s*undefined\s*\?\s*opts\.otherPartyE164\s*:\s*/, '');
  return /^[\s(]*(?:await\s+)?[\s(]*RULE[\s)!]*(?:(?:\?\?|\|\|)\s*(?:null|undefined)[\s)]*)?$/.test(rest);
}

const TYPE_ONLY = /^(?:string|null|undefined)(?:\s*\|\s*(?:string|null|undefined))*$/;

/** Every place in one file that sets a conversation's other party, as the value written there. */
function otherPartySets(text: string): { at: number; value: string }[] {
  const sets: { at: number; value: string }[] = [];
  for (const m of text.matchAll(/(?<![\w.$])otherPartyE164\s*:(?!:)\s*/g)) {
    const { value, end } = valueAt(text, m.index! + m[0].length);
    // A type member or a parameter's type, not a value.
    if (end === ';' || TYPE_ONLY.test(value)) continue;
    sets.push({ at: m.index!, value });
  }
  for (const m of text.matchAll(/[{,]\s*otherPartyE164\s*(?=[,}])/g)) {
    // Not an import of the rule itself (`import { otherPartyE164 } from ...`).
    const statementStart = text.lastIndexOf(';', m.index!) + 1;
    if (/^\s*import\b/.test(text.slice(statementStart, m.index!))) continue;
    sets.push({ at: m.index!, value: 'otherPartyE164' });
  }
  for (const m of text.matchAll(/(?<!function\s)\blatestPairConversationWith\s*\(/g)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    const call = callText(text, m.index!);
    const args = call.slice(call.indexOf('(') + 1, -1);
    const third = args.split(',')[2];
    sets.push({ at: m.index!, value: (third ?? '').trim() });
  }
  // snake_case shorthand (`{ other_party_e164 }`), not a destructuring read (`const { other_party_e164 } = row`).
  for (const m of text.matchAll(/[{,]\s*other_party_e164\s*(?=[,}])/g)) {
    const close = text.indexOf('}', m.index! + 1);
    if (/^\s*\)?\s*(?:=(?![=>])|=>|:)/.test(text.slice(close + 1, close + 40))) continue;
    sets.push({ at: m.index!, value: 'other_party_e164' });
  }
  // A quoted or computed key (`'other_party_e164': ...`, `['other_party_e164']: ...`).
  for (const m of text.matchAll(/\[?\s*(['"`])other_party_e164\1\s*\]?\s*:(?!:)\s*/g)) {
    const { value, end } = valueAt(text, m.index! + m[0].length);
    if (end === ';' || TYPE_ONLY.test(value) || value === 'true' || value.startsWith('{')) continue;
    sets.push({ at: m.index!, value });
  }
  for (const m of text.matchAll(/(?<![\w.$])other_party_e164\s*:(?!:)\s*/g)) {
    const { value, end } = valueAt(text, m.index! + m[0].length);
    // Not a value: a type member, a select (`true`), a filter (`{ not: null }`); and storing none is never one of ours.
    if (end === ';' || TYPE_ONLY.test(value) || value === 'true' || value.startsWith('{')) continue;
    sets.push({ at: m.index!, value });
  }
  const rawWrite = /\b(?:UPDATE|INSERT\s+INTO)\s+(?:"?public"?\s*\.\s*)?"?message_threads"?[^;`]*?\bother_party_e164\b/gi;
  for (const m of text.matchAll(rawWrite)) sets.push({ at: m.index!, value: '<raw SQL write>' });
  return sets.sort((a, b) => a.at - b.at);
}

/**
 * How `name`, used at `at`, is declared: the nearest declaration before it in the file, a variable (`const name = ...`,
 * decided by the rule when its value calls it) or a function's parameter (`(…, name: string | null, …)`), decided where the
 * function is called.
 */
function declaration(text: string, name: string, at: number): 'rule' | 'parameter' | 'other' {
  const before = text.slice(0, at);
  const variables = [...before.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*`, 'g'))];
  const parameters = [...before.matchAll(new RegExp(`[(,]\\s*${name}\\s*\\??\\s*:\\s*[^,)=]+[,)]`, 'g'))];
  const variable = variables[variables.length - 1];
  const parameter = parameters[parameters.length - 1];
  if (parameter && (!variable || parameter.index! > variable.index!)) return 'parameter';
  if (!variable) return 'other';
  const { value } = valueAt(text, variable.index! + variable[0].length);
  if (!isTheRule(value)) return 'other';
  // A `let` given another value between its declaration and this use is not the rule's answer any more.
  const between = text.slice(variable.index! + variable[0].length + value.length, at);
  const assignments = [...between.matchAll(new RegExp(`(?<![\\w.$])${name}\\s*(?:\\?\\?|\\|\\|)?=(?![=>])\\s*`, 'g'))];
  return assignments.every((a) => isTheRule(valueAt(between, a.index! + a[0].length).value)) ? 'rule' : 'other';
}

/** The text of the call that starts at `from` (its balanced parentheses or braces), or the next 1500 characters for raw SQL. */
function callText(text: string, from: number): string {
  const paren = text.indexOf('(', from);
  const brace = text.indexOf('{', from);
  const open = [paren, brace].filter((i) => i >= 0 && i - from <= 80).sort((a, b) => a - b)[0];
  if (open === undefined) return text.slice(from, from + 1500);
  const [o, c] = text[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

/** Source without comments, so a mention in a comment is never a call. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

const files = [path.join(BACKEND, 'src'), path.join(BACKEND, 'scripts'), path.join(BACKEND, 'prisma')]
  .flatMap(walk)
  .map((file) => ({ rel: path.relative(BACKEND, file).split(path.sep).join('/'), text: code(readFileSync(file, 'utf8')) }));

const creates = files.flatMap(({ rel, text }) => [...text.matchAll(CREATE)].map((m) => ({ rel, call: callText(text, m.index!) })));
const isPairCreate = (call: string) =>
  /\bother_party_e164\s*:\s*(?!null\b|undefined\b)\S/.test(call) && /\bour_number_e164\s*:\s*(?!undefined\b)\S/.test(call);

describe('every place that finds or creates a text conversation keys a customer\'s or an unknown number\'s by its pair', () => {
  it('creates conversations only in the listed places, each one the pair\'s or listed with its reason', () => {
    const found: Record<string, { pair: number; notAPair: number }> = {};
    for (const c of creates) {
      const f = (found[c.rel] ??= { pair: 0, notAPair: 0 });
      if (isPairCreate(c.call)) f.pair += 1;
      else f.notAPair += 1;
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(CREATES).map(([rel, c]) => [rel, { pair: c.pair, notAPair: c.notAPair.length }])),
    );
  });

  it('finds or creates a pair\'s conversation only through the shared helper, from the listed doors', () => {
    const found: Record<string, string[]> = {};
    for (const { rel, text } of files) {
      const calls = [...text.matchAll(PAIR_DOOR)]
        // Not the definition line (`export async function name(`).
        .filter((m) => !/function\s+$/.test(text.slice(Math.max(0, m.index! - 20), m.index!)))
        .map((m) => m[1]!);
      if (calls.length) found[rel] = calls;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(PAIR_DOORS).map(([rel, d]) => [rel, d.calls])));
  });

  it('finds a single conversation anywhere else only in the listed places', () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of files) {
      const n = [...text.matchAll(FIND_ONE)].length;
      if (n) found[rel] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(OTHER_FINDS).map(([rel, why]) => [rel, why.length])));
  });

  it('deletes conversations only in the listed places', () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of files) {
      const n = [...text.matchAll(DELETE)].length;
      if (n) found[rel] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(DELETES).map(([rel, why]) => [rel, why.length])));
  });

  it('the number door names our number on every call (the pair needs both numbers)', () => {
    const missing = files.flatMap(({ rel, text }) =>
      [...text.matchAll(/\bfindOrCreateSmsThreadByNumber\s*\(/g)]
        .filter((m) => !/function\s+$/.test(text.slice(Math.max(0, m.index! - 20), m.index!)))
        .map((m) => ({ rel, call: callText(text, m.index!) }))
        // (db, orgId, number, ourNumber, identify, ...): five arguments at least.
        .filter((c) => c.call.slice(c.call.indexOf('(') + 1).split(',').length < 5)
        .map((c) => `${c.rel}: ${c.call.slice(0, 100)}`),
    );
    expect(missing).toEqual([]);
  });
  it('a conversation\'s other party is always decided by the one own-number rule (trap 8)', () => {
    const undecided: string[] = [];
    for (const { rel, text } of files) {
      if (rel === 'src/lib/communication/otherPartyNumber.ts') continue;
      for (const { at, value } of otherPartySets(text)) {
        const line = text.slice(0, at).split('\n').length;
        if (isTheRule(value) || DECIDED_ELSEWHERE[rel]?.includes(value)) continue;
        if (/^[A-Za-z_$][\w$]*$/.test(value)) {
          const declared = declaration(text, value, at);
          if (declared === 'rule' || (declared === 'parameter' && DECIDED_BY_CALLER[rel]?.[value])) continue;
        }
        undecided.push(`${rel}:${line}: ${value}`);
      }
    }
    expect(undecided).toEqual([]);
  });
});
