/* =============================================================================
   Guard (#3237): the suites that use the shared permission-switches fixture send every request to a
   listener on 127.0.0.1, never through supertest's per-request wildcard listener (see loopback-app.ts
   for the trap). Static: it parses each suite with the TypeScript compiler and needs no database.

   Every call of the supertest default import (`request(x)`, `supertest(x)`, `request.agent(x)`, under
   whatever local name it was imported) must be handed a loopback listener: the fixture's `listener()`
   or `listenOnLoopback(...)`, directly or through a variable / small loader function bound to one.
   Anything else (the imported app, `import('../app.js')` default or destructured, `fx.app`, an unknown
   name) is the wildcard form and fails.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const dir = __dirname;
const FIXTURE = 'permission-switches-fixture.ts';
const SELF = 'permission-fixture-loopback-guard.test.ts';

const strip = (n: ts.Node): ts.Node => {
  let x = n;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isAwaitExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  return x;
};

/** The scopes (nearest first) that enclose a node. */
function scopesOf(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isFunctionLike(p) || ts.isModuleBlock(p) || ts.isCaseClause(p)) out.push(p);
  }
  return out;
}

/** Every expression a name is given in this scope: its declarations and its plain assignments. null = declared without a value we can see. */
function bindingsIn(scope: ts.Node, name: string): { found: boolean; values: ts.Node[] } {
  let found = false;
  const values: ts.Node[] = [];
  const visit = (n: ts.Node, top: boolean) => {
    if (!top && ts.isFunctionLike(n) && n !== scope) {
      // a nested function's own parameters/locals are its scope; assignments inside it still bind the outer name
      if (n.parameters?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return;
    }
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name) && n.name.text === name && declaredDirectlyIn(n, scope)) { found = true; if (n.initializer) values.push(n.initializer); }
      else if (ts.isObjectBindingPattern(n.name) && declaredDirectlyIn(n, scope) && n.name.elements.some((e) => ts.isIdentifier(e.name) && e.name.text === name)) {
        found = true; values.push(n.initializer ?? n); // destructured: the value is unknown, so it is never a listener
      }
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === name && n.parent === scope) { found = true; values.push(n); }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name) values.push(n.right);
    ts.forEachChild(n, (c) => visit(c, false));
  };
  visit(scope, true);
  return { found, values };
}

function declaredDirectlyIn(decl: ts.Node, scope: ts.Node): boolean {
  const s = scopesOf(decl)[0];
  return s === scope || ((ts.isFunctionDeclaration(scope) || ts.isArrowFunction(scope) || ts.isFunctionExpression(scope) || ts.isMethodDeclaration(scope)) && scope.body === s);
}

function isListenerExpr(expr: ts.Node, depth = 0): boolean {
  if (depth > 6) return false;
  const e = strip(expr);
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (name === 'listener' || name === 'listenOnLoopback') return true;
    if (ts.isIdentifier(callee)) {
      // a small loader: `const app = () => fx.listener();`
      for (const scope of scopesOf(e)) {
        const b = bindingsIn(scope, callee.text);
        if (b.found) return b.values.length > 0 && b.values.every((v) => (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) && (ts.isBlock(v.body) ? returnsListener(v.body, depth) : isListenerExpr(v.body, depth + 1)));
      }
    }
    return false;
  }
  if (ts.isIdentifier(e)) {
    for (const scope of scopesOf(e)) {
      const b = bindingsIn(scope, e.text);
      if (b.found || b.values.length) return b.values.length > 0 && b.values.every((v) => !ts.isParameter(v) && isListenerExpr(v, depth + 1));
    }
  }
  return false;
}

function returnsListener(body: ts.Block, depth: number): boolean {
  const rets: ts.Expression[] = [];
  const visit = (n: ts.Node) => { if (ts.isReturnStatement(n) && n.expression) rets.push(n.expression); if (!ts.isFunctionLike(n) || n === body.parent) ts.forEachChild(n, visit); };
  visit(body);
  return rets.length > 0 && rets.every((r) => isListenerExpr(r, depth + 1));
}

