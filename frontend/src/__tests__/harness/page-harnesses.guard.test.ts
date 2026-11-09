/**
 * #3259: every page in the brake's one mapping (`PAGE_HARNESSES` in `scripts/test-brake-lib.mjs`, decision D14) has ONE
 * harness and no second fake server: no test file imports the page itself, the harness is its one importer, and the
 * tests reach it through the harness.
 *
 * The brake counts a test file that imports the page OR its harness as mounting the page, so this guard holds no count:
 * the ceiling in `test-page-ceilings.json` does, and falls only when files are really merged. A file that mounts a
 * harnessed page by hand (its own import of the page, its own fake server) fails here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_HARNESSES, importSpecifiers, isPageModule, pageReach, resolveSpecifier, scanPageImports } from '../../../scripts/test-brake-lib.mjs';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(FRONTEND, 'src');

function testFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const isTestFile = (name: string) => /\.test\.[cm]?[jt]sx?$/.test(name);

/** Every non-test source file under src/ (ts, tsx, js, jsx, mts, cts, ...), wherever it lives: support files, helpers, wrappers. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE.test(e.name) && !/\.d\.ts$/.test(e.name) && !isTestFile(e.name)) out.push(full);
  }
  return out;
}

const normalize = (p: string) => {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
};

const rel = (f: string) => `src/${relative(SRC, f).split(sep).join('/')}`;

/**
 * The app's own code: every module reachable by an import (static or dynamic) from an entry point of the build. The one
 * rule that separates a support module for tests from production code that happens to import a page (the routes do).
 * `modules` = [{ path, source }] for every non-test source file; `entries` = their paths.
 */
export function reachableFrom(modules: Array<{ path: string; source: string }>, entries: string[]): Set<string> {
  const byBase = new Map<string, string>();
  for (const m of modules) {
    byBase.set(m.path.replace(SOURCE, ''), m.path);
    if (/\/index\.[cm]?[jt]sx?$/.test(m.path)) byBase.set(m.path.replace(/\/index\.[cm]?[jt]sx?$/, ''), m.path);
  }
  const source = new Map(modules.map((m) => [m.path, m.source]));
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path) || !source.has(path)) continue;
    seen.add(path);
    for (const spec of importSpecifiers(source.get(path)!) as string[]) {
      const target = resolveSpecifier(spec, path) as string | null;
      const file = target ? byBase.get(target) : undefined;
      if (file) queue.push(file);
    }
    // `import.meta.glob('./*.routes.tsx')`: every module the pattern names is imported (the route tables are found this way).
    for (const m of source.get(path)!.matchAll(/import\.meta\.glob(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)) {
      const pattern = normalize(`${path.split('/').slice(0, -1).join('/')}/${m[1]}`);
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
      for (const candidate of source.keys()) if (re.test(candidate)) queue.push(candidate);
    }
  }
  return seen;
}

/**
 * The support modules (outside the registered harnesses) that import a registered page or a registered harness: a wrapper
 * or a re-export of either would hide a mounter from the brake's count, which follows a test file's direct imports only.
 * `modules` = [{ path, source }]; the result is the paths that do it.
 */
export function hiddenMounters(
  modules: Array<{ path: string; source: string }>,
  mapping: Record<string, string[]>,
  production: Set<string> = new Set(),
): string[] {
  const registered = new Set(Object.values(mapping).flat());
  const pages = Object.keys(mapping);
  return modules
    .filter((m) => !registered.has(m.path) && !production.has(m.path))
    .filter((m) => Object.keys(scanPageImports({ tests: [m], pages, harnesses: mapping }) as Record<string, number>).length > 0)
    .map((m) => m.path);
}

