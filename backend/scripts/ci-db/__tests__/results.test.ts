/**
 * Reconciliation, verdict and stall rules of the Database command (spec #3234, "Proof that everything ran", "What a run prints").
 * Planted event files in, verdicts out.
 */
import { describe, it, expect } from 'vitest';
import {
  EXIT_CODES, budgetUse, checkStall, classify, infraFromEvents, laneStats, parseEvents, reconcile, slowestFiles, verdictLine,
  type DbEvent, type Policy,
} from '../results';

const POLICY: Policy = {
  floor: 4,
  maxRetried: 10,
  allowedSkips: [{ file: 'sandbox-db.test.ts', reason: 'payment sandbox' }],
  totalTestSecondsBudget: 100,
};
const FILES = ['a-db.test.ts', 'b-db.test.ts', 'c-db.test.ts'];

/** A file that ran in a lane: start note, `n` passed tests, module result, end note. */
function ran(file: string, lane: number, t0: number, opts: { passed?: number; skipped?: number; failed?: number; retries?: number; ms?: number } = {}): DbEvent[] {
  const { passed = 2, skipped = 0, failed = 0, retries = 0, ms = 1000 } = opts;
  const ev: DbEvent[] = [{ ev: 'lane-start', t: t0, lane, file }];
  for (let i = 0; i < passed; i++) ev.push({ ev: 'test', t: t0 + 10, phase: 'lanes', file, name: `passes ${i}`, state: 'passed', retries: i === 0 ? retries : 0, ms: 5 });
  for (let i = 0; i < skipped; i++) ev.push({ ev: 'test', t: t0 + 10, phase: 'lanes', file, name: `skips ${i}`, state: 'skipped', retries: 0, ms: 0 });
  for (let i = 0; i < failed; i++) ev.push({ ev: 'test', t: t0 + 10, phase: 'lanes', file, name: `fails ${i}`, state: 'failed', retries: 2, ms: 5, error: 'AssertionError: expected 1 to be 2\n  at x' });
  ev.push({ ev: 'module', t: t0 + ms, phase: 'lanes', file, state: failed ? 'failed' : 'passed', ms });
  ev.push({ ev: 'lane-end', t: t0 + ms, lane, file });
  return ev;
}

const GOOD: DbEvent[] = [...ran('a-db.test.ts', 1, 0), ...ran('b-db.test.ts', 2, 0), ...ran('c-db.test.ts', 1, 1000)];
const run = (events: DbEvent[], expected = FILES, lanes = 2, policy = POLICY) => reconcile(events, expected, policy, lanes, { full: true });
const kinds = (r: ReturnType<typeof run>) => r.problems.map((p) => `${p.kind}:${'file' in p ? p.file : ''}`);