/** Every supertest call in this source whose argument is not a loopback listener, as `line: text`. */
export function wildcardCalls(text: string): string[] {
  const sf = ts.createSourceFile('suite.ts', text, ts.ScriptTarget.Latest, true);
  const aliases = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === 'supertest' && st.importClause?.name) aliases.add(st.importClause.name.text);
  }
  // Imported inline: `const request = (await import('supertest')).default` or `const { default: request } = await import('supertest')`.
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && /^\(?(?:await\s+)?(?:import|require)\(\s*['"]supertest['"]\s*\)\)?(?:\.default)?$/.test(n.initializer.getText().replace(/\s+/g, ' '))) {
      if (ts.isIdentifier(n.name)) aliases.add(n.name.text);
      else if (ts.isObjectBindingPattern(n.name)) for (const e of n.name.elements) if (ts.isIdentifier(e.name)) aliases.add(e.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const out: string[] = [];
  if (aliases.size === 0) return out;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const root = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.name.text === 'agent' ? c.expression.text : '';
      if (root && aliases.has(root) && n.arguments.length > 0 && !isListenerExpr(n.arguments[0]!)) {
        out.push(`line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText().slice(0, 70)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const users = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && f !== SELF)
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }))
  .filter((s) => s.file === FIXTURE || /from '\.\/permission-switches-fixture'/.test(s.text));

describe('the permission fixture and its suites listen once on loopback', () => {
  it('finds the suites that use the fixture', () => {
    expect(users.length).toBeGreaterThan(200);
  });

  it('the fixture starts its listener with listenOnLoopback and closes it', () => {
    const fixture = users.find((u) => u.file === FIXTURE)!;
    expect(fixture.text).toContain('listenOnLoopback(');
    expect(fixture.text).toContain('closeServer(');
  });

  it('no suite that uses the fixture sends a request through the wildcard form', () => {
    const offenders = users.flatMap((u) => wildcardCalls(u.text).map((c) => `${u.file} ${c}`));
    expect(offenders).toEqual([]);
  });

  const head = "import request from 'supertest';\nimport supertest from 'supertest';\nimport appStatic from '../app';\n";
  const planted: Record<string, string> = {
    'inline default': "const app = (await import('../app.js')).default as never;\nawait request(app).get('/x');",
    'server name': "const server = (await import('../app.js')).default;\nawait request(server).get('/x');",
    'destructured default': "const { default: app } = await import('../app.js');\nawait request(app as never).get('/x');",
    'static import': "await request(appStatic).get('/x');",
    'call inline': "await request((await import('../app.js')).default as never).get('/x');",
    'loader function': "const app = async () => (await import('../app.js')).default as never;\nawait request(await app()).get('/x');",
    'agent': "const app = (await import('../app.js')).default;\nconst a = request.agent(app);",
    'member of fx': "await request(fx.app).get('/x');",
    'member of server': "await supertest(server.app).get('/x');",
    'inline supertest, default member': "const request2 = (await import('supertest')).default;\nconst app = (await import('../app.js')).default;\nawait request2(app).get('/x');",
    'inline supertest, destructured': "const { default: request3 } = await import('supertest');\nconst { default: app } = await import('../app.js');\nawait request3(app as never).get('/x');",
    'aliased import': "import st from 'supertest';\nconst app = (await import('../app.js')).default;\nawait st(app).get('/x');",
    'assigned later': "let app: any;\nbeforeAll(async () => { app = (await import('../app.js')).default; });\nawait request(app).get('/x');",
  };
  for (const [name, body] of Object.entries(planted)) {
    it(`is red on a planted ${name}`, () => {
      expect(wildcardCalls(head + body).length).toBeGreaterThan(0);
    });
  }

  it('is green on the loopback forms', () => {
    const ok = [
      "const app = await fx.listener();\nawait request(app).get('/x');",
      "await request(await fx.listener()).get('/x');",
      "const app = () => fx.listener();\nawait request(await app()).get('/x');",
      "let server: any;\nbeforeAll(async () => { server = await listenOnLoopback(x); });\nawait request(server).get('/x');",
      "const s = await listenOnLoopback(x);\nconst a = request.agent(s);",
    ];
    for (const body of ok) expect(wildcardCalls(head + body), body).toEqual([]);
  });
});
