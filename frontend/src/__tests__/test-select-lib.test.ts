/**
 * Test selection (#3257): the policy as a pure function over PLANTED facts. One test per fail-open row, per
 * full-run trigger and for the same-tree rule; expected reason codes come from the ticket text. The triggers
 * and known areas are the REAL lists file (so a trigger removed from it turns a row red); only the always-run
 * patterns are replaced by a tiny fixture pattern, because the fixture repository has three test files.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CHANGED_PATHS,
  decideEarly,
  decideSelection,
  failingFiles,
  globToRegExp,
  normalizeMode,
  selectionPhrase,
  shadowReport,
  type Change,
  type Lists,
  type SelectionInput,
} from '../../scripts/test-select-lib.mjs';

const REAL: Lists = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/test-select-lists.json'), 'utf8'));
const LISTS: Lists = { ...REAL, alwaysRun: ['frontend/src/**/*guard*.test.ts'] };

const HEAD = 'bbbb000000000000000000000000000000000002';
const BASE_TIP = 'aaaa000000000000000000000000000000000001';
const MERGE_BASE = 'cccc000000000000000000000000000000000003';
const BUTTON = 'frontend/src/components/Button.tsx';
const BUTTON_TEST = 'frontend/src/components/__tests__/Button.test.tsx';
const BUTTON_SNAP = 'frontend/src/components/__tests__/__snapshots__/Button.test.tsx.snap';
const HOME_TEST = 'frontend/src/pages/__tests__/Home.test.tsx';
const GUARD = 'frontend/src/__tests__/disk-reader.guard.test.ts';
const TRACKED = [
  'package-lock.json', 'package.json', 'docs/ci.md', 'backend/src/x.ts',
  'frontend/package.json', 'frontend/src/pages/Home.tsx', BUTTON, BUTTON_TEST, BUTTON_SNAP, HOME_TEST, GUARD,
];

/** A pull request into staging that touches Button.tsx, whose test the tool lists: every row starts from here. */
function facts(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    mode: 'on',
    shard: false,
    event: 'pull_request',
    baseRef: 'staging',
    eventHeadSha: HEAD,
    parents: [BASE_TIP, HEAD],
    shallow: false,
    mergeBase: MERGE_BASE,
    baseUsed: MERGE_BASE,
    diffTree: 'tree1',
    listTree: 'tree1',
    changed: [{ status: 'M', path: BUTTON }],
    tracked: TRACKED,
    listed: [BUTTON_TEST],
    lists: LISTS,
    ...over,
  };
}

const change = (status: string, path: string, oldPath?: string): Change => (oldPath ? { status, path, oldPath } : { status, path });

