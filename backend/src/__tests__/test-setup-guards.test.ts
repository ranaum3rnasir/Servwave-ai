import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as tz from 'date-fns-tz';

// The production server is compiled to CommonJS, so `require('date-fns-tz')` is what it runs. Resolved here the
// same way, from the backend folder.
const productionRequire = createRequire(path.join(process.cwd(), 'package.json'));

describe('date-fns-tz in tests', () => {
  it('is the very code the production server loads (its CommonJS build), not the ESM build that pulls in the whole date-fns barrel', () => {
    const production = productionRequire('date-fns-tz') as typeof tz;
    expect(tz.fromZonedTime).toBe(production.fromZonedTime);
    expect(tz.toZonedTime).toBe(production.toZonedTime);
    expect(tz.formatInTimeZone).toBe(production.formatInTimeZone);
    expect(tz.format).toBe(production.format);
    expect(tz.getTimezoneOffset).toBe(production.getTimezoneOffset);
    expect(tz.toDate).toBe(production.toDate);
  });

  it('still converts a wall clock across a daylight-saving change', () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 -> 03:00); 2026-03-08 12:00 is EDT (UTC-4).
    expect(tz.fromZonedTime('2026-03-08T12:00:00', 'America/New_York').toISOString()).toBe('2026-03-08T16:00:00.000Z');
    expect(tz.formatInTimeZone(new Date('2026-03-08T04:59:00Z'), 'America/New_York', 'yyyy-MM-dd')).toBe('2026-03-07');
  });
});

// ---- helpers: run a snippet in plain node, with no vitest in the process ----------------------------------------
const BACKEND = process.cwd();
const REPO = path.join(BACKEND, '..');
function inPlainNode(code: string, args: string[] = []): unknown {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: BACKEND, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`plain node failed: ${r.stderr.slice(0, 600)}`);
  return JSON.parse(r.stdout);
}

// ---- file isolation: every test file keeps its own module graph -------------------------------------------------
// Checked by what vitest RESOLVES, not by how a config is written: every config the backend can be run with is
// resolved through vitest's own node API (projects, extends and plugins included), and every project it yields must
// have isolation on and the forks pool (vitest 4 has no poolOptions; running files one after another, which CI does with
// --no-file-parallelism, still gives each file its own module graph). A behavioural probe (isolation-probe-a/b) backs it.

type ResolvedProject = { name: string; isolate: unknown; pool: unknown; setupFiles: string[]; globalSetup: string[] };
const ALLOWED_SETUP_FILE = path.join(BACKEND, 'src/__tests__/setup.ts');
// The one global setup (#3244): it only names the migration base template and drops it at the end; it builds nothing.
const ALLOWED_GLOBAL_SETUP = path.join(BACKEND, 'src/__tests__/migration-base.global-setup.ts');

function projectViolations(where: string, projects: ResolvedProject[]): string[] {
  const out: string[] = [];
  if (projects.length === 0) out.push(`${where}: resolves to no project`);
  for (const p of projects) {
    if (p.isolate === false) out.push(`${where} [${p.name}]: isolate is false`);
    if (p.pool !== 'forks') out.push(`${where} [${p.name}]: pool is ${String(p.pool)}, not forks`);
    if (p.setupFiles.length !== 1 || p.setupFiles[0] !== ALLOWED_SETUP_FILE) out.push(`${where} [${p.name}]: setupFiles are ${JSON.stringify(p.setupFiles)}`);
    if (p.globalSetup.some((g) => g !== ALLOWED_GLOBAL_SETUP) || p.globalSetup.length > 1) out.push(`${where} [${p.name}]: globalSetup is ${JSON.stringify(p.globalSetup)}`);
  }
  return out;
}

