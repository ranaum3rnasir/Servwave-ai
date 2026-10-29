/* =============================================================================
   Visit-write refresh guard (visits-and-task-categories slice 01).

   Every visit write - book, reschedule, re-crew, cancel, complete, unschedule, a lifecycle step -
   and every job create refreshes through ONE helper, `refreshAfterVisitWrite`
   (lib/refreshAfterVisitWrite.ts). Before it, each path kept its own invalidation list, the lists
   drifted, and none of them named the customer page: a job booked seconds ago read "Unscheduled"
   there, and a new job was missing, until a reload.

   RULE 1 - no hand-rolled refresh of a visit surface. No source file may invalidate the
   scheduler board's four queries or a job's visit list on its own; that is the helper's job.
   The allowance is for the few calls that are NOT visit writes, as a ratchet.

   RULE 2 - every visit-write request (and job create, job delete, lead delete) is refreshed by the
   helper. Parsed with the TypeScript compiler, not grepped, so comments never count and a URL
   built by concatenation or held in a variable is still seen. A write is:
     - `api.post|put|patch|delete(url)` whose URL reads as a visit-write or job-create endpoint
       (VISIT_WRITE_URLS below), or
     - a call to a lib/api wrapper that sends one. Wrappers are DISCOVERED, not listed: an
       exported lib/api function whose own body sends a visit write is a wrapper; its definition
       is the only thing exempt, and every caller is policed like a direct request.
   It passes only when the helper runs on SUCCESS in the SAME unit:
     - inside a `useMutation({...})`: in its `onSuccess` or `onSettled` - never `onError`,
       `mutationFn` or anything else in the options;
     - outside a mutation: in the enclosing function's body, excluding any `onError` value in it.
   A same-file named handler counts only when it IS the onSuccess/onSettled value
   (`onSuccess: reportBulkResult`) or is actually CALLED there (`invalidateJob()`), and its own
   body calls the helper outside any `onError`. Mentioning a name, or sitting near an unrelated
   refresh, does not count.

   KNOWN BLIND SPOTS - the guard reads URLs statically, so it does not see:
     - a URL passed in as a function PARAMETER, or produced by a builder function
       (`api.post(jobUrl(id, 'assign'))`), which reads as `${}`;
     - a request through a NAMESPACE import (`import * as jobsApi` then `jobsApi.reopenJob()`),
       or through a wrapper RE-EXPORTED under another name from a second module - wrappers are
       matched by their lib/api export name and by `import { x as y }` aliases only;
     - an HTTP client other than the `api` default import from lib/axios.
   A new write door should use the literal URL shape the rest of the app uses so it stays visible.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['__tests__', 'node_modules']);
const HELPER = 'lib/refreshAfterVisitWrite.ts';
const HELPER_CALL = 'refreshAfterVisitWrite';

// ── Rule 1 ───────────────────────────────────────────────────────────────────

const VISIT_SURFACE_CALL =
  /invalidateQueries\(\s*\{\s*queryKey:\s*(?:\[\s*'(?:schedule-jobs|schedule-walkthroughs|schedule-unassigned|schedule-unscheduled-walkthroughs|job-visits)'|jobVisitsQueryKey\()/g;

/** Not visit writes. file -> [max calls, why]. */
const ALLOWED: Record<string, [number, string]> = {
  // Editing a customer's name/address rewrites the copies embedded in board cards.
  'pages/v2/customers/CustomerFormPage.tsx': [3, 'customer edit, not a visit write'],
  // Plan mode's discard/remove/exit put ghosted cards back in the sidebar buckets. Client-only:
  // nothing was written.
  'pages/v2/schedule/SchedulePage.tsx': [6, 'plan-mode discards, no write'],
};

// ── Rule 2 ───────────────────────────────────────────────────────────────────

