/* =============================================================================
   Roles & Permissions security, re-audit P2-1 (the text and call twins of N9): a phone number or an address resolves to a
   customer, and a signed-in person's request files on and names that customer only when the person can open it.

   A source guard. The raw resolvers (`matchByPhone`, `matchByEmail` in lib/comms-identity.ts) answer for the whole company and
   know nothing of the person asking. Every file that calls one is listed here: either it goes through the reach-aware
   wrapper (lib/communication/phoneMatchInReach.ts), or it has a reason no signed-in person's reach applies. A helper shared
   by a signed-in door and a door with nobody signed in (the text conversation keying in lib/ctm/smsThread.ts) takes the
   resolver from its caller instead of calling one itself (NV-vp3-1, re-audit pass 3). A new caller
   that is neither fails here, so the next door that resolves a number cannot ship without the reach check. The database
   proof for each signed-in door is permission-reaudit-p2-fixes-f-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');

/** The callers of the raw resolvers, and why each may call them. */
const RAW_CALLERS: Readonly<Record<string, string>> = {
  'lib/comms-identity.ts': 'defines the resolvers',
  'lib/communication/phoneMatchInReach.ts': 'the reach-aware wrapper every signed-in door uses',
  'lib/ctm/ingest.ts': 'the phone service webhook: nobody is signed in; an inbound call or text is filed for the company',
  'lib/web-form/process.ts': 'the public web form: nobody is signed in; a lead is filed for the company',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' || name === 'copilot' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** A call of a raw resolver, not a mention in a comment. */
const RAW_CALL = /\bmatchBy(?:Phone|Email)\s*\(/;

describe('a phone number or address resolves to a customer inside the person\'s reach (P2-1)', () => {
  const callers = sourceFiles(SRC)
    .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => {
      const code = line.split('//')[0]!;
      return !code.trim().startsWith('*') && RAW_CALL.test(code);
    }))
    .map((file) => relative(SRC, file))
    .sort();

  it('every caller of the raw resolvers is the wrapper or has a reason', () => {
    expect(callers.filter((f) => !(f in RAW_CALLERS))).toEqual([]);
  });

  it('every listed caller still calls one (the list stays honest)', () => {
    expect(Object.keys(RAW_CALLERS).filter((f) => f !== 'lib/comms-identity.ts' && !callers.includes(f))).toEqual([]);
  });

  it('the controllers resolve numbers through the wrapper', () => {
    for (const file of ['controllers/comm-threads.controller.ts', 'controllers/comm-calls.controller.ts', 'controllers/comm-whatsapp-email.controller.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(/\bmatchByPhoneInReach\s*\(/);
    }
  });
});