describe('reconciling a run against the expected files', () => {
  it('is clean when every expected file ran once, each with a passed test, above the floor, on every lane', () => {
    const r = run(GOOD);
    expect(r.problems).toEqual([]);
    expect(r.counts).toMatchObject({ filesExpected: 3, filesRan: 3, passed: 6, failed: 0, retried: 0 });
  });

  it('reports a file that never ran as missing', () => {
    expect(kinds(run(GOOD.filter((e) => !('file' in e) || e.file !== 'c-db.test.ts')))).toEqual(['missing:c-db.test.ts']);
  });

  it('reports a file that ran twice', () => {
    const twice = [...GOOD, ...ran('a-db.test.ts', 2, 3000)];
    expect(kinds(run(twice))).toEqual(['twice:a-db.test.ts']);
  });

  it('reports a file that ran and was not expected', () => {
    expect(kinds(run([...GOOD, ...ran('stray-db.test.ts', 2, 4000)]))).toEqual(['extra:stray-db.test.ts']);
  });

  it('reports a file with no passed test', () => {
    const none = [...ran('a-db.test.ts', 1, 0, { passed: 0, skipped: 1 }), ...ran('b-db.test.ts', 2, 0), ...ran('c-db.test.ts', 1, 1000)];
    expect(kinds(run(none))).toEqual(expect.arrayContaining(['zero-passed:a-db.test.ts', 'undeclared-skip:a-db.test.ts']));
  });

  it('reports one stray skipped test in a file that otherwise passed', () => {
    const skip = [...ran('a-db.test.ts', 1, 0, { passed: 3, skipped: 1 }), ...ran('b-db.test.ts', 2, 0), ...ran('c-db.test.ts', 1, 1000)];
    expect(kinds(run(skip))).toEqual(['undeclared-skip:a-db.test.ts']);
  });

  it('lets an allow-listed file skip, even all of its tests', () => {
    const files = [...FILES, 'sandbox-db.test.ts'];
    const events = [...GOOD, ...ran('sandbox-db.test.ts', 2, 2000, { passed: 0, skipped: 4 })];
    expect(run(events, files).problems).toEqual([]);
  });

  it('lets a listed file skip only as many tests as its entry says, and a skip beyond that is undeclared', () => {
    const files = [...FILES, 'baseline-db.test.ts'];
    const policy = { ...POLICY, allowedSkips: [{ file: 'baseline-db.test.ts', reason: 'baseline', max: 1 }] };
    expect(run([...GOOD, ...ran('baseline-db.test.ts', 2, 2000, { passed: 2, skipped: 1 })], files, 2, policy).problems).toEqual([]);
    expect(kinds(run([...GOOD, ...ran('baseline-db.test.ts', 2, 2000, { passed: 2, skipped: 2 })], files, 2, policy))).toEqual(['undeclared-skip:baseline-db.test.ts']);
    // A limit also means the file must still pass something.
    expect(kinds(run([...GOOD, ...ran('baseline-db.test.ts', 2, 2000, { passed: 0, skipped: 1 })], files, 2, policy))).toEqual(['zero-passed:baseline-db.test.ts']);
  });

  it('closes a file\'s start by the reporter\'s note too: a file with every test skipped runs no hook and writes no end note', () => {
    const files = [...FILES, 'sandbox-db.test.ts'];
    const noEndNote = ran('sandbox-db.test.ts', 2, 2000, { passed: 0, skipped: 2 }).filter((e) => e.ev !== 'lane-end');
    expect(run([...GOOD, ...noEndNote], files).problems).toEqual([]);
    expect(laneStats([...GOOD, ...noEndNote]).find((l) => l.lane === 2)).toMatchObject({ files: 2 });
  });

  it('reports a total below the floor', () => {
    expect(run(GOOD, FILES, 2, { ...POLICY, floor: 7 }).problems).toEqual([{ kind: 'below-floor', passed: 6, floor: 7 }]);
  });

  it('does not apply the floor to a run of selected files', () => {
    expect(reconcile(GOOD, FILES, { ...POLICY, floor: 7 }, 2, { full: false }).problems).toEqual([]);
  });

  it('reports a lane that never finished a file', () => {
    const oneLane = [...ran('a-db.test.ts', 1, 0), ...ran('b-db.test.ts', 1, 1000), ...ran('c-db.test.ts', 1, 2000)];
    expect(run(oneLane).problems).toEqual([{ kind: 'lane-missing', lane: 2 }]);
  });

  it('reports a file that started in a lane and has no result as unfinished, not as never run', () => {
    const cut = GOOD.filter((e) => !(e.ev !== 'lane-start' && 'file' in e && e.file === 'c-db.test.ts'));
    expect(run(cut).problems).toEqual([{ kind: 'unfinished', file: 'c-db.test.ts', lane: 1 }]);
  });

  it('lists every retried test with its lane and attempts, and fails the run past the cap', () => {
    const retried = [...ran('a-db.test.ts', 1, 0, { retries: 2 }), ...ran('b-db.test.ts', 2, 0), ...ran('c-db.test.ts', 1, 1000)];
    const r = run(retried);
    expect(r.retried).toEqual([expect.objectContaining({ file: 'a-db.test.ts', name: 'passes 0', lane: 1, attempts: 3 })]);
    expect(r.problems).toEqual([]);
    const many = Array.from({ length: 11 }, (_, i) => ran(`f${i}-db.test.ts`, 1 + (i % 2), i * 10, { retries: 1 })).flat();
    const over = run(many, Array.from({ length: 11 }, (_, i) => `f${i}-db.test.ts`));
    expect(over.problems).toEqual([{ kind: 'retries-over-cap', retried: 11, cap: 10 }]);
    const ten = Array.from({ length: 10 }, (_, i) => ran(`f${i}-db.test.ts`, 1 + (i % 2), i * 10, { retries: 1 })).flat();
    expect(run(ten, Array.from({ length: 10 }, (_, i) => `f${i}-db.test.ts`), 2, { ...POLICY, floor: 1 }).problems).toEqual([]);
  });

  it('ignores a half-written last line of the events file', () => {
    const text = `${GOOD.map((e) => JSON.stringify(e)).join('\n')}\n{"ev":"test","t":99,"phase":"lan`;
    expect(parseEvents(text)).toHaveLength(GOOD.length);
  });
});

