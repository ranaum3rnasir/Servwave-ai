// Guard: no frontend test sleeps on a real timer, and none proves absence with a rejected `findBy`.
//
// Why: a test that waits out a real clock spends its time doing nothing, and its margin is the
// clock, so it is the first to time out on a loaded machine. An absence check written as
// `await screen.findByX().catch(...)` burns the whole wait limit before it can "pass".
//
// The rules (also in docs/ci.md). The scan walks each file's syntax tree (TypeScript compiler API), so
// callbacks, line breaks and `;` inside a call do not matter:
//   1. No real timer over 100 ms. A call to setTimeout / setInterval (bare, `window.` or `globalThis.`)
//      whose delay is over 100, or a call `name(N)` to a sleep helper with N over 100, or a
//      `retryDelay: N` option over 100, fails. The number is a literal or an identifier bound to a
//      numeric `const` in the same file. A sleep helper is sleep / wait / pause, or any function
//      defined in the file, or in a shared test-support file, whose body calls setTimeout /
//      setInterval (so `advance(5000)` over a real timer is caught).
//      Fake timers exempt a call only where they are active: `vi.useFakeTimers()` with no `toFake`, or
//      one naming setTimeout (`toFake: ['Date']` does not count). Active means: inside the same it()/
//      test() that installs them; or, when installed in a beforeEach/beforeAll or directly in a
//      describe, throughout that describe (the whole file at top level). A sibling describe is not
//      covered.
//   2. Never prove absence with a rejected `findBy` / `findAllBy`: not `.catch(` or `.then(a, b)`
//      chained on it, not `expect(findBy...).rejects`, not a `try { ... findBy ... } catch`. Wait for
//      something that DOES appear, then use `queryBy`.
// Limits: a delay held in a computed value, or a helper imported from outside the support files, is
// not seen; review catches those.
//
// Source-driven: every test file under src/, and the shared test-support files, are scanned, so a new
// one is covered with no list to edit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAX_REAL_SLEEP_MS = 100;
const TIMER_FNS = new Set(['setTimeout', 'setInterval']);
const SCOPE_CALLS = new Set(['it', 'test', 'describe', 'beforeEach', 'beforeAll']);

const parse = (text: string) => ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const calleeName = (call: ts.CallExpression): string | undefined => {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
};
/** `setTimeout(...)`, `window.setTimeout(...)` or `globalThis.setTimeout(...)`. */
const isTimerCall = (n: ts.Node): n is ts.CallExpression => {
  if (!ts.isCallExpression(n)) return false;
  const c = n.expression;
  if (ts.isIdentifier(c)) return TIMER_FNS.has(c.text);
  return ts.isPropertyAccessExpression(c) && TIMER_FNS.has(c.name.text) && ts.isIdentifier(c.expression) && ['window', 'globalThis', 'self', 'global'].includes(c.expression.text);
};
/** The leftmost identifier of a callee: `it.each(x)` and `it.skip` both give `it`. */
const rootName = (e: ts.Expression): string | undefined => {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return rootName(e.expression);
  if (ts.isCallExpression(e)) return rootName(e.expression);
  return undefined;
};
const containsTimerCall = (node: ts.Node): boolean => {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (isTimerCall(n)) hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
};

/** Which argument of a sleep helper is the timer's delay, and its default when the call leaves it out. */
export type HelperInfo = { index: number; dflt?: number };

