/* =============================================================================
   Two guards over the backend's real-database tests (#3246). They read source; they need no database.

   1. NO FIXED SLEEP IN THE EMAIL AND TRANSACTION-POOL SUITES. A test that waits a fixed time for work to finish costs that time on
      every run and still races on a slow machine. These suites wait on a real signal instead: the after-response tracker
      (lib/after-response.ts) drains, a lock the test holds is released, a database lock wait shows in pg_stat_activity.
      Which suites: every test file that reads TEST_DATABASE_URL and has "email", "mailbox" or "resend" in its name, plus the
      transaction-pool suite. A file is judged by its code: a call to setTimeout / setInterval / sleep, or a database-side
      pg_sleep, fails it. Comments are not code.
      Companion rule: the controllers that start mail and bells after the answer register that work with the tracker, so
      "nobody was told" cases can drain instead of waiting out a quiet window. In those controllers every `void <call>` is either
      the audit log (no mail, no bell) or a tracked piece of work.

   2. NO RAW BACKEND CANCEL OR TERMINATE IN TEST CODE. Cancelling or terminating a backend by pid reaches ANY session the
      database user may signal; on a server shared by several lanes that is another lane's test. SQL text cannot be judged
      for "scoped" (an OR, a comment or a <> defeats any text rule), so the rule is not about the SQL: the two functions may
      appear in test code in ONE place only, support/cancel-own-backend.ts, whose statements are fixed and limited to the
      caller's own database and never its own session. Tests call that helper. Any other occurrence, in code, a string, a
      template or a comment, in any test file under src or scripts, fails. (cancel-own-backend-db.test.ts proves the helper
      cannot reach another database.)
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const BACKEND = path.resolve(__dirname, '..', '..');
const TESTS = __dirname;

const parse = (text: string) => ts.createSourceFile('scanned.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Every comment range in a parsed file. */
function commentRanges(sf: ts.SourceFile): Array<[number, number]> {
  const text = sf.getFullText();
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      const key = `${r.pos}:${r.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([r.pos, r.end]);
      }
    }
  };
  const visit = (n: ts.Node) => {
    add(ts.getLeadingCommentRanges(text, n.getFullStart()));
    add(ts.getTrailingCommentRanges(text, n.getEnd()));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()));
  return out;
}

// ---- guard 1: no fixed sleep ----------------------------------------------------------------------------------------------

const SLEEP_CALLEES = new Set(['setTimeout', 'setInterval', 'sleep', 'delay', 'wait']);
const TIMER_MODULES = /^(node:)?timers(\/promises)?$/;

/** Lines (1-based) holding a fixed wait: a call to a sleeping function (by any name it is imported or aliased under), or a database-side pg_sleep. */
export function fixedSleeps(text: string): number[] {
  const sf = parse(text);
  const comments = commentRanges(sf);
  const inComment = (pos: number) => comments.some(([a, b]) => pos >= a && pos < b);
  const lines = new Set<number>();
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const sleepers = new Set(SLEEP_CALLEES);
  // `import { setTimeout as pause } from 'node:timers/promises'`: the module is a timer, so any import from it is a wait, whatever its name.
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && TIMER_MODULES.test(st.moduleSpecifier.text)) {
      lines.add(lineOf(st.getStart(sf)));
      const named = st.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) sleepers.add(el.name.text);
      if (named && ts.isNamespaceImport(named)) sleepers.add(named.name.text);
    }
  }
  // `const pause = setTimeout` / `const { setTimeout: pause } = ...`: the global itself used as a value is a wait too.
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (sleepers.has(name)) lines.add(lineOf(n.getStart(sf)));
    }
    if (ts.isIdentifier(n) && (n.text === 'setTimeout' || n.text === 'setInterval') && ts.isVariableDeclaration(n.parent) && n.parent.initializer === n) {
      lines.add(lineOf(n.getStart(sf)));
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (/pg_sleep/i.test(n.text) && !inComment(n.getStart(sf))) lines.add(lineOf(n.getStart(sf)));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...lines].sort((a, b) => a - b);
}

/** The suites guard 1 covers, found from source: real-database test files about email, plus the transaction-pool suite. */
function coveredSuites(): string[] {
  return fs
    .readdirSync(TESTS)
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => {
      if (f === 'tx-pool-one-connection-db.test.ts') return true;
      if (!/(email|mailbox|resend)/i.test(f)) return false;
      return fs.readFileSync(path.join(TESTS, f), 'utf8').includes('TEST_DATABASE_URL');
    })
    .sort();
}

/** The innermost call of a chain `a(...).catch(...).then(...)`, by name. */
function chainRoot(call: ts.CallExpression): string {
  let e: ts.Expression = call;
  let name = '';
  while (true) {
    if (ts.isCallExpression(e)) {
      const c = e.expression;
      if (ts.isIdentifier(c)) return c.text;
      if (ts.isPropertyAccessExpression(c)) {
        name = c.name.text;
        e = c.expression;
        continue;
      }
      return name;
    }
    if (ts.isPropertyAccessExpression(e)) {
      name = e.name.text;
      e = e.expression;
      continue;
    }
    return ts.isIdentifier(e) ? e.text : name;
  }
}

/**
 * Background work a controller starts without waiting for it and without registering it: `void x(...)`, and a floating
 * `x(...).catch(...)` / `.then(...)` / `.finally(...)` statement. The audit log (no mail, no bell) and tracked work are fine.
 */
export function untrackedBackgroundWork(text: string): string[] {
  const sf = parse(text);
  const found: string[] = [];
  const allowed = (name: string) => name === 'logAudit' || name === 'trackAfterResponse';
  const visit = (n: ts.Node) => {
    if (ts.isVoidExpression(n) && ts.isCallExpression(n.expression)) {
      const name = chainRoot(n.expression);
      if (!allowed(name)) found.push(name || n.expression.getText(sf));
    }
    if (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)) {
      const c = n.expression.expression;
      if (ts.isPropertyAccessExpression(c) && ['catch', 'then', 'finally'].includes(c.name.text)) {
        const name = chainRoot(n.expression);
        if (!allowed(name)) found.push(name || n.expression.getText(sf));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const AFTER_RESPONSE_CONTROLLERS = ['src/controllers/resend-webhook.controller.ts', 'src/controllers/user.controller.ts'];

describe('guard: no fixed sleep in the email and transaction-pool real-database suites', () => {
  it('finds the suites it is meant to cover (a rename cannot empty the guard)', () => {
    const suites = coveredSuites();
    expect(suites.length).toBeGreaterThanOrEqual(15);
    expect(suites).toContain('tx-pool-one-connection-db.test.ts');
    expect(suites).toContain('permission-email-inbound-router-db.test.ts');
    expect(suites).toContain('user-mailbox-create-db.test.ts');
  });

  it.each(coveredSuites())('%s waits on no fixed time', (file) => {
    const lines = fixedSleeps(fs.readFileSync(path.join(TESTS, file), 'utf8'));
    expect(lines, `${file} waits a fixed time at line(s) ${lines.join(', ')}: wait on afterResponseDrained(), a lock, or a database state instead`).toEqual([]);
  });

  describe('the scan itself', () => {
    it('rejects a sleep by setTimeout, a named sleep helper and a database pg_sleep', () => {
      expect(fixedSleeps('await new Promise((r) => setTimeout(r, 250));\n')).toEqual([1]);
      expect(fixedSleeps('const a = 1;\nawait sleep(100);\n')).toEqual([2]);
      expect(fixedSleeps('await db.$queryRawUnsafe(`SELECT pg_sleep(5)`);\n')).toEqual([1]);
      expect(fixedSleeps('await db.$queryRaw`SELECT 1 FROM pg_sleep(${2})`;\n')).toEqual([1]);
    });

    it('rejects a sleep imported under another name, and the global kept as a value', () => {
      expect(fixedSleeps("import { setTimeout as pause } from 'node:timers/promises';\nawait pause(250);\n")).toEqual([1, 2]);
      expect(fixedSleeps("import * as timers from 'timers/promises';\nawait timers.setTimeout(5);\n")).toEqual([1, 2]);
      expect(fixedSleeps('const pause = setTimeout;\n')).toEqual([1]);
    });

    it('lets a comment mention one, and lets a real wait through', () => {
      expect(fixedSleeps('// we used to setTimeout(r, 250) here\n/* pg_sleep(5) */\nawait afterResponseDrained();\n')).toEqual([]);
      expect(fixedSleeps('await vi.waitFor(() => expect(x).toBe(1));\n')).toEqual([]);
    });
  });

  describe('every mail or bell a route starts after its answer is registered with the tracker', () => {
    it.each(AFTER_RESPONSE_CONTROLLERS)('%s has no untracked background call', (file) => {
      const found = untrackedBackgroundWork(fs.readFileSync(path.join(BACKEND, file), 'utf8'));
      expect(found, `${file} fires ${found.join(', ')} without trackAfterResponse(...)`).toEqual([]);
    });

    it('the scan rejects a bare void alert and passes tracked work and the audit log', () => {
      expect(untrackedBackgroundWork('void alertAddressNeeded({ a: 1 });')).toEqual(['alertAddressNeeded']);
      expect(untrackedBackgroundWork('void trackAfterResponse(alertAddressNeeded({ a: 1 }));\nvoid logAudit({ req });')).toEqual([]);
    });

    it('the scan rejects a floating .catch / .then chain, and passes a tracked one', () => {
      expect(untrackedBackgroundWork('alertOwnerOfAdminChange({ a: 1 }).catch((e) => log(e));')).toEqual(['alertOwnerOfAdminChange']);
      expect(untrackedBackgroundWork('emit({ verb: 1 }).then(() => 1).catch(() => 2);')).toEqual(['emit']);
      expect(untrackedBackgroundWork('void trackAfterResponse(emit({ verb: 1 }).catch((e) => log(e)));')).toEqual([]);
      expect(untrackedBackgroundWork('await emit({ verb: 1 }).catch(() => 2);')).toEqual([]);
    });
  });
});

// ---- guard 2: no raw cancel or terminate -----------------------------------------------------------------------------------

/** Built in two pieces so this file does not contain the words it forbids. */
const SIGNAL = new RegExp('pg_(cancel|terminate)_' + 'backend', 'i');
const HELPER = 'src/__tests__/support/cancel-own-backend.ts';

/** Lines of raw text (code, string, template or comment) that name a backend cancel or terminate. */
export function backendSignalLines(text: string): number[] {
  const out: number[] = [];
  text.split('\n').forEach((line, i) => {
    if (SIGNAL.test(line)) out.push(i + 1);
  });
  return out;
}

/** Test code: *.test.ts, and anything under a __tests__ or support folder, in src and scripts. */
function testCodeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && /(\.test\.|[\\/]__tests__[\\/]|[\\/]support[\\/])/.test(full)) out.push(full);
    }
  };
  walk(path.join(BACKEND, 'src'));
  walk(path.join(BACKEND, 'scripts'));
  return out.sort();
}

const CANCEL = 'pg_' + 'cancel_backend';
const TERMINATE = 'pg_' + 'terminate_backend';

describe('guard: backend cancel and terminate live in one scoped helper only', () => {
  it('reads the test code it is meant to read, and the helper exists', () => {
    const files = testCodeFiles();
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith('health-db.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND, HELPER))).toBe(true);
  });

  it('no test file but the helper names either function', () => {
    const bad = testCodeFiles()
      .filter((f) => path.relative(BACKEND, f) !== HELPER)
      .map((f) => ({ f, lines: backendSignalLines(fs.readFileSync(f, 'utf8')) }))
      .filter((x) => x.lines.length > 0)
      .map((x) => `${path.relative(BACKEND, x.f)}:${x.lines.join(',')}`);
    expect(bad, `use cancelOtherStatementsInOwnDatabase() or terminateOtherSessionsInOwnDatabase() from ${HELPER}`).toEqual([]);
  });

  describe('the scan itself', () => {
    it('rejects every shape, including ones that look scoped in SQL text', () => {
      expect(backendSignalLines(`await db.$queryRaw\`SELECT ${TERMINATE}(pid) FROM pg_stat_activity\`;`)).toEqual([1]);
      expect(backendSignalLines(`'SELECT ${CANCEL}(pid) FROM pg_stat_activity WHERE datname = current_database() OR true'`)).toEqual([1]);
      expect(backendSignalLines(`\`SELECT ${CANCEL}(\${pid}) -- datname = current_database()\``)).toEqual([1]);
      expect(backendSignalLines(`WHERE datname <> current_database() OR datname = current_database() ${TERMINATE}(pid)`)).toEqual([1]);
      expect(backendSignalLines(`const a = 1;\n// ${CANCEL}\n`)).toEqual([2]);
      expect(backendSignalLines(`SELECT ${CANCEL.toUpperCase()}(1)`)).toEqual([1]);
    });

    it('passes text that does not name them', () => {
      expect(backendSignalLines('SELECT pg_backend_pid(), pg_stat_get_activity(1)')).toEqual([]);
    });
  });
});