describe('reconciling a run whose lanes were skipped by the path rule (#3238)', () => {
  const core = ['a-db.test.ts'];
  const skippedByRule = ['b-db.test.ts', 'c-db.test.ts'];
  const coreEvents: DbEvent[] = [
    { ev: 'test', t: 1, phase: 'rls-coverage', file: 'a-db.test.ts', name: 'passes', state: 'passed', retries: 0, ms: 5 },
    { ev: 'module', t: 2, phase: 'rls-coverage', file: 'a-db.test.ts', state: 'passed', ms: 100 },
  ];
  const skipRun = (events: DbEvent[]) => reconcile(events, core, POLICY, 0, { full: false, skippedByRule });

  it('accepts a run where the core files ran and the lane files did not: they are skipped by rule, not missing', () => {
    const r = skipRun(coreEvents);
    expect(r.problems).toEqual([]);
    expect(r.skippedByRule).toEqual(skippedByRule);
    expect(r.counts).toMatchObject({ filesExpected: 1, filesRan: 1, passed: 1 });
  });

  it('still fails when a core file did not run: the skip excuses only the files the rule skipped', () => {
    expect(skipRun([]).problems).toEqual([{ kind: 'missing', file: 'a-db.test.ts' }]);
  });

  it('fails when a file the rule skipped ran anyway (the skip and the run disagree)', () => {
    expect(skipRun([...coreEvents, ...ran('b-db.test.ts', 1, 10)]).problems).toEqual([{ kind: 'extra', file: 'b-db.test.ts' }]);
  });

  it('does not apply the floor, and wants no lane', () => {
    expect(skipRun(coreEvents).problems.map((p) => p.kind)).not.toContain('below-floor');
    expect(skipRun(coreEvents).problems.map((p) => p.kind)).not.toContain('lane-missing');
  });

  it('a run that skipped nothing has an empty list, and says so in the verdict line only when something was skipped', () => {
    const none = reconcile(GOOD, FILES, POLICY, 2, { full: true });
    expect(none.skippedByRule).toEqual([]);
    expect(verdictLine(classify({ phaseFailures: [], reconciliation: none }), none, 2)).not.toContain('suites-skipped');
    const r = skipRun(coreEvents);
    expect(verdictLine(classify({ phaseFailures: [], reconciliation: r }), r, 0)).toBe(
      'DB-CI-VERDICT result=passed code=0 reasons=none files=1/1 passed=1 failed=0 retried=0 lanes=0 suites-skipped=2');
  });
});