/** URL shapes, with every dynamic part read as `${}`. */
const VISIT_WRITE_URLS: RegExp[] = [
  // Job create (incl. ?override=true) - a new job on the customer, and it can book Visit 1.
  /^\/api\/jobs(\?.*)?$/,
  /^\/api\/jobs\/\$\{\}\/(visits(\/.*)?|assign|assignees|unassign|complete|start|arrive|en-route|cancel|reopen|duplicate)$/,
  /^\/api\/jobs\/bulk-(status|assign)$/,
  // Lead exits (cancel, mark-lost) auto-cancel the walkthrough visit. Bare `/walkthrough` is the
  // notes save, not a visit write.
  /^\/api\/leads\/\$\{\}\/(visits(\/.*)?|walkthrough\/.+|cancel|mark-lost)$/,
  /^\/api\/service-plans\/\$\{\}\/schedule-visit$/,
];
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
/**
 * Visit writes by DELETE only: deleting a job or a lead removes it and every visit on it from the
 * customer page. A PATCH of the same URL (job type, cost, location, lead fields) is not a visit write.
 */
const DELETE_WRITE_URLS: RegExp[] = [
  /^\/api\/jobs\/\$\{\}$/,
  // Deleting a lead takes its walkthrough visits with it.
  /^\/api\/leads\/\$\{\}$/,
];

/** Unrouted files, exempt as a whole. file -> why. */
const FILE_EXEMPT: Record<string, string> = {
  'pages/JobsPage.tsx': 'dead v1 page - only pages/v2 is routed',
  'pages/JobFormPage.tsx': 'dead v1 page - only pages/v2 is routed',
};

function isFunctionLike(n: ts.Node): boolean {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

function isAncestor(maybe: ts.Node, node: ts.Node): boolean {
  for (let a: ts.Node | undefined = node; a; a = a.parent) if (a === maybe) return true;
  return false;
}

/** The function-like declared under `name` in this file, if any. */
function findFunction(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  walk(sf, (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name
      && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = n.initializer;
  });
  return found;
}

/** Every static reading of a URL expression, dynamic parts as `${}`. */
function urlTexts(expr: ts.Expression, sf: ts.SourceFile, at: ts.Node, depth = 0): string[] {
  if (depth > 4) return ['${}'];
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isTemplateExpression(expr)) return [expr.head.text + expr.templateSpans.map((s) => '${}' + s.literal.text).join('')];
  if (ts.isParenthesizedExpression(expr)) return urlTexts(expr.expression, sf, at, depth + 1);
  if (ts.isConditionalExpression(expr)) {
    return [...urlTexts(expr.whenTrue, sf, at, depth + 1), ...urlTexts(expr.whenFalse, sf, at, depth + 1)];
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = urlTexts(expr.left, sf, at, depth + 1);
    const r = urlTexts(expr.right, sf, at, depth + 1);
    return l.flatMap((a) => r.map((b) => a + b));
  }
  if (ts.isIdentifier(expr)) {
    // A `const url = ...` declared earlier in a scope that encloses the call.
    let init: ts.Expression | undefined;
    walk(sf, (n) => {
      if (init || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== expr.text) return;
      if (!n.initializer || n.pos > at.pos) return;
      let scope: ts.Node = n;
      while (scope.parent && !isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      if (isAncestor(scope, at)) init = n.initializer;
    });
    return init ? urlTexts(init, sf, at, depth + 1) : ['${}'];
  }
  return ['${}'];
}

function isVisitWriteRequest(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'api') return null;
  if (!WRITE_METHODS.has(e.name.text) || call.arguments.length === 0) return null;
  const method = e.name.text;
  const urls = method === 'delete' ? [...VISIT_WRITE_URLS, ...DELETE_WRITE_URLS] : VISIT_WRITE_URLS;
  const hit = urlTexts(call.arguments[0]!, sf, call).find((u) => urls.some((re) => re.test(u)));
  return hit ? `${e.name.text.toUpperCase()} ${hit}` : null;
}

/** The unit that must refresh: the enclosing useMutation call, else the enclosing function. */
function enclosingUnit(node: ts.Node): ts.Node {
  let fn: ts.Node | null = null;
  for (let a = node.parent; a; a = a.parent) {
    if (ts.isCallExpression(a) && calleeName(a) === 'useMutation') return a;
    if (!fn && isFunctionLike(a)) fn = a;
  }
  return fn ?? node.getSourceFile();
}

/** The exported name a lib/api unit is declared under, if it is a top-level exported function. */
function exportedName(unit: ts.Node): string | null {
  if (ts.isFunctionDeclaration(unit)) {
    const exported = unit.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return exported && unit.name ? unit.name.text : null;
  }
  const decl = unit.parent;
  if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const stmt = decl.parent?.parent;
    const exported = stmt && ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return exported ? decl.name.text : null;
  }
  return null;
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  return p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
}

