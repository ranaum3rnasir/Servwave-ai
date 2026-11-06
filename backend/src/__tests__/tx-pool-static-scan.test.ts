/* =============================================================================
   No query on the app's GLOBAL client may be awaited while an interactive transaction is open.

   WHY: `prisma.$transaction(async (tx) => ...)` holds one pooled connection for the life of the callback. A query made
   on the global client inside it (directly, or by a helper the callback calls) needs a second connection; on the
   hosted database's pool of one it waits out the pool timeout and takes the transaction down. Local and CI URLs carry
   five connections and hide it (see inventory-tx-connection-isolation.test.ts and tx-pool-one-connection-db.test.ts).

   WHAT THIS DOES: it reads the backend source with the TypeScript compiler, finds every `$transaction(<function>)`,
   follows every function the callback calls (to the leaves, through imports) and fails when one of them reads the
   global client from `lib/prisma`. A call that is a bare statement (`void emit(...)`, `emit(...)`) is not followed: it
   is not awaited, so it queues for the connection and runs once the transaction has committed, as the notification
   emits made from inside stock and call-ingest transactions do.

   WHAT IT CANNOT SEE (the real-database suites cover the main routes instead): a function handed in as an argument
   (the review's `openInvoices`), a client picked from a variable, and a helper that takes an optional client and
   falls back to the global one when the caller forgets to pass it: those helpers are listed below, and the cases in
   tx-pool-one-connection-db.test.ts and permission-job-review-finish-db.test.ts run their callers.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import path from 'path';
import ts from 'typescript';

const BACKEND = path.resolve(__dirname, '..', '..');
const SRC = path.join(BACKEND, 'src') + path.sep;
const GLOBAL_CLIENT_FILE = path.join(SRC, 'lib', 'prisma.ts');

/**
 * Helpers that take an optional client and use the global one only when it is left out. Every caller inside a
 * transaction passes the transaction's client (read in the files named in the header). A NEW entry here needs the same
 * check and a real-database case that runs its caller on one connection.
 */
const OPTIONAL_CLIENT_HELPERS = new Set([
  'src/lib/job-money-owed.ts::readJobMoneyOwed',
  'src/lib/job-review-reader.ts::readJobReview',
]);

/**
 * Transactions opened on a client of their own, so what runs inside them uses the app's client on another connection by
 * design. None today: the Spider sweep's lock transaction on its own client was the one entry, and it is a lease row now
 * (#2993, services/spider/sweepLease.ts) that holds no transaction. A new entry needs a real-database case on one
 * connection.
 */
const OWN_CLIENT_RECEIVERS = new Set<string>([]);

type FnNode = ts.FunctionLikeDeclaration;

const isFn = (n: ts.Node): n is FnNode =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isGetAccessorDeclaration(n);