describe('the verdict', () => {
  const clean = () => run(GOOD);
  const base = { phaseFailures: [] as string[] };

  it('passes only when nothing is wrong, with exit code 0', () => {
    const v = classify({ ...base, reconciliation: clean() });
    expect(v).toMatchObject({ result: 'passed', code: 0 });
  });

  it('calls a failed test failed (10) and names the file', () => {
    const r = run([...ran('a-db.test.ts', 1, 0, { failed: 1 }), ...ran('b-db.test.ts', 2, 0), ...ran('c-db.test.ts', 1, 1000)]);
    const v = classify({ ...base, reconciliation: r });
    expect(v).toMatchObject({ result: 'failed', code: 10 });
    expect(v.reasons).toContain('test-failed:a-db.test.ts');
  });

  it('calls a failed core phase failed, naming the phase', () => {
    const v = classify({ phaseFailures: ['migrations'], reconciliation: clean() });
    expect(v).toMatchObject({ result: 'failed', code: 10, reasons: ['phase-failed:migrations'] });
  });

  it('calls too many retries overloaded (13, the same code as the frontend runner)', () => {
    const many = Array.from({ length: 11 }, (_, i) => ran(`f${i}-db.test.ts`, 1 + (i % 2), i * 10, { retries: 1 })).flat();
    const r = run(many, Array.from({ length: 11 }, (_, i) => `f${i}-db.test.ts`), 2, { ...POLICY, floor: 1 });
    expect(classify({ ...base, reconciliation: r })).toMatchObject({ result: 'overloaded', code: 13, reasons: ['retries:11>10'] });
  });

  it('calls a file that did not run, or skipped, incomplete (11)', () => {
    const missing = run(GOOD.filter((e) => !('file' in e) || e.file !== 'c-db.test.ts'));
    expect(classify({ ...base, reconciliation: missing })).toMatchObject({ result: 'incomplete', code: 11, reasons: ['missing:c-db.test.ts'] });
  });

  it('gives each infrastructure kind its own exit code, distinct from every other', () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const kind of ['server-start', 'clone', 'lane-died', 'wiring', 'server-died'] as const) {
      const v = classify({ ...base, infra: { kind, detail: 'x' }, reconciliation: clean() });
      expect(v).toMatchObject({ result: 'infrastructure', kind, code: EXIT_CODES[kind] });
    }
    expect(EXIT_CODES).toMatchObject({ passed: 0, failed: 10, incomplete: 11, stalled: 12, overloaded: 13, cancelled: 14 });
  });

  it('puts infrastructure before the test failures it caused, and cancelled before everything', () => {
    const failing = run([...ran('a-db.test.ts', 1, 0, { failed: 1 }), ...ran('b-db.test.ts', 2, 0), ...ran('c-db.test.ts', 1, 1000)]);
    expect(classify({ ...base, infra: { kind: 'server-died', detail: 'x' }, reconciliation: failing }).result).toBe('infrastructure');
    expect(classify({ ...base, infra: { kind: 'server-died', detail: 'x' }, cancelled: true, reconciliation: failing }).result).toBe('cancelled');
    expect(classify({ ...base, stalled: true, reconciliation: failing })).toMatchObject({ result: 'stalled', code: 12 });
  });

  it('prints one line with the result, the code and the counts', () => {
    const v = classify({ ...base, reconciliation: clean() });
    expect(verdictLine(v, clean(), 2)).toBe('DB-CI-VERDICT result=passed code=0 reasons=none files=3/3 passed=6 failed=0 retried=0 lanes=2');
    const wiring = classify({ ...base, infra: { kind: 'wiring', detail: 'db lanes: VITEST_POOL_ID is not set' }, reconciliation: clean() });
    expect(verdictLine(wiring, clean(), 2)).toContain('result=infrastructure kind=wiring code=23');
  });
});