/** Walks `node`, skipping every `onError` value: a refresh there runs on failure, not success. */
function walkSuccessPath(node: ts.Node, visit: (n: ts.Node) => void) {
  if (ts.isObjectLiteralElement(node) && propName(node as ts.ObjectLiteralElementLike) === 'onError') return;
  visit(node);
  node.forEachChild((c) => walkSuccessPath(c, visit));
}

/** The helper is called directly in `node`, outside any onError. */
function callsHelper(node: ts.Node): boolean {
  let hit = false;
  walkSuccessPath(node, (n) => { if (!hit && ts.isCallExpression(n) && calleeName(n) === HELPER_CALL) hit = true; });
  return hit;
}

/** `node` refreshes: it calls the helper, or CALLS a same-file function whose body does. */
function refreshesIn(node: ts.Node, sf: ts.SourceFile): boolean {
  let hit = false;
  walkSuccessPath(node, (n) => {
    if (hit || !ts.isCallExpression(n)) return;
    if (calleeName(n) === HELPER_CALL) { hit = true; return; }
    if (ts.isIdentifier(n.expression)) {
      const fn = findFunction(sf, n.expression.text);
      if (fn && !isAncestor(fn, n) && callsHelper(fn)) hit = true;
    }
  });
  return hit;
}

/** The success-path code of a unit: a mutation's onSuccess/onSettled values, else the function. */
function successPaths(unit: ts.Node): ts.Node[] {
  if (!ts.isCallExpression(unit)) return [unit];
  const opts = unit.arguments[0];
  if (!opts || !ts.isObjectLiteralExpression(opts)) return [];
  return opts.properties.flatMap((p) => {
    const name = propName(p);
    if (name !== 'onSuccess' && name !== 'onSettled') return [];
    if (ts.isPropertyAssignment(p)) return [p.initializer];
    if (ts.isShorthandPropertyAssignment(p)) return [p.name];
    return [p];
  });
}

/** The unit refreshes on success, directly or through a named handler it uses or calls there. */
function unitRefreshes(unit: ts.Node, sf: ts.SourceFile): boolean {
  return successPaths(unit).some((path) => {
    if (ts.isIdentifier(path)) {
      // `onSuccess: reportBulkResult` - the handler IS the success path.
      const fn = findFunction(sf, path.text);
      return !!fn && callsHelper(fn);
    }
    return refreshesIn(path, sf);
  });
}

/** Exported lib/api functions whose own body sends a visit write. name -> the request. */
function discoverWrappers(files: { rel: string; text: string }[]): Map<string, string> {
  const wrappers = new Map<string, string>();
  for (const { rel, text } of files) {
    if (!rel.startsWith('lib/api/')) continue;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const req = isVisitWriteRequest(n, sf);
      if (!req) return;
      const name = exportedName(enclosingUnit(n));
      if (name) wrappers.set(name, `${rel} ${req}`);
    });
  }
  return wrappers;
}