describe('a selected run', () => {
  it('runs the tests the tool reaches plus the always-run list, as paths relative to the frontend folder', () => {
    const d = decideSelection(facts());
    expect(d).toMatchObject({ mode: 'selected', reason: 'changed-files', total: 3 });
    expect(d.files).toEqual(['src/__tests__/disk-reader.guard.test.ts', 'src/components/__tests__/Button.test.tsx']);
    expect(selectionPhrase(d)).toBe('selected 2 of 3, reason=changed-files');
  });

  it('always contains the always-run list, even when the change reaches no test at all', () => {
    const d = decideSelection(facts({ changed: [change('M', 'docs/ci.md')], listed: [] }));
    expect(d).toMatchObject({ mode: 'selected', reason: 'always-run-only' });
    expect(d.files).toEqual(['src/__tests__/disk-reader.guard.test.ts']);
  });

  it('adds a changed test file even when the tool does not list it', () => {
    const d = decideSelection(facts({ changed: [change('M', HOME_TEST)], listed: [] }));
    expect(d.files).toContain('src/pages/__tests__/Home.test.tsx');
  });

  it('lets a deleted test file go: nothing is selected for it and the run stays selected', () => {
    const d = decideSelection(facts({ changed: [change('D', HOME_TEST)], tracked: TRACKED.filter((p) => p !== HOME_TEST), listed: [] }));
    expect(d.mode).toBe('selected');
  });

  it('lets a renamed test file go, selecting the new name', () => {
    const renamed = 'frontend/src/pages/__tests__/HomeRenamed.test.tsx';
    const d = decideSelection(facts({ changed: [change('R', renamed, HOME_TEST)], tracked: [...TRACKED.filter((p) => p !== HOME_TEST), renamed], listed: [renamed] }));
    expect(d.mode).toBe('selected');
    expect(d.files).toContain('src/pages/__tests__/HomeRenamed.test.tsx');
  });

  it('accepts exactly the changed-path ceiling', () => {
    const many = Array.from({ length: MAX_CHANGED_PATHS }, (_, i) => change('M', `docs/page-${i}.md`));
    const d = decideSelection(facts({ changed: many, tracked: [...TRACKED, ...many.map((c) => c.path)], listed: [] }));
    expect(d.mode).toBe('selected');
  });

  it('does not change its input', () => {
    const input = facts();
    const before = JSON.stringify(input);
    decideSelection(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('a changed snapshot selects its test', () => {
  it('selects the test the snapshot sits beside even when the tool lists nothing', () => {
    const d = decideSelection(facts({ changed: [change('M', BUTTON_SNAP)], listed: [] }));
    expect(d.mode).toBe('selected');
    expect(d.files).toContain('src/components/__tests__/Button.test.tsx');
  });

  it('is a full run when the snapshot has no test beside it', () => {
    const orphan = 'frontend/src/components/__tests__/__snapshots__/Gone.test.tsx.snap';
    const d = decideSelection(facts({ changed: [change('A', orphan)], tracked: [...TRACKED, orphan], listed: [] }));
    expect(d).toMatchObject({ mode: 'full', reason: 'snapshot-without-test' });
  });
});

describe('fail-open rows: each is a full run with its own reason code', () => {
  const rows: [string, Partial<SelectionInput>, string][] = [
    ['the selector throws', { selectorError: 'threw' }, 'selector-threw'],
    ['the selector hangs past its limit', { selectorError: 'timeout' }, 'selector-timeout'],
    ['the event is not a pull request (a push)', { event: 'push' }, 'not-pull-request'],
    ['the base is not staging', { baseRef: 'feature/x' }, 'base-not-staging'],
    ['the clone is shallow', { shallow: true }, 'shallow-clone'],
    ['it cannot be told whether the clone is shallow', { shallow: null }, 'shallow-clone'],
    ['HEAD is a single-parent commit (not a merge)', { parents: [HEAD] }, 'not-two-parent-merge'],
    ['HEAD is an octopus merge', { parents: [BASE_TIP, HEAD, 'dddd'] }, 'not-two-parent-merge'],
    ['the parents are unknown', { parents: null }, 'not-two-parent-merge'],
    ['the second parent is not the event head', { parents: [BASE_TIP, 'eeee000000000000000000000000000000000005'] }, 'head-mismatch'],
    ['the event head is unknown', { eventHeadSha: '' }, 'head-mismatch'],
    ['there is no merge base', { mergeBase: null, baseUsed: null }, 'no-merge-base'],
    ['the tool was asked about a base that is not the merge base', { baseUsed: BASE_TIP }, 'base-not-merge-base'],
    ['the changed-path list is missing', { changed: null }, 'no-changed-list'],
    ['more than 300 paths changed', { changed: Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => change('M', `docs/p${i}.md`)) }, 'too-many-paths'],
    ['a source file is deleted', { changed: [change('D', BUTTON)] }, 'deleted-source'],
    ['a non-code file is deleted', { changed: [change('D', 'docs/ci.md')] }, 'deleted-source'],
    ['a source file is renamed', { changed: [change('R', 'frontend/src/components/ButtonX.tsx', BUTTON)], tracked: [...TRACKED, 'frontend/src/components/ButtonX.tsx'] }, 'renamed-source'],
    ['a path is in no area the policy knows', { changed: [change('M', 'somewhere/new/file.ts')] }, 'unclassified-path'],
    ['a path holds a control character', { changed: [change('M', 'docs/a\nb.md')] }, 'unclassified-path'],
    ['a path climbs out of the repository', { changed: [change('M', 'docs/../../etc/x')] }, 'unclassified-path'],
    ['a change has a status the policy does not know (type change)', { changed: [change('T', BUTTON)] }, 'unclassified-path'],
    ['the tool lists a file whose case differs from the tracked path', { listed: ['frontend/src/components/__tests__/button.test.tsx'] }, 'case-mismatch'],
    ['a changed path differs from the tracked path only in case', { changed: [change('M', 'frontend/src/components/button.tsx')] }, 'case-mismatch'],
    ['two tracked paths differ only in case', { tracked: [...TRACKED, 'frontend/src/components/BUTTON.tsx'] }, 'case-mismatch'],
    ['the tool lists a file that is not tracked', { listed: ['frontend/src/generated/Made.test.tsx'] }, 'listed-not-tracked'],
    ['the tool lists a file outside the repository', { listed: ['/elsewhere/x.test.tsx'] }, 'listed-not-tracked'],
    ['a changed file is not tracked', { changed: [change('M', 'frontend/src/components/New.tsx')] }, 'changed-not-tracked'],
    ['the tool output is unreadable', { listed: null }, 'selector-bad-output'],
    ['no test matches the always-run patterns', { lists: { ...LISTS, alwaysRun: ['frontend/nothing/**'] } }, 'empty-always-run'],
  ];
  it.each(rows)('%s', (_name, over, reason) => {
    const d = decideSelection(facts(over));
    expect(d).toMatchObject({ mode: 'full', reason, files: [] });
  });

  it.each([
    'frontend/scripts/test-select-lib.mjs',
    'frontend/scripts/test-select-io.mjs',
    'frontend/scripts/test-select-lists.json',
    'frontend/scripts/test-ci.mjs',
    'frontend/scripts/test-ci-lib.mjs',
    'frontend/scripts/test-ci-policy.json',
    'frontend/scripts/test-brake-lib.mjs',
    'frontend/scripts/__fixtures__/test-ci/ok.test.ts',
    'frontend/test-budget.json',
    'frontend/test-page-ceilings.json',
    'frontend/test-time-baseline.json',
  ])('the pull request edits the selector or its lists: %s', (path) => {
    expect(decideSelection(facts({ changed: [change('M', path)] }))).toMatchObject({ mode: 'full', reason: 'selector-edited' });
  });

  it('the selector-edited check looks at the old name of a rename too', () => {
    expect(decideSelection(facts({ changed: [change('R', 'docs/moved.md', 'frontend/scripts/test-select-lists.json')] })).reason).toBe('selector-edited');
  });

  it('does not depend on the lists file to know what the selector is (a pull request that empties the lists still gets a full run)', () => {
    const d = decideSelection(facts({ changed: [change('M', 'frontend/scripts/test-select-lists.json')], lists: { alwaysRun: [], triggers: [], knownAreas: ['*', 'frontend/**'] } }));
    expect(d.reason).toBe('selector-edited');
  });
});

describe('same-tree rule: the diff and the file list come from one tree', () => {
  it('is a full run when the tree the list was taken from is not the tree the diff was taken from', () => {
    expect(decideSelection(facts({ diffTree: 'tree1', listTree: 'tree2' }))).toMatchObject({ mode: 'full', reason: 'tree-mismatch' });
  });

  it('is a full run when the working tree was dirty at list time', () => {
    expect(decideSelection(facts({ listTree: 'dirty' })).reason).toBe('tree-mismatch');
  });

  it('is a full run when either tree is unknown', () => {
    expect(decideSelection(facts({ diffTree: null, listTree: null })).reason).toBe('tree-mismatch');
    expect(decideSelection(facts({ listTree: null })).reason).toBe('tree-mismatch');
  });

  it('selects when both are the same tree', () => {
    expect(decideSelection(facts({ diffTree: 'x', listTree: 'x' })).mode).toBe('selected');
  });
});

describe('full-run triggers: each forces a full run with its own code', () => {
  const triggers: [string, string][] = [
    ['package-lock.json', 'lockfile'],
    ['frontend/package-lock.json', 'lockfile'],
    ['backend/package-lock.json', 'lockfile'],
    ['package.json', 'package-manifest'],
    ['frontend/package.json', 'package-manifest'],
    ['backend/package.json', 'package-manifest'],
    ['.nvmrc', 'package-manifest'],
    ['frontend/tsconfig.json', 'tsconfig'],
    ['frontend/tsconfig.node.json', 'tsconfig'],
    ['backend/tsconfig.build.json', 'tsconfig'],
    ['frontend/vitest.config.ts', 'test-config'],
    ['frontend/vite.config.ts', 'test-config'],
    ['frontend/vendor-chunks.ts', 'test-config'],
    ['frontend/pwa-manifest.ts', 'test-config'],
    ['frontend/public-page-routing.ts', 'test-config'],
    ['frontend/public-entry-build.ts', 'test-config'],
    ['frontend/public-early-script.ts', 'test-config'],
    ['frontend/public-early.template.js', 'test-config'],
    ['frontend/src/__tests__/setup.ts', 'setup-file'],
    ['.github/workflows/ci.yml', 'workflows'],
    ['.github/workflows/ci-nightly.yml', 'workflows'],
    ['frontend/.env.example', 'env-file'],
    ['frontend/.env.production', 'env-file'],
  ];
  it.each(triggers)('%s -> %s', (path, code) => {
    const d = decideSelection(facts({ changed: [change('M', path)] }));
    expect(d).toMatchObject({ mode: 'full', reason: code });
  });

  it('fires on a deleted trigger file and on the old name of a renamed one', () => {
    expect(decideSelection(facts({ changed: [change('D', 'package-lock.json')] })).reason).toBe('lockfile');
    expect(decideSelection(facts({ changed: [change('R', 'docs/moved.md', 'frontend/tsconfig.json')] })).reason).toBe('tsconfig');
  });

  it('wins over a plain source change in the same pull request', () => {
    expect(decideSelection(facts({ changed: [change('M', BUTTON), change('M', 'package-lock.json')] })).reason).toBe('lockfile');
  });
});

describe('always full: the cases that never select', () => {
  const rows: [string, Parameters<typeof decideEarly>[0], string][] = [
    ['the variable is unset', { mode: undefined, event: 'pull_request', baseRef: 'staging' }, 'off'],
    ['the variable is empty', { mode: '', event: 'pull_request', baseRef: 'staging' }, 'off'],
    ['the variable is off', { mode: 'off', event: 'pull_request', baseRef: 'staging' }, 'off'],
    ['the variable is something else', { mode: 'true', event: 'pull_request', baseRef: 'staging' }, 'invalid-mode'],
    ['the variable is spelled in capitals', { mode: 'ON', event: 'pull_request', baseRef: 'staging' }, 'invalid-mode'],
    ['the hosted fallback runs a shard', { mode: 'on', shard: true, event: 'pull_request', baseRef: 'staging' }, 'hosted-shard'],
    ['a promotion pull request into main', { mode: 'on', event: 'pull_request', baseRef: 'main' }, 'promotion-into-main'],
    ['a push to main', { mode: 'on', event: 'push', baseRef: '' }, 'not-pull-request'],
    ['the nightly run', { mode: 'on', event: 'schedule', baseRef: '' }, 'nightly'],
    ['a manual run from the Actions page', { mode: 'on', event: 'workflow_dispatch', baseRef: '' }, 'manual'],
    ['a run outside Actions (no event at all)', { mode: 'on', event: '', baseRef: '' }, 'manual'],
  ];
  it.each(rows)('%s', (_name, input, reason) => {
    expect(decideEarly(input)).toMatchObject({ mode: 'full', reason, files: [] });
    expect(decideSelection(facts(input as Partial<SelectionInput>))).toMatchObject({ mode: 'full', reason });
  });

  it('a pull request into staging in shadow or on mode needs the repository facts (no early answer)', () => {
    expect(decideEarly({ mode: 'shadow', event: 'pull_request', baseRef: 'staging' })).toBeNull();
    expect(decideEarly({ mode: 'on', event: 'pull_request', baseRef: 'staging' })).toBeNull();
  });
});

describe('the variable', () => {
  it.each([
    [undefined, 'off'], ['', 'off'], ['  ', 'off'], ['off', 'off'], ['shadow', 'shadow'], [' on ', 'on'],
    ['ON', 'invalid'], ['Shadow', 'invalid'], ['1', 'invalid'], ['enabled', 'invalid'],
  ])('%j is %s', (raw, mode) => {
    expect(normalizeMode(raw)).toBe(mode);
  });
});

describe('shadow report: what would have run beside what failed', () => {
  it('counts a failing file outside the would-be selection as a miss', () => {
    const decision = decideSelection(facts());
    const r = shadowReport({ decision, failing: ['src/components/__tests__/Button.test.tsx', 'src/pages/__tests__/Home.test.tsx'] });
    expect(r.misses).toEqual(['src/pages/__tests__/Home.test.tsx']);
    expect(r.line).toBe('TEST-SELECT-SHADOW would=selected-2-of-3 reason=changed-files failing=2 misses=1');
  });

  it('has no misses when the would-be answer is a full run', () => {
    const r = shadowReport({ decision: decideSelection(facts({ shallow: true })), failing: ['src/a.test.ts'] });
    expect(r).toEqual({ line: 'TEST-SELECT-SHADOW would=full reason=shallow-clone failing=1 misses=0', misses: [] });
  });

  it('reads the failing files out of a verdict detail, every kind of failure once', () => {
    const detail = {
      failedTests: [{ file: 'src/b.test.ts' }, { file: 'src/b.test.ts' }],
      loadErrors: [{ file: 'src/a.test.ts' }],
      hookTimeouts: [{ file: 'src/c.test.ts' }],
      missing: ['src/d.test.ts'],
      extra: ['src/not-failing.test.ts'],
    };
    expect(failingFiles(detail)).toEqual(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts']);
    expect(failingFiles(undefined)).toEqual([]);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['frontend/src/**/*guard*.test.ts', 'frontend/src/a/b/x-guard.test.ts', true],
    ['frontend/src/**/*guard*.test.ts', 'frontend/src/x-guard.test.ts', true],
    ['frontend/src/**/*guard*.test.ts', 'frontend/src/x.test.ts', false],
    ['**/package.json', 'package.json', true],
    ['**/package.json', 'a/b/package.json', true],
    ['**/package.json', 'a/mypackage.json', false],
    ['frontend/*', 'frontend/index.html', true],
    ['frontend/*', 'frontend/src/a.ts', false],
    ['*', 'README.md', true],
    ['*', 'a/README.md', false],
    ['frontend/.env*', 'frontend/.env.example', true],
    ['a/*.{ts,tsx}', 'a/x.tsx', true],
    ['a/*.{ts,tsx}', 'a/x.js', false],
    ['a/?.ts', 'a/b.ts', true],
    ['a/?.ts', 'a/bc.ts', false],
    ['a.b', 'aXb', false],
  ])('%s vs %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});