describe('infrastructure signs in the events', () => {
  const failedModule = (file: string, message: string): DbEvent => ({ ev: 'module', t: 5, phase: 'lanes', file, state: 'failed', ms: 1, errors: [message] });

  it('a worker with no lane (or a second worker on a lane) is wiring', () => {
    expect(infraFromEvents([failedModule('a-db.test.ts', 'Error: db lanes: VITEST_POOL_ID is not set')])).toMatchObject({ kind: 'wiring' });
    expect(infraFromEvents([failedModule('a-db.test.ts', 'Error: db lanes: lane 3 is already in use by another worker')])).toMatchObject({ kind: 'wiring' });
  });

  it('a file that started in a lane and never ended, or a worker that exited unexpectedly, is a lane that died', () => {
    expect(infraFromEvents([{ ev: 'lane-start', t: 1, lane: 2, file: 'a-db.test.ts' }])).toMatchObject({ kind: 'lane-died' });
    expect(infraFromEvents([failedModule('a-db.test.ts', 'Error: Worker exited unexpectedly')])).toMatchObject({ kind: 'lane-died' });
  });

  it('a plain failed test is not infrastructure', () => {
    expect(infraFromEvents([...ran('a-db.test.ts', 1, 0, { failed: 1 })])).toBeUndefined();
    expect(infraFromEvents(GOOD)).toBeUndefined();
  });
});

describe('the stall rule', () => {
  it('is quiet while files keep finishing', () => {
    expect(checkStall(GOOD, 1500, 0, 1000)).toBeNull();
  });

  it('fires when no file has finished for the window, naming the file in flight in each lane', () => {
    const events: DbEvent[] = [...ran('a-db.test.ts', 1, 0), { ev: 'lane-start', t: 1000, lane: 1, file: 'hang-db.test.ts' }, { ev: 'lane-start', t: 1500, lane: 2, file: 'slow-db.test.ts' }];
    const stall = checkStall(events, 6000, 0, 3000);
    expect(stall).toMatchObject({ quietMs: 5000 });
    expect(stall!.inFlight).toEqual([
      { lane: 1, file: 'hang-db.test.ts', sinceMs: 5000 },
      { lane: 2, file: 'slow-db.test.ts', sinceMs: 4500 },
    ]);
  });

  it('counts a phase that never finished a first file from when it began', () => {
    expect(checkStall([], 5000, 1000, 3000)).toMatchObject({ quietMs: 4000, inFlight: [] });
    expect(checkStall([], 3000, 1000, 3000)).toBeNull();
  });
});

describe('the numbers of the summary', () => {
  const events: DbEvent[] = [...ran('a-db.test.ts', 1, 0, { ms: 4000 }), ...ran('b-db.test.ts', 2, 0, { ms: 9000 }), ...ran('c-db.test.ts', 1, 4000, { ms: 2000 })];

  it('gives per-lane files, tests, busy and wall time', () => {
    expect(laneStats(events)).toEqual([
      { lane: 1, files: 2, tests: 4, busyMs: 6000, wallMs: 6000 },
      { lane: 2, files: 1, tests: 2, busyMs: 9000, wallMs: 9000 },
    ]);
  });

  it('lists the slowest files first, at most ten', () => {
    expect(slowestFiles(events).map((f) => [f.file, f.ms, f.lane])).toEqual([['b-db.test.ts', 9000, 2], ['a-db.test.ts', 4000, 1], ['c-db.test.ts', 2000, 1]]);
    expect(slowestFiles(Array.from({ length: 15 }, (_, i) => ran(`f${i}-db.test.ts`, 1, i * 10)).flat())).toHaveLength(10);
  });

  it('compares total test seconds with the budget and warns from 80%', () => {
    expect(budgetUse(events, { ...POLICY, totalTestSecondsBudget: 100 })).toMatchObject({ seconds: 15, budget: 100, warn: false });
    expect(budgetUse(events, { ...POLICY, totalTestSecondsBudget: 18 })).toMatchObject({ seconds: 15, warn: true });
  });
});
