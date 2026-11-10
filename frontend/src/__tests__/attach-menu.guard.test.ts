// #3024: every place a screen re-ties a text or a call to a lead or job opens "Attach to a lead or job" (AttachMenu), the one
// menu Ran ruled for every re-tie point (each inbox text, the inbox's Unrouted "Assign", the record tabs' rows, the Calls
// page drawer). Source-driven: a new re-tie door, or an old menu put back on a text or a call, fails here until it is listed.
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

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

/** A screen using a door that re-ties a text or a call (not the hooks' own definitions). */
const DOOR = /(?<!function\s)\buse(?:Reassign(?:Sms|Call)(?:Job|Lead)|RetieText)\s*\(/g;
/** The re-tie routes themselves, called from the browser. */
const ROUTE = /\/api\/communication\/(?:sms|calls)\/\$\{[^}]+\}\/(?:job|lead)\b/g;
/** The older menu, which offers a customer's records or the whole company: fine for an email and a logged entry only. */
const OLD_MENU = /<(?:CommJobMenu|JobAssignMenu)\b/g;

const DOORS: Record<string, string[]> = {
  'components/communication/shared/useRetieText.ts': ["a text's job", "a text's lead (what a pick in AttachMenu writes to a text)"],
  'components/communication/shared/CommRowJobControl.tsx': ["a call row's job", "a call row's lead", 'a text row (useRetieText)'],
  'components/communication/phone/CallsView.tsx': ["the Calls page drawer: the call's job", "the Calls page drawer: the call's lead"],
  'components/communication/phone/SmsInboxView.tsx': ['each inbox text and the Unrouted "Assign" (useRetieText)'],
};
const ROUTES: Record<string, string[]> = {
  'lib/api/communication.ts': ['useReassignSmsJob', 'useReassignSmsLead'],
  'lib/api/callJob.ts': ['useReassignCallJob', 'useReassignCallLead'],
};
const OLD_MENUS: Record<string, string[]> = {
  'components/communication/shared/CommRowJobControl.tsx': ['an email row: an email has no number, so no customer carries one'],
  'components/communication/shared/LogCommunicationDrawer.tsx': ['the anchor of a hand-logged entry: not a re-tie of a text or a call'],
};

/**
 * Where a screen offers both menus, the channels its `<AttachMenu` branch takes: the channel literals in the condition of the
 * `if` it sits under. A count of `<CommJobMenu` per file cannot see a channel moved from one menu to the other inside the
 * same file; this can.
 */
function channelsSentToAttachMenu(source: string): string[][] {
  const text = code(source);
  const branches: string[][] = [];
  for (const m of text.matchAll(/<AttachMenu\b/g)) {
    const at = text.lastIndexOf('if (', m.index);
    if (at < 0) {
      branches.push([]);
      continue;
    }
    let depth = 0;
    let end = at + 3;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    const condition = text.slice(at + 3, end + 1);
    branches.push([...new Set([...condition.matchAll(/'(sms|call|email|whatsapp)'/g)].map((c) => c[1]!))].sort());
  }
  return branches;
}

function inventory(re: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const n = code(readFileSync(file, 'utf8')).match(re)?.length ?? 0;
    if (n > 0) found[path.relative(SRC, file)] = n;
  }
  return found;
}
const counts = (listed: Record<string, string[]>) => Object.fromEntries(Object.entries(listed).map(([f, why]) => [f, why.length]));

describe('#3024: every text and call re-tie opens "Attach to a lead or job"', () => {
  it('every screen door that re-ties a text or a call is listed', () => {
    expect(inventory(DOOR)).toEqual(counts(DOORS));
  });

  it('every screen with such a door opens AttachMenu', () => {
    for (const file of Object.keys(DOORS).filter((f) => !f.endsWith('useRetieText.ts'))) {
      expect({ file, opensIt: /<AttachMenu\b/.test(code(readFileSync(path.join(SRC, file), 'utf8'))) }).toEqual({ file, opensIt: true });
    }
  });

  it('the re-tie routes are called only by their hooks', () => {
    expect(inventory(ROUTE)).toEqual(counts(ROUTES));
  });

  it('the older menu stays off texts and calls', () => {
    expect(inventory(OLD_MENU)).toEqual(counts(OLD_MENUS));
  });

  it('where a screen offers both menus, texts and calls open AttachMenu, and only the rest the older one', () => {
    const both = Object.keys(OLD_MENUS).filter((f) => /<AttachMenu\b/.test(code(readFileSync(path.join(SRC, f), 'utf8'))));
    expect(Object.fromEntries(both.map((f) => [f, channelsSentToAttachMenu(readFileSync(path.join(SRC, f), 'utf8'))]))).toEqual({
      'components/communication/shared/CommRowJobControl.tsx': [['call', 'sms']],
    });
  });

  it('the scans see what they look for (and not the hooks\' own definitions or comments)', () => {
    expect(channelsSentToAttachMenu([
      "if (item.channel === 'call') {",
      "  // if (item.channel === 'sms') {",
      '  return <AttachMenu target={t} />;',
      '}',
      "if (row.channel === 'sms' || (row.channel === 'call' && open)) return <AttachMenu target={t} />;",
    ].join('\n'))).toEqual([['call'], ['call', 'sms']]);

    const planted = [
      'const a = useReassignSmsLead();',
      'export function useReassignCallJob() {}',
      '// const b = useRetieText();',
      'const c = useRetieText ();',
      'api.patch(`/api/communication/calls/${id}/lead`, {});',
      '<CommJobMenu jobs={[]} />',
    ].join('\n');
    expect(code(planted).match(DOOR)).toHaveLength(2);
    expect(code(planted).match(ROUTE)).toHaveLength(1);
    expect(code(planted).match(OLD_MENU)).toHaveLength(1);
  });
});