/** Functions in `text` whose body calls a real timer, with the parameter that carries the delay. */
export function timerHelpers(text: string): Map<string, HelperInfo> {
  const found = new Map<string, HelperInfo>();
  const describeFn = (name: string, fn: ts.SignatureDeclaration & { body?: ts.Node }) => {
    if (!fn.body || !containsTimerCall(fn.body)) return;
    // -1: the delay is not one of its parameters (a fixed delay is checked where the timer is called).
    let info: HelperInfo = { index: -1 };
    const look = (n: ts.Node) => {
      if (isTimerCall(n) && n.arguments[1] && ts.isIdentifier(n.arguments[1])) {
        const at = fn.parameters.findIndex((q) => ts.isIdentifier(q.name) && q.name.text === (n.arguments[1] as ts.Identifier).text);
        if (at >= 0) {
          const init = fn.parameters[at]!.initializer;
          info = { index: at, dflt: init && ts.isNumericLiteral(init) ? Number(init.text.replace(/_/g, '')) : undefined };
        }
      }
      ts.forEachChild(n, look);
    };
    look(fn.body);
    found.set(name, info);
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) describeFn(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      describeFn(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(text));
  return found;
}

/** Violations in one file's text, as "line: reason" strings. `sharedHelpers`: sleep helpers from the support files. */
export function findSleepers(text: string, sharedHelpers: ReadonlyMap<string, HelperInfo> = new Map()): string[] {
  const sf = parse(text);
  const found: string[] = [];
  const report = (node: ts.Node, reason: string) => found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${reason}`);

  // Numeric constants and sleep helpers.
  const consts = new Map<string, number>();
  const helpers = new Map<string, HelperInfo>([['sleep', { index: 0 }], ['wait', { index: 0 }], ['pause', { index: 0 }], ...sharedHelpers, ...timerHelpers(text)]);
  const literal = (e: ts.Expression): number | undefined => {
    if (ts.isNumericLiteral(e)) return Number(e.text.replace(/_/g, ''));
    if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) return literal(e.expression);
    return undefined;
  };
  const collect = (n: ts.Node) => {
    // Only `const` is a constant: a `let` or `var` can be reassigned, so its initializer says nothing.
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0) {
      const v = literal(n.initializer);
      if (v !== undefined) consts.set(n.name.text, v);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const valueOf = (e: ts.Expression | undefined): number | undefined => {
    if (!e) return undefined;
    const v = literal(e);
    if (v !== undefined) return v;
    return ts.isIdentifier(e) ? consts.get(e.text) : undefined;
  };

  // Where fake timers that cover setTimeout are active.
  const fakeScopes: Array<[number, number]> = [];
  const coversTimeout = (call: ts.CallExpression) => {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return true;
    const toFake = arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'toFake') as ts.PropertyAssignment | undefined;
    return !toFake || /setTimeout/.test(toFake.initializer.getText(sf));
  };
  const scopeCallOf = (from: ts.Node, names: string[]): ts.CallExpression | undefined => {
    for (let a: ts.Node | undefined = from.parent; a; a = a.parent) {
      if (ts.isCallExpression(a)) {
        const r = rootName(a.expression);
        if (r && names.includes(r)) return a;
      }
    }
    return undefined;
  };
  const findFake = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'useFakeTimers' && coversTimeout(n)) {
      const owner = scopeCallOf(n, [...SCOPE_CALLS]);
      const root = owner ? rootName(owner.expression) : undefined;
      let scope: ts.Node = sf;
      if (owner && (root === 'it' || root === 'test' || root === 'describe')) scope = owner;
      else if (owner) scope = scopeCallOf(owner, ['describe']) ?? sf; // a beforeEach/beforeAll: its describe
      // Installed inside a plain helper function (no it/describe/hook around it): no exemption, so a
      // sleep in the tests that call it is flagged rather than hidden.
      const inHelper = !owner && (() => { for (let a: ts.Node | undefined = n.parent; a; a = a.parent) if (ts.isFunctionLike(a)) return true; return false; })();
      if (!inHelper) fakeScopes.push([scope.getStart(sf), scope.getEnd()]);
    }
    ts.forEachChild(n, findFake);
  };
  findFake(sf);
  const fakeAt = (n: ts.Node) => fakeScopes.some(([a, b]) => n.getStart(sf) >= a && n.getEnd() <= b);

  const ownParam = (e: ts.Expression, from: ts.Node) => {
    if (!ts.isIdentifier(e)) return false;
    for (let a: ts.Node | undefined = from.parent; a; a = a.parent) {
      if (ts.isFunctionLike(a) && a.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === (e as ts.Identifier).text)) return true;
    }
    return false;
  };
  /** Fail closed: a delay is fine only as a number <= 100, a const that resolves to one, or the wrapping helper's own parameter. */
  const checkDelay = (call: ts.CallExpression, arg: ts.Expression | undefined, dflt: number | undefined, label: string) => {
    if (fakeAt(call)) return;
    if (!arg) {
      if (dflt !== undefined && dflt > MAX_REAL_SLEEP_MS) report(call, `${label} with its default ${dflt} ms`);
      return;
    }
    const ms = valueOf(arg);
    if (ms !== undefined) {
      if (ms > MAX_REAL_SLEEP_MS) report(call, `${label}: ${arg.getText(sf)} ms`);
    } else if (!ownParam(arg, call)) {
      report(call, `${label}: delay ${arg.getText(sf)} is not a number or a const (a let, a computed value), so it cannot be shown to be 100 ms or less`);
    }
  };

  const isFind = (name: string | undefined) => !!name && /^find(All)?By/.test(name);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      if (isTimerCall(n)) {
        if (n.arguments[1]) checkDelay(n, n.arguments[1], undefined, `real ${n.expression.getText(sf)}`);
      } else if (ts.isIdentifier(n.expression) && helpers.has(n.expression.text)) {
        const info = helpers.get(n.expression.text)!;
        if (info.index >= 0) checkDelay(n, n.arguments[info.index], info.dflt, `${n.expression.text}() sleeps on a real timer`);
      }
      const name = calleeName(n);
      if (isFind(name)) {
        const p = n.parent;
        const outer = p?.parent;
        if (p && ts.isPropertyAccessExpression(p) && p.expression === n && outer && ts.isCallExpression(outer) && outer.expression === p) {
          if (p.name.text === 'catch' || (p.name.text === 'then' && outer.arguments.length >= 2)) report(n, `absence proved by a rejected ${name}`);
        }
        if (p && ts.isCallExpression(p) && rootName(p.expression) === 'expect' && p.parent && ts.isPropertyAccessExpression(p.parent) && p.parent.name.text === 'rejects') {
          report(n, `absence proved by expect(${name}).rejects`);
        }
        for (let a: ts.Node | undefined = n.parent, child: ts.Node = n; a && !ts.isFunctionLike(a); child = a, a = a.parent) {
          if (ts.isTryStatement(a) && a.tryBlock === child && a.catchClause) {
            report(n, `absence proved by a try/catch around ${name}`);
            break;
          }
        }
      }
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'retryDelay') {
      const ms = valueOf(n.initializer);
      if (ms !== undefined && ms > MAX_REAL_SLEEP_MS && !fakeAt(n)) report(n, `retryDelay of ${ms} ms is a real wait`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const isTest = (name: string) => /\.test\.tsx?$/.test(name) && !name.endsWith('no-real-timer-sleeps.test.ts');
const isSupport = (path: string) => /__tests__\/support\/|[\\/]helpers\.tsx$|[\\/]test-utils[^\\/]*$/.test(path) && /\.tsx?$/.test(path);

function walk(dir: string, keep: (path: string, name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(path, name) ? [path] : [];
  });
}

describe('the sleeper scan itself', () => {
  const real = (src: string) => findSleepers(src);

  it('flags a real timer over 100 ms, however it is spelled', () => {
    expect(real('await new Promise((r) => setTimeout(r, 400));')).toHaveLength(1);
    expect(real('const settle = () => new Promise((r) => setTimeout(r, 1_500));')).toHaveLength(1);
    expect(real('await sleep(250);')).toHaveLength(1);
    expect(real('await wait(101);')).toHaveLength(1);
    expect(real('await pause(1000);')).toHaveLength(1);
  });

  it('flags a delay held in a same-file constant', () => {
    expect(real('const DELAY = 500;\nawait new Promise((r) => setTimeout(r, DELAY));')).toHaveLength(1);
    expect(real('const STEP = 5_000;\nawait sleep(STEP);')).toHaveLength(1);
    expect(real('const SHORT = 50;\nawait new Promise((r) => setTimeout(r, SHORT));')).toEqual([]);
  });

  it('flags a helper defined in the file over a real setTimeout, whatever it is called', () => {
    const helper = 'async function advance(ms: number) {\n  await new Promise((r) => setTimeout(r, ms));\n}\n';
    expect(real(`${helper}await advance(5000);`)).toHaveLength(1);
    expect(real('const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));\nawait nap(300);')).toHaveLength(1);
    expect(real(`${helper}await advance(50);`)).toEqual([]);
    // A helper that does not wrap a timer is not a sleeper.
    expect(real('const advance = (n: number) => n + 1;\nadvance(5000);')).toEqual([]);
  });

  it('lets a short tick, a delay passed in, and a method named flush through', () => {
    expect(real('await new Promise((r) => setTimeout(r, 100));')).toEqual([]);
    expect(real('await new Promise((r) => setTimeout(r, 20));')).toEqual([]);
    expect(real('const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));')).toEqual([]);
    expect(real('await Sentry.flush(2000); await obj.wait(500);')).toEqual([]);
  });

  it('exempts fake timers only where they are active', () => {
    const fakeInHook = "beforeEach(() => { vi.useFakeTimers(); });\nit('a', async () => { await new Promise((r) => setTimeout(r, 5000)); });";
    expect(real(fakeInHook)).toEqual([]);
    const fakeInOneTest =
      "it('a', async () => { vi.useFakeTimers(); await new Promise((r) => setTimeout(r, 5000)); });\n" +
      "it('b', async () => { await new Promise((r) => setTimeout(r, 2000)); });";
    expect(real(fakeInOneTest)).toHaveLength(1);
    expect(real(fakeInOneTest)[0]).toContain('2000');
    expect(real("beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });\nit('a', async () => { await sleep(500); });")).toHaveLength(1);
    expect(real("beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); });\nit('a', async () => { await sleep(500); });")).toEqual([]);
  });

  it('flags absence proved by a rejected findBy, in every spelling', () => {
    expect(real("await screen.findByText('x').catch(() => null);")).toHaveLength(1);
    expect(real("await screen.findAllByRole('row', {}, { timeout: 10 })\n  .catch(async () => {});")).toHaveLength(1);
    expect(real("await screen.findByText(fn(a)).catch(() => 1);")).toHaveLength(1);
    expect(real("await screen.findByText('x', {}, { timeout: 5 }).then(() => { throw new Error('there'); }, () => {});")).toHaveLength(1);
    expect(real("await expect(screen.findByText('x')).rejects.toThrow();")).toHaveLength(1);
    expect(real("await expect(screen.findByRole('heading', { name: re }, { timeout: 600 }), path).rejects.toThrow();")).toHaveLength(1);
    expect(real("try {\n  await screen.findByText('x');\n} catch {\n  // absent\n}")).toHaveLength(1);
  });

  it('lets a findBy that is awaited normally, or a catch on something else, through', () => {
    expect(real("await screen.findByText('x');")).toEqual([]);
    expect(real("await session.fetchClientSecret().catch(() => undefined);")).toEqual([]);
    expect(real("expect(screen.queryByText('x')).toBeNull();")).toEqual([]);
    expect(real("try { await other(); } catch {}\nawait screen.findByText('x');")).toEqual([]);
  });
});


describe('the sleeper scan fails closed', () => {
  const real = (src: string) => findSleepers(src);

  it('flags a delay held in a let, however it is assigned', () => {
    expect(real('let x = 0;\nx = 400;\nsetTimeout(r, x);')).toHaveLength(1);
    expect(real('let leadsDelay: number;\nleadsDelay = 400;\nsetTimeout(r, leadsDelay);')).toHaveLength(1);
    expect(real('const d = 400;\nsetTimeout(r, d);')).toHaveLength(1);
    expect(real('const d = 40;\nsetTimeout(r, d);')).toEqual([]);
  });

  it('flags a computed delay, and lets the wrapping helper pass its own parameter on', () => {
    expect(real('setTimeout(r, state.wait);')).toHaveLength(1);
    expect(real('const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));')).toEqual([]);
    expect(real('function nap(ms: number) { return new Promise((r) => setTimeout(r, ms)); }')).toEqual([]);
  });

  it('reads the argument that is the delay, and a default parameter', () => {
    const second = 'const nap = (label: string, ms: number) => new Promise((r) => setTimeout(r, ms));\n';
    expect(real(`${second}await nap('a', 500);`)).toHaveLength(1);
    expect(real(`${second}await nap('a', 50);`)).toEqual([]);
    const dflt = 'const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));\n';
    expect(real(`${dflt}await settle();`)).toHaveLength(1);
    expect(real(`${dflt}await settle(20);`)).toEqual([]);
  });

  it('does not let fake timers installed inside a plain helper exempt the file', () => {
    const src = "function install() { vi.useFakeTimers(); }\nit('a', async () => { install(); await sleep(900); });";
    expect(real(src)).toHaveLength(1);
  });
});

describe('the sleeper scan reads syntax, not text', () => {
  const real = (src: string) => findSleepers(src);

  it('sees a timer callback with statements and line breaks', () => {
    expect(real('setTimeout(() => { a(); b(); }, 300);')).toHaveLength(1);
    expect(real('setTimeout(() => {\n  resolve();\n  done();\n}, 700);')).toHaveLength(1);
    expect(real('window.setTimeout(r, 400); globalThis.setTimeout(r, 400); setInterval(r, 500);')).toHaveLength(3);
    expect(real('setTimeout(() => { a(); b(); }, 30);')).toEqual([]);
  });

  it('sees a real retry delay, and lets a small one through', () => {
    expect(real('fetchQuery({ queryKey: [1], retryDelay: 400 });')).toHaveLength(1);
    expect(real('fetchQuery({ queryKey: [1], retryDelay: 0 });')).toEqual([]);
  });

  it('does not let one describe\'s fake timers cover its sibling', () => {
    const src =
      "describe('A', () => {\n  beforeEach(() => { vi.useFakeTimers(); });\n  it('x', async () => { await sleep(5000); });\n});\n" +
      "describe('B', () => {\n  it('y', async () => { await new Promise((r) => setTimeout(r, 2000)); });\n});";
    const found = real(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('2000');
  });

  it('sees a sleep helper that comes from a shared support file', () => {
    const shared = timerHelpers('export const napFor = (ms: number) => new Promise((r) => setTimeout(r, ms));');
    expect([...shared.keys()]).toEqual(['napFor']);
    expect(findSleepers('await napFor(900);', shared)).toHaveLength(1);
  });
});

describe('no frontend test sleeps on a real timer or proves absence with a rejected findBy', () => {
  it('finds no offender in any test file or shared test-support file under src/', () => {
    const root = join(process.cwd(), 'src');
    const supportFiles = walk(root, (path) => isSupport(path) && !isTest(path));
    const shared = new Map(supportFiles.flatMap((f) => [...timerHelpers(readFileSync(f, 'utf8'))]));
    const files = [...walk(root, (_path, name) => isTest(name)), ...supportFiles];
    const offenders = files.flatMap((file) =>
      findSleepers(readFileSync(file, 'utf8'), shared).map((v) => `${file.slice(root.length + 1)}:${v}`),
    );
    expect(offenders, 'see docs/ci.md, "Frontend tests: no real sleeps"').toEqual([]);
  });
});
