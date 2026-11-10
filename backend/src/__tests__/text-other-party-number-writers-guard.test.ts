import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * #3014: the guard behind "every text remembers the other party's number".
 *
 * A text row is written in exactly the places listed in WRITERS, and each one stores `other_party_e164` through the one shared
 * rule (`otherPartyE164`, src/lib/communication/otherPartyNumber.ts: normalized E.164, never one of the organization's own
 * numbers). Each listed writer is driven through its HTTP door on a real database in text-other-party-number-db.test.ts. This
 * fails the day a new place writes a text row (a new file, or a second write in a listed file) without being listed here, or a
 * listed write stops storing the number through that rule.
 */

const BACKEND = path.resolve(__dirname, '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

/** Every write of a NEW text row: a create on the message model, a nested create under a thread, or raw SQL. */
const WRITE = /\.message\.(?:create|createMany|createManyAndReturn|upsert)\s*\(|\bmessages\s*:\s*\{\s*(?:create|createMany|connectOrCreate)\b|INSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?messages"?\b/gi;

/** Where text rows are written, how many writes each file holds, and the door that reaches them (each is a test in the -db suite). */
const WRITERS: Record<string, { writes: number; doors: string[] }> = {
  'src/controllers/comm-threads.controller.ts': {
    writes: 1,
    doors: ['a text sent from the inbox (POST /api/communication/sms)', 'a text sent from a lead (the same route with a lead)'],
  },
  'src/services/automations/smsRecord.ts': { writes: 1, doors: ['a text an automation sends'] },
  'src/lib/ctm/ingest.ts': { writes: 1, doors: ['an incoming text (the phone system webhook)'] },
};

/** The text of the call that starts at `from` (its balanced parentheses), or the next 1500 characters for raw SQL. */
function callText(text: string, from: number): string {
  const open = text.indexOf('(', from);
  if (open < 0 || open - from > 80) return text.slice(from, from + 1500);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

const writes = [path.join(BACKEND, 'src'), path.join(BACKEND, 'scripts'), path.join(BACKEND, 'prisma')]
  .flatMap(walk)
  .flatMap((file) => {
    const rel = path.relative(BACKEND, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    // #3019 reads the stored number once, before the write, because it also keys the conversation: a name the file assigns
    // straight from the shared rule (`const x = await otherPartyE164(...)`) counts as going through it.
    const ruled = [...text.matchAll(/\bconst\s+(\w+)\s*=\s*await\s+otherPartyE164\(/g)].map((m) => m[1]!);
    return [...text.matchAll(WRITE)].map((m) => ({ rel, call: callText(text, m.index!), ruled }));
  });

describe('every place that writes a text row stores the other party\'s number', () => {
  it('writes text rows only in the listed writers', () => {
    const found: Record<string, number> = {};
    for (const w of writes) found[w.rel] = (found[w.rel] ?? 0) + 1;
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITERS).map(([rel, w]) => [rel, w.writes])));
  });

  it.each(Object.keys(WRITERS))('%s stores other_party_e164 on every text it writes, through the one own-number rule', (rel) => {
    // A literal empty value, or a number that skips the shared rule, is not storing the other party's number.
    const throughRule = (w: (typeof writes)[number]) =>
      /\bother_party_e164\s*:\s*await\s+otherPartyE164\(/.test(w.call) ||
      w.ruled.some((name) => new RegExp(`\\bother_party_e164\\s*:\\s*${name}\\b`).test(w.call));
    const missing = writes.filter((w) => w.rel === rel && !throughRule(w));
    expect(missing.map((w) => w.call.slice(0, 120))).toEqual([]);
  });
});