const files = testFiles().map((f) => ({ path: `src/${relative(SRC, f).split(sep).join('/')}`, text: readFileSync(f, 'utf8') }));
const mapping = PAGE_HARNESSES as Record<string, string[]>;
const usesHarness = (text: string, harness: string) => {
  const base = harness.replace(/^src\//, '').replace(/\.tsx?$/, '');
  return text.includes(`'@/${base}'`) || text.includes(`"@/${base}"`) || text.includes(`/${base.split('/').slice(-2).join('/')}'`);
};

describe.each(Object.entries(mapping))('the harness of %s (#3259)', (page, harnesses) => {
  const importsPage = (f: { path: string; text: string }) =>
    Boolean((scanPageImports({ tests: [{ path: f.path, source: f.text }], pages: [page], harnesses: {} }) as Record<string, number>)[page]);

  it('is a file that exists, and tests use it', () => {
    for (const h of harnesses) expect(existsSync(join(FRONTEND, h))).toBe(true);
    const viaHarness = files.filter((f) => harnesses.some((h) => usesHarness(f.text, h)));
    expect(viaHarness.length).toBeGreaterThan(5);
  });

  it('is imported by no test file: the harness is the one importer of the page', () => {
    expect(files.filter(importsPage).map((f) => f.path)).toEqual([]);
  });
});

describe('a wrapper or a support module cannot hide a mounter of a harnessed page (#3259, D14)', () => {
  const planted = (name: string, source: string) => ({ path: `src/__tests__/${name}`, source });
  const jobPage = Object.keys(mapping)[0]!;
  const jobHarness = mapping[jobPage]![0]!;
  const alias = (p: string) => `@/${p.replace(/^src\//, '').replace(/\.tsx?$/, '')}`;

  it('finds a re-export of a registered harness, a support module that imports a page, and a dynamic import of either', () => {
    expect(hiddenMounters([
      planted('wrapper.tsx', `export * from '${alias(jobHarness)}';`),
      planted('support.tsx', `import Page from '${alias(jobPage)}'; export const p = <Page />;`),
      planted('lazy.ts', `export const load = () => import('${alias(jobPage)}');`),
      planted('fine.ts', `import { vi } from 'vitest'; export const x = vi.fn();`),
    ], mapping)).toEqual(['src/__tests__/wrapper.tsx', 'src/__tests__/support.tsx', 'src/__tests__/lazy.ts']);
  });

  it('lets the registered harnesses themselves import their page', () => {
    expect(hiddenMounters([{ path: jobHarness, source: `import Page from '${alias(jobPage)}';` }], mapping)).toEqual([]);
  });

  it('finds a support module outside any __tests__ folder, and a .jsx one, that no entry point of the app reaches', () => {
    const lib = (name: string, source: string) => ({ path: `src/testing-support/${name}`, source });
    const modules = [
      { path: 'src/main.tsx', source: `import './routes/jobs.routes';` },
      { path: 'src/routes/jobs.routes.tsx', source: `import Page from '${alias(jobPage)}'; export const r = <Page />;` },
      lib('mountJob.tsx', `import Page from '${alias(jobPage)}'; export const m = <Page />;`),
      lib('mountJob.jsx', `import Page from '${alias(jobPage)}'; export const m = <Page />;`),
      lib('fine.ts', `export const x = 1;`),
    ];
    const production = reachableFrom(modules, ['src/main.tsx']);
    expect([...production].sort()).toEqual(['src/main.tsx', 'src/routes/jobs.routes.tsx']);
    expect(hiddenMounters(modules, mapping, production)).toEqual(['src/testing-support/mountJob.tsx', 'src/testing-support/mountJob.jsx']);
  });

  it('follows a dynamic import and an index file when it decides what the app reaches', () => {
    const modules = [
      { path: 'src/main.tsx', source: `export const l = () => import('./feature');` },
      { path: 'src/feature/index.ts', source: `import Page from '${alias(jobPage)}'; export const p = Page;` },
    ];
    const production = reachableFrom(modules, ['src/main.tsx']);
    expect(hiddenMounters(modules, mapping, production)).toEqual([]);
  });

  it('follows import.meta.glob, which is how the route tables are reached', () => {
    const modules = [
      { path: 'src/main.tsx', source: `import './routes/index';` },
      { path: 'src/routes/index.tsx', source: `const m = import.meta.glob<unknown>('./*.routes.tsx', { eager: true });` },
      { path: 'src/routes/jobs.routes.tsx', source: `import Page from '${alias(jobPage)}'; export const r = Page;` },
    ];
    const production = reachableFrom(modules, ['src/main.tsx']);
    expect(production.has('src/routes/jobs.routes.tsx')).toBe(true);
    expect(hiddenMounters(modules, mapping, production)).toEqual([]);
  });

  it('finds none in the tree: a source file that imports a harnessed page is a registered harness or part of the app', () => {
    const modules = sourceFiles().map((f) => ({ path: rel(f), source: readFileSync(f, 'utf8') }));
    const production = reachableFrom(modules, ['src/main.tsx', 'src/public-main.tsx']);
    expect(hiddenMounters(modules, mapping, production)).toEqual([]);
  });
});

describe('the mapping names every harness (#3259, D14)', () => {
  it('a module in the harness folder that imports a page is the registered harness of that page: removing an entry turns this red', () => {
    const HARNESS_DIR = join(SRC, '__tests__', 'harness');
    const unregistered: string[] = [];
    for (const f of sourceFiles(HARNESS_DIR)) {
      const path = rel(f);
      for (const spec of importSpecifiers(readFileSync(f, 'utf8')) as string[]) {
        const target = resolveSpecifier(spec, path) as string | null;
        const page = target && [`${target}.tsx`].find((p) => isPageModule(p) && existsSync(join(FRONTEND, p)));
        if (page && !(mapping[page] ?? []).includes(path)) unregistered.push(`${path} imports ${page}`);
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('every registered harness exists in the harness folder', () => {
    for (const harnesses of Object.values(mapping)) {
      for (const h of harnesses) expect(h.startsWith('src/__tests__/harness/') && existsSync(join(FRONTEND, h))).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No test file that mounts a harnessed page answers the page's reads itself (#3259, verifier rounds 3 and 4 both found one
// that did). The fake server is the harness's: a test states what differs through the harness's options and routes.

/** The ways a test file can put a fake server of its own under a page: found in the source text, by line. */
export const OWN_SERVER_KINDS = {
  /** `vi.stubGlobal('fetch', ...)`, `global.fetch = ...` (the public pages talk over bare `fetch`). */
  fetch: /vi\.stubGlobal\(\s*['"]fetch['"]|\b(?:global|globalThis|window|self)\.fetch\s*=(?!=)/g,
  /** `vi.mock('@/lib/axios', () => ({ default: { get: ... } }))`: a replacement client that answers reads. A bare `get: vi.fn()` answers nothing. */
  axiosFactory: /vi\.mock\(\s*['"]@\/lib\/axios['"]\s*,(?:(?!\bvi\.mock\()[\s\S]){0,600}?\bget\s*:(?!\s*vi\.fn\(\s*\)\s*[,}])/g,
  /** The client's `get` given an answer: `mockApi.get.mockImplementation(...)`, `vi.mocked(api.get).mockResolvedValue(...)`, `...Once`. */
  getAnswer: /\.get\)?\s*\.mock(?:Implementation|ResolvedValue|RejectedValue|ReturnValue)(?:Once)?\s*\(|vi\.spyOn\(\s*\w+\s*,\s*['"]get['"]/g,
} as const;
export type OwnServerKind = keyof typeof OWN_SERVER_KINDS;

/**
 * Writes are not in the list on purpose: the harnesses model READS (the page's data); what a `post`, `patch`, `put` or
 * `delete` answers is the outcome a test states (a refusal, a created record), as the tests always did.
 */
export function ownServerHits(source: string): Array<{ kind: OwnServerKind; line: number }> {
  const out: Array<{ kind: OwnServerKind; line: number }> = [];
  for (const [kind, re] of Object.entries(OWN_SERVER_KINDS) as Array<[OwnServerKind, RegExp]>) {
    for (const m of source.matchAll(new RegExp(re.source, re.flags))) out.push({ kind, line: source.slice(0, m.index).split('\n').length });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * A reasoned exception: this file has `count` hits of `kind`, and each is not the page's own read server. The count is exact,
 * so a new hit in the file, or a stale entry, turns the guard red. Every entry says why.
 */
interface Exception { file: string; kind: OwnServerKind; count: number; reason: string }
const EXCEPTIONS: Exception[] = [
  { file: 'src/__tests__/communication-show-routes.test.tsx', kind: 'getAnswer', count: 1, reason: "a route-table test: it answers the permission-switches read the route guards make, and the registered pages its routes reach are replaced with vi.mock or only navigated to" },
  { file: 'src/__tests__/hidden-routes-go-home.test.tsx', kind: 'getAnswer', count: 2, reason: "a route-table test: it answers the permission-switches read the route guards make, and the registered pages its routes reach are replaced with vi.mock or only navigated to" },
  { file: 'src/__tests__/page-locks-are-switches.test.tsx', kind: 'getAnswer', count: 1, reason: "a route-table test: it answers the permission-switches read the route guards make, and the registered pages its routes reach are replaced with vi.mock or only navigated to" },
  { file: 'src/__tests__/plan-gates-stay-on-top-of-switches.test.tsx', kind: 'getAnswer', count: 1, reason: "a route-table test: it answers the permission-switches read the route guards make, and the registered pages its routes reach are replaced with vi.mock or only navigated to" },
  { file: 'src/__tests__/schedule-no-crew-link-needs-access.test.tsx', kind: 'getAnswer', count: 1, reason: "a route-table test: it answers the permission-switches read the route guards make, and the registered pages its routes reach are replaced with vi.mock or only navigated to" },
  { file: 'src/__tests__/servwave-payments-redirect.test.tsx', kind: 'getAnswer', count: 1, reason: "a route-table test: it answers the permission-switches read the route guards make, and the registered pages its routes reach are replaced with vi.mock or only navigated to" },
  { file: 'src/__tests__/settings-v7-shell.test.tsx', kind: 'getAnswer', count: 1, reason: "a route-table test: it answers the permission-switches read the route guards make, and the registered pages its routes reach are replaced with vi.mock or only navigated to" },
  { file: 'src/__tests__/decline-reason-pickers.test.tsx', kind: 'axiosFactory', count: 1, reason: "the staff decline-reason dialog's client (a settings dialog, not the public estimate page, whose reads go through the harness's fetch server)" },
  { file: 'src/__tests__/decline-reason-pickers.test.tsx', kind: 'getAnswer', count: 1, reason: "serves the staff decline-reason list to the authenticated hook; the public estimate page is served by servePublicEstimate" },
  { file: 'src/__tests__/entity-tasks-tab.test.tsx', kind: 'getAnswer', count: 1, reason: "serves the customer page's reads (CustomerDetailPage); the estimate workspace page is served by its harness" },
  { file: 'src/__tests__/estimate-pdf-preview-dialog.test.tsx', kind: 'fetch', count: 1, reason: "the PDF bytes the preview dialog fetches (a blob response), not a read of the estimate workspace page's data" },
  { file: 'src/__tests__/hand-sent-documents-sending-as.test.tsx', kind: 'getAnswer', count: 1, reason: "serves the invoices and estimates LIST pages mounted in the same file; the detail pages are served by their harnesses" },
  { file: 'src/__tests__/job-cancel-reason.test.tsx', kind: 'getAnswer', count: 1, reason: "serves the Jobs list page mounted in the same file; the job detail page is served by its harness" },
  { file: 'src/__tests__/job-close-out-upgrade-null-closer.test.tsx', kind: 'getAnswer', count: 1, reason: "serves the activity panel's reads (a component beside the page); the job detail page is served by its harness" },
  { file: 'src/__tests__/note-delete-controls.test.tsx', kind: 'getAnswer', count: 1, reason: "serves the activity panel's reads (a component beside the page); the job detail page is served by its harness" },
  { file: 'src/__tests__/record-pages-refused.test.tsx', kind: 'getAnswer', count: 1, reason: "serves the customer page's reads, in a file that refuses the record pages through their harnesses" },
  { file: 'src/__tests__/reorder-by-tap.test.tsx', kind: 'getAnswer', count: 3, reason: "serves the settings list pages (decline reasons, sub-statuses, lists) mounted in the same file; the home page is served by the dashboard harness" },
  { file: 'src/__tests__/text-from-customer-phone-composer.test.tsx', kind: 'getAnswer', count: 2, reason: "serves the phone directory reader the composer uses; the invoice and job pages are served by their harnesses" },
  { file: 'src/pages/v2/jobs/__tests__/jobsV2Smoke.test.tsx', kind: 'getAnswer', count: 4, reason: "serves the Jobs list and the new-job form mounted in the same file; the job detail page is served by its harness" },
  { file: 'src/pages/v2/auth-public/__tests__/authPublic.test.tsx', kind: 'fetch', count: 2, reason: "the PUBLIC INVOICE page's fetch (cases 'public invoice ...'); the public estimate page is served by servePublicEstimate" },
  { file: 'src/__tests__/publicEntryGraph.test.tsx', kind: 'fetch', count: 1, reason: "the PUBLIC INVOICE page's fetch; the public estimate cases of the file use servePublicEstimate" },
  { file: 'src/__tests__/job-office-review.test.tsx', kind: 'getAnswer', count: 2, reason: "wraps the job harness's own implementation (getMockImplementation) and holds the job and review re-reads until the test lets them land: one server underneath, the hold is the case" },
  { file: 'src/__tests__/technician-no-refused-reads.test.tsx', kind: 'getAnswer', count: 1, reason: "records every read and passes it to the harness's implementation unchanged: one server underneath" },
  { file: 'src/pages/v2/inventory/__tests__/vendorFieldsFollowViewVendors.test.tsx', kind: 'getAnswer', count: 1, reason: "records the requested URLs and passes each to the harness's implementation unchanged: one server underneath" },
];

/** Whether a test mounts a registered page: by importing it or its harness, or through a module of the app that reaches it (a route table, the public app). */
function mountedPages(file: { path: string; source: string }, reach: Record<string, string[]>): string[] {
  const pages = Object.keys(mapping);
  const direct = Object.keys(scanPageImports({ tests: [file], pages }) as Record<string, number>);
  const mocked = new Set([...file.source.matchAll(/\bvi\.(?:mock|doMock)\(\s*['"]([^'"]+)['"]/g)].map((m) => resolveSpecifier(m[1]!, file.path)));
  const through = new Set<string>();
  for (const spec of importSpecifiers(file.source) as string[]) {
    const target = resolveSpecifier(spec, file.path) as string | null;
    for (const page of (target && reach[target]) || []) if (!mocked.has(page.replace(/\.[cm]?[jt]sx?$/, ''))) through.add(page);
  }
  return [...new Set([...direct, ...through])];
}

/** { file -> hits } for the files that mount a registered page, from `[{ path, source }]` and the reach map of the app's modules. */
export function ownServers(tests: Array<{ path: string; source: string }>, reach: Record<string, string[]>) {
  const found: Record<string, Array<{ kind: OwnServerKind; line: number }>> = {};
  for (const t of tests) {
    if (!mountedPages(t, reach).length) continue;
    const hits = ownServerHits(t.source);
    if (hits.length) found[t.path] = hits;
  }
  return found;
}

/** What is left of `found` after the exceptions: the hits no entry covers, and the entries that no longer match. */
export function unexcused(found: Record<string, Array<{ kind: OwnServerKind; line: number }>>, exceptions: Exception[]) {
  const left: string[] = [];
  for (const [file, hits] of Object.entries(found)) {
    for (const kind of Object.keys(OWN_SERVER_KINDS) as OwnServerKind[]) {
      const n = hits.filter((h) => h.kind === kind).length;
      const allowed = exceptions.find((e) => e.file === file && e.kind === kind)?.count ?? 0;
      if (n > allowed) left.push(`${file}: ${n - allowed} ${kind} (lines ${hits.filter((h) => h.kind === kind).map((h) => h.line).join(', ')})`);
    }
  }
  for (const e of exceptions) {
    const n = (found[e.file] ?? []).filter((h) => h.kind === e.kind).length;
    if (n !== e.count) left.push(`stale exception: ${e.file} ${e.kind} says ${e.count}, the file has ${n}`);
    if (!e.reason.trim()) left.push(`exception without a reason: ${e.file}`);
  }
  return left;
}

describe('no test that mounts a harnessed page answers its reads itself (#3259)', () => {
  const planted = (path: string, source: string) => ({ path, source });
  const jobPage = Object.keys(mapping)[0]!;
  const jobHarness = mapping[jobPage]![0]!;
  const viaHarness = `import { mountJob } from '@/${jobHarness.replace(/^src\//, '').replace(/\.tsx?$/, '')}';\n`;
  const noReach = {};

  it.each([
    ['a fetch stub', "vi.stubGlobal('fetch', vi.fn());", 'fetch'],
    ['an assignment to global.fetch', 'global.fetch = vi.fn();', 'fetch'],
    ['a replacement client that answers a get', "vi.mock('@/lib/axios', () => ({\n  default: { get: (url: string) => Promise.resolve({ data: {} }) },\n}));", 'axiosFactory'],
    ['get.mockImplementation on the mocked client', 'mockApi.get.mockImplementation(async () => ({ data: {} }));', 'getAnswer'],
    ['vi.mocked(api.get).mockResolvedValue', 'vi.mocked(api.get).mockResolvedValue({ data: {} });', 'getAnswer'],
    ['vi.mocked(api).get.mockReturnValueOnce', 'vi.mocked(api).get.mockReturnValueOnce(p);', 'getAnswer'],
    ['a spy on the client', "vi.spyOn(api, 'get').mockResolvedValue({});", 'getAnswer'],
  ])('finds %s in a file that imports the harness', (_what, line, kind) => {
    const found = ownServers([planted('src/__tests__/zz-own.test.tsx', `${viaHarness}${line}\n`)], noReach);
    expect(unexcused(found, [])).toEqual([expect.stringContaining(`1 ${kind}`)]);
  });

  it('finds the same in a file that imports the page itself, and in one that reaches it through a route module', () => {
    expect(Object.keys(ownServers([planted('src/__tests__/zz-a.test.tsx', `import P from '@/${jobPage.replace(/^src\//, '').replace(/\.tsx$/, '')}';\nmockApi.get.mockImplementation(f);\n`)], noReach))).toEqual(['src/__tests__/zz-a.test.tsx']);
    const routes = [{ path: 'src/routes.tsx', source: `import P from '@/${jobPage.replace(/^src\//, '').replace(/\.tsx$/, '')}'; export const r = P;` }];
    const reach = pageReach({ modules: [...routes, { path: jobPage, source: '' }], pages: [jobPage] }) as Record<string, string[]>;
    const t = planted('src/__tests__/zz-b.test.tsx', "import { routes } from '@/routes';\nvi.stubGlobal('fetch', vi.fn());\n");
    expect(Object.keys(ownServers([t], reach))).toEqual(['src/__tests__/zz-b.test.tsx']);
    // A test that replaces the page with `vi.mock` does not mount it.
    const mocks = planted('src/__tests__/zz-c.test.tsx', `import { routes } from '@/routes';\nvi.mock('@/${jobPage.replace(/^src\//, '').replace(/\.tsx$/, '')}', () => ({}));\nvi.stubGlobal('fetch', vi.fn());\n`);
    expect(ownServers([mocks], reach)).toEqual({});
  });

  it('leaves alone a file that mounts no harnessed page, a bare get stub, and a write outcome', () => {
    expect(ownServers([planted('src/__tests__/zz-d.test.tsx', "vi.stubGlobal('fetch', vi.fn());\n")], noReach)).toEqual({});
    expect(ownServerHits("vi.mock('@/lib/axios', () => ({\n  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },\n}));\nvi.mock('x', () => ({ a: 1 }));")).toEqual([]);
    expect(ownServerHits('mockApi.post.mockResolvedValue({});\nvi.mocked(api.patch).mockImplementation(f);')).toEqual([]);
  });

  it('turns an exception red when its count is stale or its reason is empty, and lets a covered hit through', () => {
    const found = ownServers([planted('src/__tests__/zz-e.test.tsx', `${viaHarness}mockApi.get.mockImplementation(a);\n`)], noReach);
    const ok: Exception = { file: 'src/__tests__/zz-e.test.tsx', kind: 'getAnswer', count: 1, reason: 'serves another page' };
    expect(unexcused(found, [ok])).toEqual([]);
    expect(unexcused(found, [{ ...ok, count: 2 }])).toEqual([expect.stringContaining('stale exception')]);
    expect(unexcused(found, [{ ...ok, reason: ' ' }])).toEqual([expect.stringContaining('without a reason')]);
    expect(unexcused({}, [ok])).toEqual([expect.stringContaining('stale exception')]);
  });

  it('finds none in the tree beyond the listed exceptions', () => {
    const modules = sourceFiles()
      .filter((f) => !/(^|\/)__tests__\//.test(rel(f)))
      .map((f) => ({ path: rel(f), source: readFileSync(f, 'utf8') }));
    const reach = pageReach({ modules, pages: Object.keys(mapping) }) as Record<string, string[]>;
    expect(unexcused(ownServers(files.map((f) => ({ path: f.path, source: f.text })), reach), EXCEPTIONS)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ways a test could name a registered page or harness that the brake's import scan does not read (it reads `import` and
// `require` with a string): `vi.importActual('<page>')`, and an `import()` / `require()` / `importActual()` whose argument is
// built at run time and mentions the pages or the harness folder. The first is exact; the second catches the forms that
// spell a path ("`@/pages/v2/${name}`"); a path assembled from variables that name neither cannot be told from a data file
// (the repo has a few of those: the tailwind config and the instrument scripts are read by `import(file)`).

/** The lines of a test file that reach a registered page or harness in a way the brake does not count. */
export function hiddenPageReferences(path: string, source: string, registered: string[]): number[] {
  const bases = new Set(registered.map((p) => p.replace(/\.[cm]?[jt]sx?$/, '')));
  const lines: number[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  for (const m of source.matchAll(/\b(?:importActual|importOriginal)\s*(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\1/g)) {
    const target = resolveSpecifier(m[2]!, path) as string | null;
    if (target && bases.has(target)) lines.push(lineOf(m.index!));
  }
  for (const m of source.matchAll(/\b(?:import|require|importActual)\s*\(\s*(?!\/\*[^*]*\*\/\s*)([^)]*)\)/g)) {
    const arg = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (/^(['"])[^'"]*\1$/.test(arg)) continue; // a plain string: the brake reads it
    if (/pages\/|\/harness\/|Page\b/.test(arg)) lines.push(lineOf(m.index!));
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

describe('a page cannot be mounted through a form the brake does not read (#3259, D14)', () => {
  const page = Object.keys(mapping)[0]!;
  const harness = mapping[page]![0]!;
  const alias = (p: string) => `@/${p.replace(/^src\//, '').replace(/\.tsx?$/, '')}`;
  const all = [...Object.keys(mapping), ...Object.values(mapping).flat()];

  it.each([
    ['vi.importActual of a page', `const actual = await vi.importActual('${alias(page)}');`],
    ['importOriginal of a page', `vi.mock('x', async (importOriginal) => importOriginal('${alias(page)}'));`],
    ['vi.importActual of a harness', `await vi.importActual("${alias(harness)}");`],
    ['a computed import() that spells the pages folder', 'const m = await import(`@/pages/v2/jobs/${name}`);'],
    ['a computed require() naming a page variable', 'const m = require(pageFile);\nconst pageFile = "x";'.replace('pageFile)', 'JobDetailPage + ext)')],
  ])('finds %s', (_what, line) => {
    expect(hiddenPageReferences('src/__tests__/zz.test.tsx', `${line}\n`, all)).toEqual([1]);
  });

  it('leaves alone a string import, a data file read by a variable, and a stub of a page', () => {
    expect(hiddenPageReferences('src/__tests__/zz.test.tsx', `import P from '${alias(page)}';\nawait import(/* @vite-ignore */ file);\nvi.mock('${alias(page)}', () => ({}));\n`, all)).toEqual([]);
  });

  it('finds none in the tree', () => {
    // This file spells the forms it looks for, in its own planted sources.
    const offenders = files.filter((f) => !f.path.endsWith('harness/page-harnesses.guard.test.ts')).flatMap((f) => hiddenPageReferences(f.path, f.text, all).map((line) => `${f.path}:${line}`));
    expect(offenders).toEqual([]);
  });
});