/** Every visit write in one file that is not refreshed by the helper in its own unit. */
function unrefreshedWrites(rel: string, text: string, wrappers: Map<string, string>): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  // Local names of imported wrappers (an `import { x as y }` alias is followed).
  const local = new Map<string, string>();
  walk(sf, (n) => {
    if (ts.isImportSpecifier(n) && wrappers.has((n.propertyName ?? n.name).text)) {
      local.set(n.name.text, (n.propertyName ?? n.name).text);
    }
  });
  const out: string[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    let what = isVisitWriteRequest(n, sf);
    if (!what && ts.isIdentifier(n.expression)) {
      const wrapper = local.get(n.expression.text) ?? (wrappers.has(n.expression.text) ? n.expression.text : null);
      if (wrapper) what = `${wrapper}()`;
    }
    if (!what) return;
    const unit = enclosingUnit(n);
    // A wrapper's own definition carries no obligation; its callers do.
    if (rel.startsWith('lib/api/') && wrappers.has(exportedName(unit) ?? '')) return;
    if (!unitRefreshes(unit, sf)) {
      out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${what}`);
    }
  });
  return out;
}

// ── Source walk ──────────────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((f) => ({
  rel: relative(SRC, f).split('\\').join('/'),
  text: readFileSync(f, 'utf8'),
}));

function visitSurfaceCallCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { rel, text } of FILES) {
    if (rel === HELPER) continue;
    const n = text.match(VISIT_SURFACE_CALL)?.length ?? 0;
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

describe('visit-write refresh guard - rule 1, no hand-rolled refresh', () => {
  it('no file refreshes a visit surface on its own - visit writes go through refreshAfterVisitWrite', () => {
    const over = Object.entries(visitSurfaceCallCounts())
      .filter(([file, n]) => n > (ALLOWED[file]?.[0] ?? 0))
      .map(([file, n]) => `${file}: ${n} (allowed ${ALLOWED[file]?.[0] ?? 0})`);
    expect(over).toEqual([]);
  });

  it('the pattern still matches a real call, so the guard is not vacuous', () => {
    expect(visitSurfaceCallCounts()['pages/v2/customers/CustomerFormPage.tsx']).toBeGreaterThan(0);
  });
});

describe('visit-write refresh guard - rule 2, every write refreshes in its own unit', () => {
  const wrappers = discoverWrappers(FILES);

  it('every visit-write request, job create and job/lead delete in the app is refreshed by refreshAfterVisitWrite', () => {
    const violations = FILES
      .filter(({ rel }) => rel !== HELPER && !(rel in FILE_EXEMPT))
      .flatMap(({ rel, text }) => unrefreshedWrites(rel, text, wrappers));
    expect(violations).toEqual([]);
  });

  it('discovers the lib/api wrappers that send a visit write, so their callers are policed', () => {
    expect([...wrappers.keys()]).toEqual(expect.arrayContaining(['reopenJob', 'cancelLead', 'deleteLead']));
  });

  it('each whole-file exemption still sends an unrefreshed visit write (no stale exemptions)', () => {
    for (const rel of Object.keys(FILE_EXEMPT)) {
      const file = FILES.find((f) => f.rel === rel);
      expect(file, rel).toBeDefined();
      expect(unrefreshedWrites(rel, file!.text, wrappers).length, rel).toBeGreaterThan(0);
    }
  });
});

// ── Self-tests: the holes a verifier found in the first version of this guard ──

const REFRESHED = `
  const good = useMutation({
    mutationFn: () => api.post(\`/api/jobs/\${jobId}/assign\`, {}),
    onSuccess: () => refreshAfterVisitWrite(queryClient, { jobId }),
  });`;

describe('visit-write refresh guard - self-tests', () => {
  it('passes a write refreshed in its own mutation, and one refreshed through a named handler', () => {
    const viaHandler = `
      function reportResult() { refreshAfterVisitWrite(queryClient, { jobIds: [] }); }
      const bulk = useMutation({ mutationFn: () => api.post('/api/jobs/bulk-status', {}), onSuccess: reportResult });`;
    expect(unrefreshedWrites('pages/v2/x/ok.tsx', REFRESHED + viaHandler, new Map())).toEqual([]);
  });

  it('(a) a NEW lib/api wrapper is discovered and its unrefreshed caller fails', () => {
    const lib = { rel: 'lib/api/jobs.ts', text: `
      export function moveJobVisit(jobId: string, visitId: string) {
        return api.patch(\`/api/jobs/\${jobId}/visits/\${visitId}\`, {}).then((r) => r.data);
      }` };
    const found = discoverWrappers([lib]);
    expect(found.has('moveJobVisit')).toBe(true);
    // The definition itself is not a violation...
    expect(unrefreshedWrites(lib.rel, lib.text, found)).toEqual([]);
    // ...its caller is.
    const caller = `
      import { moveJobVisit } from '@/lib/api/jobs';
      const m = useMutation({
        mutationFn: () => moveJobVisit('j', 'v'),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', 'j'] }),
      });`;
    expect(unrefreshedWrites('pages/v2/x/caller.tsx', caller, found)).toEqual(['pages/v2/x/caller.tsx:4 moveJobVisit()']);
  });

  it('(b) a string-concatenated URL is still a visit write', () => {
    const concatenated = `
      const m = useMutation({
        mutationFn: () => api.post('/api/jobs/' + jobId + '/assign', {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
      });`;
    expect(unrefreshedWrites('pages/v2/x/concat.tsx', concatenated, new Map()))
      .toEqual(['pages/v2/x/concat.tsx:3 POST /api/jobs/${}/assign']);
  });

  it('(b) so is a job create through a variable holding the override URL', () => {
    const create = `
      const m = useMutation({
        mutationFn: async () => {
          const url = override ? '/api/jobs?override=true' : '/api/jobs';
          return api.post(url, body);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
      });`;
    expect(unrefreshedWrites('pages/v2/x/create.tsx', create, new Map()))
      .toEqual(['pages/v2/x/create.tsx:5 POST /api/jobs?override=true']);
  });

  it('(c) a write beside an UNRELATED refresh, or beside a comment naming the helper, fails', () => {
    const neighbour = `
      const bad = useMutation({
        // refreshAfterVisitWrite(queryClient, { jobId }) - a comment is not a call
        mutationFn: () => api.post(\`/api/jobs/\${jobId}/complete\`),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
      });` + REFRESHED;
    expect(unrefreshedWrites('pages/v2/x/neighbour.tsx', neighbour, new Map()))
      .toEqual(['pages/v2/x/neighbour.tsx:4 POST /api/jobs/${}/complete']);
  });

  it('(E6) a refresh reachable only from onError does not count', () => {
    const onErrorOnly = `
      const m = useMutation({
        mutationFn: () => api.post(\`/api/jobs/\${jobId}/complete\`),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
        onError: () => refreshAfterVisitWrite(queryClient, { jobId }),
      });
      function save() {
        api.post(\`/api/jobs/\${jobId}/start\`);
        other.mutate(undefined, { onError: () => refreshAfterVisitWrite(queryClient, { jobId }) });
      }`;
    expect(unrefreshedWrites('pages/v2/x/onerror.tsx', onErrorOnly, new Map())).toEqual([
      'pages/v2/x/onerror.tsx:3 POST /api/jobs/${}/complete',
      'pages/v2/x/onerror.tsx:8 POST /api/jobs/${}/start',
    ]);
  });

  it('(E6) nor does one in mutationFn, only onSuccess or onSettled', () => {
    const settled = `
      const a = useMutation({
        mutationFn: async () => { refreshAfterVisitWrite(queryClient, { jobId }); return api.post(\`/api/jobs/\${jobId}/start\`); },
      });
      const b = useMutation({
        mutationFn: () => api.post(\`/api/jobs/\${jobId}/complete\`),
        onSettled: () => refreshAfterVisitWrite(queryClient, { jobId }),
      });`;
    expect(unrefreshedWrites('pages/v2/x/settled.tsx', settled, new Map()))
      .toEqual(['pages/v2/x/settled.tsx:3 POST /api/jobs/${}/start']);
  });

  it('(E7) a named handler counts when it IS onSuccess or is CALLED there, not when merely mentioned', () => {
    const handlers = `
      function refreshAll() { refreshAfterVisitWrite(queryClient, { jobId }); }
      const asValue = useMutation({ mutationFn: () => api.post(\`/api/jobs/\${jobId}/start\`), onSuccess: refreshAll });
      const called = useMutation({ mutationFn: () => api.post(\`/api/jobs/\${jobId}/arrive\`), onSuccess: () => { refreshAll(); } });
      const mentioned = useMutation({
        mutationFn: () => api.post(\`/api/jobs/\${jobId}/complete\`),
        onSuccess: () => { console.log(refreshAll.name); },
      });
      const elsewhere = useMutation({
        mutationFn: () => api.post(\`/api/jobs/\${jobId}/cancel\`),
        onSuccess: () => {},
        onError: refreshAll,
      });`;
    expect(unrefreshedWrites('pages/v2/x/handlers.tsx', handlers, new Map())).toEqual([
      'pages/v2/x/handlers.tsx:6 POST /api/jobs/${}/complete',
      'pages/v2/x/handlers.tsx:10 POST /api/jobs/${}/cancel',
    ]);
  });

  it('a job DELETE is a visit write, a PATCH of the same URL is not', () => {
    const source = `
      const del = useMutation({
        mutationFn: () => api.delete(\`/api/jobs/\${id}\`),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
      });
      const edit = useMutation({
        mutationFn: () => api.patch(\`/api/jobs/\${id}\`, { job_type }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', id] }),
      });`;
    expect(unrefreshedWrites('pages/v2/x/delete.tsx', source, new Map()))
      .toEqual(['pages/v2/x/delete.tsx:3 DELETE /api/jobs/${}']);
  });
});
