/* =============================================================================
   #3024 - every door through which a person re-ties a text or a call to a lead or job asks the one rule (attachTargets.ts:
   the leads and jobs of the customers carrying its number, or any when none carries it), so a new door cannot be missed.

   Source-driven: every write of a text or a call in the controllers (the screens' doors), by the Prisma client of any name or
   by raw SQL, schema-qualified too, is listed here with what it is; each one listed as a re-tie must sit in a handler that asks
   `tieAllowed`, and each re-tie route and menu route must carry the Attach switch.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');
const RE_TIE = 're-tie (asks tieAllowed)';

/** Every write of a text or a call in a controller, per file, by the handler it sits in. */
const WRITES: Record<string, Record<string, string>> = {
  'controllers/comm-threads.controller.ts': {
    reassignMessageJob: RE_TIE,
    reassignMessageLead: RE_TIE,
  },
  'controllers/comm-calls.controller.ts': {
    getCallTranscript: 'not a re-tie: stores a fetched transcript and summary',
    reassignCallJob: RE_TIE,
    reassignCallLead: RE_TIE,
  },
};

/** The routes of the re-tie doors and of the menu, each with its handler. */
const ROUTES: Record<string, string[]> = {
  'routes/comm-threads.routes.ts': [
    "patch /sms/:id/job -> reassignMessageJob",
    "patch /sms/:id/lead -> reassignMessageLead",
    "get /sms/:id/attach-targets -> messageAttachTargets",
  ],
  'routes/comm-calls.routes.ts': [
    "patch /calls/:id/job -> reassignCallJob",
    "patch /calls/:id/lead -> reassignCallLead",
    "get /calls/:id/attach-targets -> callAttachTargets",
  ],
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === '__tests__' ? [] : filesUnder(join(dir, e.name))) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

/** The text and call writes in a source, each named by the exported handler (or function) it sits in. */
function writesIn(text: string): string[] {
  const write = /\.(message|callSession)\s*\.\s*(update|updateMany|upsert)\s*\(|\$executeRaw(?:Unsafe)?\s*[`(][^;]*?\bUPDATE\s+(?:"?public"?\s*\.\s*)?"?(messages|call_sessions)\b/g;
  const out: string[] = [];
  for (const m of text.matchAll(write)) {
    const before = text.slice(0, m.index);
    const fns = [...before.matchAll(/(?:export\s+)?async\s+function\s+(\w+)|(?:export\s+)?function\s+(\w+)/g)];
    const last = fns[fns.length - 1];
    out.push(last ? (last[1] ?? last[2])! : '(top level)');
  }
  return out;
}

/** A handler's body: from its declaration to the next top-level function. */
function bodyOf(text: string, name: string): string {
  const start = text.search(new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\b`));
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The routes a routes file declares: "method path -> handler", with the guards it asks for. */
function routesIn(text: string): { key: string; attach: boolean }[] {
  return [...text.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'([^;]*)\);/g)].map((m) => {
    const handlers = [...m[3]!.matchAll(/\w+Controller\.(\w+)/g)];
    return { key: `${m[1]} ${m[2]} -> ${handlers[handlers.length - 1]?.[1]}`, attach: /canDo\('attach',\s*'Communication'\)/.test(m[3]!) };
  });
}

describe('#3024: every door that re-ties a text or a call asks the one rule', () => {
  it('every write of a text or a call in a controller is listed, and nothing listed is missing', () => {
    const found: Record<string, Record<string, number>> = {};
    for (const file of filesUnder(join(SRC, 'controllers'))) {
      const writes = writesIn(readFileSync(file, 'utf8'));
      if (writes.length === 0) continue;
      const rel = relative(SRC, file);
      found[rel] = {};
      for (const w of writes) found[rel]![w] = (found[rel]![w] ?? 0) + 1;
    }
    const listed = Object.fromEntries(Object.entries(WRITES).map(([f, fns]) => [f, Object.fromEntries(Object.keys(fns).map((k) => [k, 1]))]));
    expect(found).toEqual(listed);
  });

  it('every re-tie asks tieAllowed, for the job and the lead alike', () => {
    for (const [file, fns] of Object.entries(WRITES)) {
      const text = readFileSync(join(SRC, file), 'utf8');
      for (const [fn, what] of Object.entries(fns)) {
        if (what !== RE_TIE) continue;
        expect({ fn, asks: /\btieAllowed\(/.test(bodyOf(text, fn)) }).toEqual({ fn, asks: true });
      }
    }
  });

  it('the re-tie routes and the menu routes are exactly these, each behind the Attach switch', () => {
    for (const [file, wanted] of Object.entries(ROUTES)) {
      const routes = routesIn(readFileSync(join(SRC, file), 'utf8'))
        .filter((r) => /\/:id\/(job|lead|attach-targets) ->/.test(r.key));
      expect(routes.map((r) => r.key).sort()).toEqual([...wanted].sort());
      expect(routes.filter((r) => !r.attach).map((r) => r.key)).toEqual([]);
    }
  });

  it('the menu reads ask the same rule as the doors', () => {
    const threads = readFileSync(join(SRC, 'controllers/comm-threads.controller.ts'), 'utf8');
    const calls = readFileSync(join(SRC, 'controllers/comm-calls.controller.ts'), 'utf8');
    expect(/textTieRuleForReq\(/.test(bodyOf(threads, 'messageAttachTargets'))).toBe(true);
    expect(/callTieRuleForReq\(/.test(bodyOf(calls, 'callAttachTargets'))).toBe(true);
  });

  describe('the scan itself', () => {
    it('sees a write by any client name, raw SQL schema-qualified, and the handler it sits in', () => {
      const planted = [
        'export async function one(req) { await tx.message.updateMany({ where }); }',
        'async function two() { await db.callSession.update({ where: { id }, data }); }',
        'export async function three() { await prisma.$executeRawUnsafe(`UPDATE "public"."messages" SET job_id = NULL`); }',
        'export async function four() { await prisma.$executeRaw`UPDATE public.call_sessions SET lead_id = NULL`; }',
      ].join('\n');
      expect(writesIn(planted)).toEqual(['one', 'two', 'three', 'four']);
      expect(bodyOf(planted, 'two')).toContain('callSession.update');
      expect(bodyOf(planted, 'two')).not.toContain('messages');
    });

    it('reads a route, its handler and whether it carries the Attach switch', () => {
      const planted = "router.patch('/sms/:id/job', canDo('attach', 'Communication'), messageId, commController.reassignMessageJob);\n"
        + "router.get('/sms/:id/attach-targets', canDo('read', 'Communication'), commController.messageAttachTargets);";
      expect(routesIn(planted)).toEqual([
        { key: 'patch /sms/:id/job -> reassignMessageJob', attach: true },
        { key: 'get /sms/:id/attach-targets -> messageAttachTargets', attach: false },
      ]);
    });
  });
});