/** Flags that switch isolation off or pick a threads/VM pool, bare or quoted. */
const ISOLATION_FLAGS = /--no-isolate|--isolate(?:[= ]\s*|=)['"]?false|--pool(?:[= ]\s*|=)['"]?(?:threads|vmThreads|vmForks)/;

/** The commands in a script, workflow or package.json that start vitest (directly or through the backend `test` scripts),
 *  with backslash line continuations joined. Each is the text from the first such word to the end of its line. */
function vitestCommands(text: string): string[] {
  const joined = text.replace(/\\\r?\n\s*/g, ' ').replace(/\\"/g, '"');
  const out: string[] = [];
  for (const line of joined.split('\n')) {
    const m = /vitest|npm\s+(?:-w\s+\S+\s+|--workspace[= ]\S+\s+)?(?:run\s+)?test\b/.exec(line);
    if (m) out.push(line.slice(m.index));
  }
  return out;
}

/** The `--config`/`-c` values in one command; a value that is not a plain path is a violation (fail closed). */
function configArgs(command: string): { configs: string[]; violations: string[] } {
  const configs: string[] = [];
  const violations: string[] = [];
  for (const m of command.matchAll(/(?:^|\s)(?:--config|-c)(?:=|\s+|$)(\S*)/g)) {
    const value = m[1].replace(/^['"]|['",;]*$/g, '').replace(/['"]$/, '');
    if (!value || /[$`()]|\$\{/.test(value)) violations.push(`config argument is not a plain path: "${m[1]}"`);
    else configs.push(value);
  }
  return { configs, violations };
}

function filesThatRunVitest(): string[] {
  const list = [path.join(BACKEND, 'package.json'), path.join(REPO, 'package.json')];
  for (const dir of [path.join(BACKEND, 'scripts'), path.join(REPO, '.github/workflows')]) {
    for (const f of fs.readdirSync(dir)) if (/\.(?:sh|ya?ml)$/.test(f)) list.push(path.join(dir, f));
  }
  return list;
}

/** Every config the backend can be run with: files named vitest*.config.*, plus every --config/-c value in the places that run vitest. */
function allBackendConfigs(): { configs: string[]; violations: string[] } {
  const found = new Set(fs.readdirSync(BACKEND).filter((f) => /^vitest.*\.(?:c|m)?(?:ts|js)$/.test(f)).map((f) => path.join(BACKEND, f)));
  const violations: string[] = [];
  for (const file of filesThatRunVitest()) {
    for (const command of vitestCommands(fs.readFileSync(file, 'utf8'))) {
      const { configs, violations: v } = configArgs(command);
      violations.push(...v.map((x) => `${path.relative(REPO, file)}: ${x}`));
      for (const c of configs) {
        const hit = [path.join(BACKEND, c), path.join(REPO, c)].find((p) => fs.existsSync(p));
        if (hit) found.add(hit);
        else violations.push(`${path.relative(REPO, file)}: config ${c} does not exist`);
      }
    }
  }
  return { configs: [...found].sort(), violations };
}

const RESOLVE_PROJECTS = `
import { createVitest } from 'vitest/node';
const v = await createVitest('test', { config: process.argv[1], watch: false, run: false, root: process.cwd() }, {});
const out = v.projects.map((p) => ({ name: p.name, isolate: p.config.isolate, pool: p.config.pool, setupFiles: p.config.setupFiles ?? [], globalSetup: p.config.globalSetup ?? [] }));
await v.close();
console.log(JSON.stringify(out));
`;

describe('file isolation', () => {
  const planted = (over: Partial<ResolvedProject>): ResolvedProject[] => [{ name: 'p', isolate: true, pool: 'forks', setupFiles: [ALLOWED_SETUP_FILE], globalSetup: [ALLOWED_GLOBAL_SETUP], ...over }];

  it.each([
    ['isolate off', { isolate: false }],
    ['threads pool', { pool: 'threads' }],
    ['vm threads pool', { pool: 'vmThreads' }],
    ['vm forks pool', { pool: 'vmForks' }],
    ['a second setup file', { setupFiles: [ALLOWED_SETUP_FILE, '/x/other.ts'] }],
    ['a different setup file', { setupFiles: ['/x/other.ts'] }],
    ['a global setup other than the migration base one', { globalSetup: ['/x/g.ts'] }],
    ['an extra global setup', { globalSetup: [ALLOWED_GLOBAL_SETUP, '/x/g.ts'] }],
  ])('the project check catches %s', (_name, over) => {
    expect(projectViolations('c', planted(over as Partial<ResolvedProject>)).length).toBeGreaterThan(0);
  });

  it('the project check accepts the shipped shape, and files one after another', () => {
    expect(projectViolations('c', planted({}))).toEqual([]);
    expect(projectViolations('c', [...planted({}), ...planted({ name: 'q' })])).toEqual([]);
    expect(projectViolations('c', [])).toHaveLength(1);
  });

  it.each([
    ['vitest run --no-isolate', true],
    ['vitest run --isolate=false', true],
    ['vitest run --isolate false', true],
    ["vitest run --isolate 'false'", true],
    ['vitest run --pool=threads', true],
    ['vitest run --pool threads', true],
    ["vitest run --pool 'threads'", true],
    ['vitest run --pool="threads"', true],
    ['vitest run --pool=vmForks', true],
    ['vitest run --no-file-parallelism --retry=2', false],
    ['vitest run --pool=forks', false],
  ])('the command-line check on "%s" says %s', (line, bad) => {
    expect(ISOLATION_FLAGS.test(line)).toBe(bad);
  });

  it.each([
    ['vitest run --config vitest.a.config.ts', ['vitest.a.config.ts'], 0],
    ['vitest run --config=vitest.a.config.ts', ['vitest.a.config.ts'], 0],
    ['npx vitest run -c lanes.ts --retry=2', ['lanes.ts'], 0],
    ['"test": "vitest run --config \'x.ts\'",', ['x.ts'], 0],
    ['npm -w backend run test -- --config lanes.ts', ['lanes.ts'], 0],
    ['npx vitest run --config "$CFG"', [], 1],
    ['npx vitest run --config $(pick)', [], 1],
    ['npx vitest run --config', [], 1],
    ['npx vitest run src/a.test.ts', [], 0],
  ])('the config-argument check reads "%s"', (line, configs, bad) => {
    const [command] = vitestCommands(line);
    const r = configArgs(command);
    expect(r.configs).toEqual(configs);
    expect(r.violations).toHaveLength(bad);
  });

  it('joins backslash continuations before reading a command', () => {
    expect(vitestCommands('run: |\n  npx vitest run \\\n    --config lanes.ts')[0]).toContain('--config lanes.ts');
  });

  it('no script, workflow or package.json passes a flag that switches isolation off', () => {
    for (const f of filesThatRunVitest()) expect(fs.readFileSync(f, 'utf8'), path.relative(REPO, f)).not.toMatch(ISOLATION_FLAGS);
  });

  it('every config the backend can run with resolves, through vitest itself, to isolated forks projects with the one setup file', () => {
    const { configs, violations } = allBackendConfigs();
    expect(configs.map((c) => path.basename(c))).toEqual(expect.arrayContaining(['vitest.config.ts', 'vitest.authorization.config.ts']));
    const problems = [...violations];
    for (const config of configs) {
      problems.push(...projectViolations(path.relative(REPO, config), inPlainNode(RESOLVE_PROJECTS, [config]) as ResolvedProject[]));
    }
    expect(problems).toEqual([]);
  }, 120_000);
});

// ---- what the test run really replaces --------------------------------------------------------------------------
// Checked by outcome, however a replacement is written (vi.mock, vitest.mock, an alias, a plugin, a project's setup,
// a helper every suite imports): each runtime dependency, as a test sees it, must have the same exports as the real
// module loaded by plain node, and none of them may be a mock function. Only the packages named here may differ.
const REPLACED_ON_PURPOSE: Record<string, string> = {
  '@google/genai': 'the AI SDK: never reach the network from a test (setup.ts)',
  'express-rate-limit': 'passthrough limiter so tests are not throttled (setup.ts)',
};
const NO_RUNTIME_MODULE: Record<string, string> = {
  '@types/multer': 'type declarations only; there is no module to import',
};

/** Packages whose package.json points the test runner at a different build (an ES module build) than plain node's
 *  require/import, so the export lists legitimately differ. They are still checked for the exports that must exist and for
 *  mock functions, but not for an identical list. */
const OTHER_BUILD_IN_RUNNER: Record<string, { reason: string; mustExport: string[] }> = {
  rrule: { reason: 'its "module" field is an ES build the runner picks; plain node loads the CommonJS build', mustExport: ['RRule', 'RRuleSet', 'rrulestr', 'Frequency'] },
};

type Shape = Record<string, string>;
/** name -> type, plus a short hash of a function's source, so a look-alike with the same names still differs. */
function shapeOf(mod: Record<string, unknown>): Shape {
  const out: Shape = {};
  for (const key of Object.keys(mod).sort()) {
    if (key === 'default') continue;
    const v = mod[key];
    out[key] = typeof v === 'function' ? `function:${createHash('sha1').update(Function.prototype.toString.call(v)).digest('hex').slice(0, 10)}` : typeof v;
  }
  return out;
}

const SHAPES_IN_PLAIN_NODE = `
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(process.cwd() + '/package.json');
const shape = (mod) => { const out = {}; for (const k of Object.keys(mod).sort()) { if (k === 'default') continue; const v = mod[k]; out[k] = typeof v === 'function' ? 'function:' + createHash('sha1').update(Function.prototype.toString.call(v)).digest('hex').slice(0, 10) : typeof v; } return out; };
const names = JSON.parse(process.argv[1]);
const out = {};
for (const n of names) { try { out[n] = shape(n === 'date-fns-tz' ? require(n) : await import(n)); } catch (e) { out[n] = { error: String(e.message).slice(0, 200) }; } }
console.log(JSON.stringify(out));
`;

function shapeDifferences(real: Shape, seen: Shape): string[] {
  const out: string[] = [];
  for (const k of Object.keys(real)) if (!(k in seen)) out.push(`missing export ${k}`);
  for (const k of Object.keys(seen)) if (!(k in real)) out.push(`extra export ${k}`);
  for (const k of Object.keys(real)) if (k in seen && real[k] !== seen[k]) out.push(`export ${k} differs (${real[k]} vs ${seen[k]})`);
  return out;
}

/** The helper modules many suites import (4 today: helpers, permission-switches-fixture, support/switchDependants, migration-deploy-support).
 *  A module-swapping call in one of them runs when a suite imports it, so the check below loads them first, as a suite would. */
function widelySharedHelpers(): string[] {
  const dir = path.join(BACKEND, 'src/__tests__');
  const counts = new Map<string, number>();
  const tests = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
  for (const f of tests) {
    for (const m of fs.readFileSync(path.join(dir, f), 'latin1').matchAll(/from '(\.\/[a-zA-Z0-9_./-]+)'/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= 15).map(([p]) => p).sort();
}

describe('what a test sees of each runtime dependency', () => {
  it('finds the widely shared helper modules (so the check below has something to load)', () => {
    expect(widelySharedHelpers()).toEqual(expect.arrayContaining(['./helpers', './permission-switches-fixture']));
  });

  it.each([
    ['same', { a: 'function:1', b: 'object' }, { a: 'function:1', b: 'object' }, 0],
    ['an export missing', { a: 'function:1', b: 'object' }, { a: 'function:1' }, 1],
    ['an export added', { a: 'function:1' }, { a: 'function:1', c: 'function:2' }, 1],
    ['a look-alike with the same names but other code', { a: 'function:1' }, { a: 'function:9' }, 1],
    ['a stub with no exports', { a: 'function:1' }, {}, 1],
  ])('the comparison on %s', (_name, real, seen, count) => {
    expect(shapeDifferences(real as Shape, seen as Shape)).toHaveLength(count);
  });

  it('every runtime dependency is the real module, not a replacement: same exports as plain node, no mock functions', async () => {
    for (const helper of widelySharedHelpers()) await import(/* @vite-ignore */ path.join(BACKEND, 'src/__tests__', helper));
    const dependencies = Object.keys(JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8')).dependencies as Record<string, string>);
    const checked = dependencies.filter((d) => !(d in REPLACED_ON_PURPOSE) && !(d in NO_RUNTIME_MODULE));
    const exactly = checked.filter((d) => !(d in OTHER_BUILD_IN_RUNNER));
    const real = inPlainNode(SHAPES_IN_PLAIN_NODE, [JSON.stringify(exactly)]) as Record<string, Shape | { error: string }>;
    const problems: string[] = [];
    for (const name of checked) {
      const expected = real[name];
      if (name in OTHER_BUILD_IN_RUNNER) {
        const loaded = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
        for (const k of OTHER_BUILD_IN_RUNNER[name].mustExport) if (!(k in loaded)) problems.push(`${name}: missing export ${k}`);
        for (const [k, v] of Object.entries(loaded)) if (typeof v === 'function' && vi.isMockFunction(v)) problems.push(`${name}: export ${k} is a mock function`);
        continue;
      }
      if ('error' in expected && typeof expected.error === 'string') {
        problems.push(`${name}: cannot be imported in plain node (${expected.error}); list it with a reason or fix it`);
        continue;
      }
      const seen = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
      for (const d of shapeDifferences(expected as Shape, shapeOf(seen))) problems.push(`${name}: ${d}`);
      for (const [k, v] of Object.entries(seen)) if (typeof v === 'function' && vi.isMockFunction(v)) problems.push(`${name}: export ${k} is a mock function`);
    }
    expect(problems).toEqual([]);
    // The two lists name real dependencies, so a rename cannot leave a stale exemption behind.
    for (const n of [...Object.keys(REPLACED_ON_PURPOSE), ...Object.keys(NO_RUNTIME_MODULE), ...Object.keys(OTHER_BUILD_IN_RUNNER)]) expect(dependencies, n).toContain(n);
  }, 120_000);
});