function scan() {
  const configPath = path.join(BACKEND, 'tsconfig.json');
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (!config) throw new Error('tsconfig.json could not be read');
  const isProject = (f: string) => f.startsWith(SRC) && !/__tests__|\.test\.ts$/.test(f) && !f.endsWith('.d.ts');
  // Only the app's own source goes in as roots. tsconfig.json also includes every test file (about two thirds of
  // src/), which the scan never looks at; loading them anyway put this file at ~2 GB of heap, Node's default limit on
  // the CI runner, and its worker died of it now and then with every test green (#2963). The `.d.ts` files stay in for
  // the ambient types they declare. Whatever a root imports is still loaded, so nothing the scan follows is lost.
  const roots = config.fileNames.filter((f) => isProject(f) || f.endsWith('.d.ts'));
  const program = ts.createProgram(roots, config.options);
  const checker = program.getTypeChecker();
  const rel = (f: string) => path.relative(BACKEND, f);

  const resolveAlias = (symbol: ts.Symbol | undefined) => {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        return checker.getAliasedSymbol(symbol);
      } catch {
        return symbol;
      }
    }
    return symbol;
  };

  /** The name a function is known by in a report. */
  const nameOf = (fn: FnNode): string => {
    if (fn.name) return fn.name.getText();
    const parent = fn.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText();
    return '<anonymous>';
  };
  const idOf = (fn: FnNode) => `${rel(fn.getSourceFile().fileName)}::${nameOf(fn)}`;

  /** The project function a declaration stands for (a `const f = () => ...` stands for its arrow). */
  const asProjectFunction = (d: ts.Declaration): FnNode | undefined => {
    let target: ts.Node = d;
    if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer && isFn(d.initializer)) target = d.initializer;
    return isFn(target) && isProject(target.getSourceFile().fileName) ? target : undefined;
  };

  const isGlobalClient = (id: ts.Identifier): boolean => {
    if (id.text === 'tx') return false;
    const declaration = resolveAlias(checker.getSymbolAtLocation(id))?.declarations?.[0];
    return !!declaration && declaration.getSourceFile().fileName === GLOBAL_CLIENT_FILE;
  };

  /** A call whose result nobody waits for: a statement of its own, or `void call()`. */
  const isNotAwaited = (call: ts.Node): boolean => {
    const parent = call.parent;
    return ts.isExpressionStatement(parent) || (ts.isVoidExpression(parent) && ts.isExpressionStatement(parent.parent));
  };

  interface Info { reads: boolean; handedOn: string[]; calls: Map<FnNode, true> }
  const infos = new Map<FnNode, Info>();
  const infoOf = (fn: FnNode): Info => {
    const known = infos.get(fn);
    if (known) return known;
    const info: Info = { reads: false, handedOn: [], calls: new Map() };
    infos.set(fn, info);
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && isGlobalClient(n)) {
        const p = n.parent;
        // An import, an export and a `typeof prisma` type are not reads.
        if (!ts.isImportSpecifier(p) && !ts.isExportSpecifier(p) && !ts.isTypeQueryNode(p)) info.reads = true;
      }
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && !isNotAwaited(n)) {
        const declarations: ts.Declaration[] = [];
        try {
          const declaration = checker.getResolvedSignature(n as ts.CallExpression)?.declaration;
          if (declaration) declarations.push(declaration);
        } catch {
          // an expression the checker cannot resolve is not followed
        }
        const callee = n.expression;
        // A function this one was handed, called with nothing: it cannot be using the transaction's client (the Spider
        // sweep ran its whole run through `fn()` inside its lock transaction, on a pool with no second connection).
        if (ts.isCallExpression(n) && ts.isIdentifier(callee) && n.arguments.length === 0 && checker.getSymbolAtLocation(callee)?.declarations?.[0] && ts.isParameter(checker.getSymbolAtLocation(callee)!.declarations![0]!)) {
          info.handedOn.push(callee.text);
        }
        declarations.push(...(resolveAlias(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee))?.declarations ?? []));
        for (const d of declarations) {
          const target = asProjectFunction(d);
          if (target) info.calls.set(target, true);
        }
      } else if (ts.isIdentifier(n) && !ts.isCallExpression(n.parent)) {
        // A function handed on as a value (`items.map(build)`) is followed too.
        for (const d of resolveAlias(checker.getSymbolAtLocation(n))?.declarations ?? []) {
          const target = ts.isFunctionDeclaration(d) || (ts.isVariableDeclaration(d) && d.initializer && isFn(d.initializer)) ? asProjectFunction(d) : undefined;
          if (target && target !== fn && !(target.pos >= fn.pos && target.end <= fn.end)) info.calls.set(target, true);
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn, visit);
    return info;
  };

  /** Every `$transaction(<function>)` of the backend's own code. */
  const transactions: { where: string; callback: FnNode }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!isProject(sf.fileName)) continue;
    const find = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === '$transaction' && !OWN_CLIENT_RECEIVERS.has(n.expression.expression.getText())) {
        let arg: ts.Node | undefined = n.arguments[0];
        if (arg && ts.isIdentifier(arg)) {
          const d = checker.getSymbolAtLocation(arg)?.declarations?.[0];
          if (d && ts.isVariableDeclaration(d) && d.initializer) arg = d.initializer;
        }
        if (arg && isFn(arg)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          transactions.push({ where: `${rel(sf.fileName)}:${line}`, callback: arg });
        }
      }
      ts.forEachChild(n, find);
    };
    find(sf);
  }

  /** The functions in a transaction's reach that read the global client, each with the way the callback gets there. */
  const offenders: string[] = [];
  for (const { where, callback } of transactions) {
    const seen = new Set<FnNode>();
    const stack: { fn: FnNode; trail: string[] }[] = [{ fn: callback, trail: [] }];
    while (stack.length > 0) {
      const { fn, trail } = stack.pop()!;
      if (seen.has(fn)) continue;
      seen.add(fn);
      const info = infoOf(fn);
      const id = idOf(fn);
      if (info.reads && !OPTIONAL_CLIENT_HELPERS.has(id)) offenders.push(`${where} -> ${[...trail, id].join(' -> ')}`);
      for (const name of info.handedOn) offenders.push(`${where} -> ${[...trail, id].join(' -> ')} calls ${name}() with no client`);
      for (const next of info.calls.keys()) if (!seen.has(next)) stack.push({ fn: next, trail: [...trail, id] });
    }
  }
  return { transactions: transactions.length, offenders };
}

describe('transactions never await a query on the global client', () => {
  it('finds no function inside an interactive transaction that reads the global client', () => {
    const { transactions, offenders } = scan();
    // The scan must have looked at the code: a changed layout that makes it find nothing would pass for the wrong reason.
    expect(transactions).toBeGreaterThan(150);
    expect(offenders).toEqual([]);
  }, 180_000);
});
