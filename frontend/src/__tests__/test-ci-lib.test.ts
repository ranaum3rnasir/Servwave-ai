/**
 * `npm run test:ci` (#3253): the verdict, the completeness check, the retry rules, the watchdog and
 * the shard slice, as pure functions over PLANTED event files. Every row is one thing the issue says
 * must turn the run red (or must not). Expected values come from the issue text.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXIT_CODES,
  buildVitestArgs,
  checkWatchdog,
  compileCache,
  evaluate,
  evaluateSafely,
  expectedFromTracked,
  failedSoFar,
  parseEvents,
  emptySetVerdict,
  parseOptions,
  parseShard,
  renderSummary,
  resolveWorkers,
  retriedLines,
  shardSlice,
  verdictLine,
  type Policy,
  type TestCiEvent,
} from '../../scripts/test-ci-lib.mjs';

const POLICY: Policy = { floor: 4, maxRetried: 10, skipAllowList: { 'src/skipped-whole.test.ts': 2 } };
const ARGS = ['run', '--retry=2', '--allowOnly=false'];

/** A file that started, collected `n` tests, ran them all green and finished. */
function greenFile(file: string, n = 2, t0 = 1000): TestCiEvent[] {
  const events: TestCiEvent[] = [
    { ev: 'file-start', file, t: t0 },
    { ev: 'file-collected', file, tests: n, t: t0 + 1 },
  ];
  for (let i = 0; i < n; i++) events.push({ ev: 'test', file, name: `t${i}`, status: 'passed', duration: 5, retries: 0, errors: [], t: t0 + 2 + i });
  events.push({ ev: 'file-end', file, state: 'passed', errors: [], t: t0 + 10 });
  return events;
}

const RUN_END: TestCiEvent = { ev: 'run-end', reason: 'passed', t: 9000 };

function run(over: Partial<Parameters<typeof evaluate>[0]> & { files?: string[]; events?: TestCiEvent[] } = {}) {
  const files = over.files ?? ['src/a.test.ts', 'src/b.test.ts'];
  const events = over.events ?? [...files.flatMap((f) => greenFile(f)), RUN_END];
  return evaluate({ events, expected: files, toolExitCode: 0, args: ARGS, policy: POLICY, mode: 'full', ...over });
}

describe('test:ci verdict', () => {
  it('passes a complete green run: every file once, tests passed, floor met, exit 0', () => {
    const v = run();
    expect(v.result).toBe('passed');
    expect(v.code).toBe(0);
    expect(v.counts).toMatchObject({ filesExpected: 2, filesRan: 2, passed: 4, failed: 0, retried: 0 });
  });

  it('gives each red word its own exit code', () => {
    const codes = [EXIT_CODES.failed, EXIT_CODES.incomplete, EXIT_CODES.stalled, EXIT_CODES.overloaded];
    expect(new Set([0, ...codes]).size).toBe(5);
    expect(EXIT_CODES.passed).toBe(0);
    expect(codes.every((c) => c > 0)).toBe(true);
  });

  it('file missing: an expected file that never reported is incomplete', () => {
    const v = run({ files: ['src/a.test.ts', 'src/b.test.ts', 'src/ghost.test.ts'], events: [...greenFile('src/a.test.ts'), ...greenFile('src/b.test.ts'), RUN_END] });
    expect(v.result).toBe('incomplete');
    expect(v.code).toBe(EXIT_CODES.incomplete);
    expect(v.reasons).toContain('file-missing');
    expect(v.detail.missing).toEqual(['src/ghost.test.ts']);
  });

  it('file extra: a file that ran but was not expected is incomplete', () => {
    const v = run({ files: ['src/a.test.ts'], events: [...greenFile('src/a.test.ts'), ...greenFile('src/b.test.ts'), RUN_END] });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('file-extra');
    expect(v.detail.extra).toEqual(['src/b.test.ts']);
  });

  it('a file seen twice is incomplete', () => {
    const v = run({ events: [...greenFile('src/a.test.ts'), ...greenFile('src/a.test.ts'), ...greenFile('src/b.test.ts'), RUN_END] });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('file-seen-twice');
    expect(v.detail.duplicated).toEqual(['src/a.test.ts']);
  });

  it('zero tests: a file that finished without one passed test is incomplete', () => {
    const empty: TestCiEvent[] = [
      { ev: 'file-start', file: 'src/b.test.ts', t: 1000 },
      { ev: 'file-collected', file: 'src/b.test.ts', tests: 0, t: 1001 },
      { ev: 'file-end', file: 'src/b.test.ts', state: 'passed', errors: [], t: 1002 },
    ];
    const v = run({ events: [...greenFile('src/a.test.ts', 4), ...empty, RUN_END] });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('zero-tests');
    expect(v.detail.zeroTests).toEqual(['src/b.test.ts']);
  });

  it('a file that started and never finished is incomplete', () => {
    const v = run({ events: [...greenFile('src/a.test.ts'), { ev: 'file-start', file: 'src/b.test.ts', t: 2000 }, RUN_END] });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('file-unfinished');
    expect(v.detail.unfinished).toEqual(['src/b.test.ts']);
  });

  it('undeclared skip: a skipped or todo test outside the allow-list is incomplete', () => {
    const f = 'src/b.test.ts';
    const skipping: TestCiEvent[] = [
      ...greenFile(f, 2),
    ];
    skipping.splice(skipping.length - 1, 0,
      { ev: 'test', file: f, name: 'sk', status: 'skipped', duration: 0, retries: 0, errors: [], t: 1100 },
      { ev: 'test', file: f, name: 'td', status: 'todo', duration: 0, retries: 0, errors: [], t: 1101 },
    );
    const v = run({ events: [...greenFile('src/a.test.ts'), ...skipping, RUN_END] });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('undeclared-skip');
    expect(v.detail.undeclaredSkips).toEqual([{ file: f, skipped: 2, allowed: 0 }]);
  });

  it('declared skips are accepted: the allow-listed file may be wholly skipped, exactly as declared', () => {
    const f = 'src/skipped-whole.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts', 4),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'file-collected', file: f, tests: 2, t: 1001 },
      { ev: 'test', file: f, name: 'x', status: 'skipped', duration: 0, retries: 0, errors: [], t: 1002 },
      { ev: 'test', file: f, name: 'y', status: 'skipped', duration: 0, retries: 0, errors: [], t: 1003 },
      { ev: 'file-end', file: f, state: 'skipped', errors: [], t: 1004 },
      RUN_END,
    ];
    expect(run({ files: ['src/a.test.ts', f], events }).result).toBe('passed');
    // one more skip than declared in that file is not accepted
    events.splice(events.length - 2, 0, { ev: 'test', file: f, name: 'z', status: 'skipped', duration: 0, retries: 0, errors: [], t: 1004 });
    const v = run({ files: ['src/a.test.ts', f], events });
    expect(v.reasons).toContain('undeclared-skip');
  });

  it('floor not met: fewer passed tests than the floor is incomplete on a full run only', () => {
    const files = ['src/a.test.ts', 'src/b.test.ts'];
    const events = [...files.flatMap((x) => greenFile(x, 1)), RUN_END]; // 2 passed, floor 4
    const full = run({ files, events });
    expect(full.result).toBe('incomplete');
    expect(full.reasons).toContain('floor-not-met');
    expect(run({ files, events, mode: 'shard' }).result).toBe('passed');
    expect(run({ files, events, mode: 'selected' }).result).toBe('passed');
  });

  it('.only present: the tool marks the test failed with its "Unexpected .only" error (the shape it really emits); that is incomplete, not a test failure', () => {
    const f = 'src/b.test.ts';
    const only: TestCiEvent[] = [
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'file-collected', file: f, tests: 2, t: 1001 },
      { ev: 'test', file: f, name: 'planted only', status: 'skipped', duration: 0, retries: 0, errors: [], t: 1002 },
      { ev: 'test', file: f, name: 'the only one', status: 'failed', duration: 0, retries: 0, errors: ['[Vitest] Unexpected .only modifier. Remove it or pass --allowOnly argument to bypass this error'], t: 1003 },
      { ev: 'file-end', file: f, state: 'failed', errors: [], suiteErrors: [], t: 1004 },
    ];
    const v = run({ events: [...greenFile('src/a.test.ts'), ...only, RUN_END], toolExitCode: 1 });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('only-present');
    expect(v.counts.failed).toBe(0);
  });

  it('a suite whose beforeAll threw is "failed" with its error, even though its tests were only skipped', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'file-collected', file: f, tests: 1, t: 1001 },
      { ev: 'test', file: f, name: 'suite > never runs', status: 'skipped', duration: 0, retries: 0, errors: [], t: 1002 },
      { ev: 'file-end', file: f, state: 'failed', errors: [], suiteErrors: ['planted beforeAll failure'], t: 1003 },
      RUN_END,
    ];
    const v = run({ events, toolExitCode: 1 });
    expect(v.result).toBe('failed');
    expect(v.reasons).toContain('suite-failed');
    expect(v.detail.suiteErrors).toEqual([{ file: f, message: 'planted beforeAll failure' }]);
  });

  it('a test the tool collected but never reported is incomplete', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'file-collected', file: f, tests: 3, t: 1001 },
      { ev: 'test', file: f, name: 'one', status: 'passed', duration: 1, retries: 0, errors: [], t: 1002 },
      { ev: 'file-end', file: f, state: 'passed', errors: [], suiteErrors: [], t: 1003 },
      RUN_END,
    ];
    const v = run({ events });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('test-unreported');
  });

  it('a test left pending when its file ended never ran: incomplete', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'test', file: f, name: 'one', status: 'passed', duration: 1, retries: 0, errors: [], t: 1002 },
      { ev: 'test', file: f, name: 'two', status: 'pending', duration: 0, retries: 0, errors: [], t: 1003 },
      { ev: 'file-end', file: f, state: 'passed', errors: [], suiteErrors: [], t: 1004 },
      RUN_END,
    ];
    expect(run({ events }).reasons).toContain('test-never-ran');
  });

  it('a missing, non-numeric or zero floor is red with its own reason, never a skipped check', () => {
    for (const floor of [undefined, Number.NaN, 0, -1, 1.5, '16900' as unknown as number]) {
      const v = run({ policy: { ...POLICY, floor: floor as number } });
      expect(v.result, String(floor)).toBe('incomplete');
      expect(v.reasons, String(floor)).toContain('invalid-floor');
    }
  });

  it('--allowOnly=false must be passed explicitly', () => {
    const v = run({ args: ['run', '--retry=2'] });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('allow-only-not-false');
  });

  it('non-zero tool exit with a clean report is red: the exit code is the first input', () => {
    const v = run({ toolExitCode: 1 });
    expect(v.result).not.toBe('passed');
    expect(v.code).not.toBe(0);
    expect(v.reasons).toEqual(['tool-exit-nonzero-clean-report']);
  });

  it('a run that never wrote its end line is incomplete', () => {
    const files = ['src/a.test.ts', 'src/b.test.ts'];
    const v = run({ events: files.flatMap((f) => greenFile(f)) });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('run-never-ended');
  });

  it('an unreadable event line is incomplete, not ignored', () => {
    const parsed = parseEvents('{"ev":"run-end","t":1}\n{"ev":"test","fi');
    expect(parsed.badLines).toBe(1);
    const v = run({ badLines: parsed.badLines });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('unreadable-event-line');
  });

  it('an exception inside the check is red, never unknown or green', () => {
    const v = evaluateSafely({ events: null as unknown as TestCiEvent[], expected: ['src/a.test.ts'], toolExitCode: 0, args: ARGS, policy: POLICY });
    expect(v.result).toBe('incomplete');
    expect(v.code).toBe(EXIT_CODES.incomplete);
    expect(v.reasons).toEqual(['check-exception']);
  });
});

describe('test:ci failures', () => {
  it('a failed test is "failed" and wins over completeness gaps (a bail leaves files unrun)', () => {
    const failing: TestCiEvent[] = [
      { ev: 'file-start', file: 'src/b.test.ts', t: 1000 },
      { ev: 'test', file: 'src/b.test.ts', name: 'boom', status: 'failed', duration: 5, retries: 2, errors: ['first\nline', 'second', 'third'], t: 1001 },
      { ev: 'file-end', file: 'src/b.test.ts', state: 'failed', errors: [], t: 1002 },
    ];
    const v = run({ files: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], events: [...greenFile('src/a.test.ts'), ...failing, RUN_END], toolExitCode: 1 });
    expect(v.result).toBe('failed');
    expect(v.code).toBe(EXIT_CODES.failed);
    expect(v.reasons).toContain('tests-failed');
    expect(v.detail.failedTests).toEqual([{ file: 'src/b.test.ts', name: 'boom', firstError: 'third' }]);
  });

  it('a file that fails to load turns the run red', () => {
    const broken: TestCiEvent[] = [
      { ev: 'file-start', file: 'src/b.test.ts', t: 1000 },
      { ev: 'file-end', file: 'src/b.test.ts', state: 'failed', errors: ['Error: cannot import ./nope'], t: 1001 },
    ];
    const v = run({ events: [...greenFile('src/a.test.ts'), ...broken, RUN_END], toolExitCode: 1 });
    expect(v.result).toBe('failed');
    expect(v.reasons).toContain('file-failed-to-load');
  });

  it('an unhandled error is "failed" even when every test passed', () => {
    const v = run({ events: [...greenFile('src/a.test.ts'), ...greenFile('src/b.test.ts'), { ev: 'unhandled', message: 'late throw', t: 8000 }, RUN_END], toolExitCode: 1 });
    expect(v.result).toBe('failed');
    expect(v.reasons).toContain('unhandled-error');
  });

  it('a dead worker is "failed"', () => {
    const v = run({ events: [...greenFile('src/a.test.ts'), ...greenFile('src/b.test.ts'), { ev: 'unhandled', message: 'Worker exited unexpectedly', t: 8000 }, RUN_END], toolExitCode: 1 });
    expect(v.result).toBe('failed');
    expect(v.reasons).toContain('dead-worker');
  });

  it('a hook timeout is never covered by a retry: the retry passed, the run is still red', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'test', file: f, name: 'slow hook', status: 'passed', duration: 40, retries: 1, errors: ['Hook timed out in 30000ms.'], t: 1001 },
      { ev: 'test', file: f, name: 'other', status: 'passed', duration: 4, retries: 0, errors: [], t: 1002 },
      { ev: 'file-end', file: f, state: 'passed', errors: [], t: 1003 },
      RUN_END,
    ];
    const v = run({ events });
    expect(v.result).toBe('failed');
    expect(v.reasons).toContain('hook-timeout');
    expect(v.detail.hookTimeouts).toEqual([{ file: f, name: 'slow hook' }]);
  });
});

describe('test:ci retries', () => {
  function withRetried(n: number): TestCiEvent[] {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [{ ev: 'file-start', file: f, t: 1000 }];
    for (let i = 0; i < n; i++) events.push({ ev: 'test', file: f, name: `flaky ${i}`, status: 'passed', duration: 12, retries: 1, errors: ['Error: timing'], t: 1001 + i });
    events.push({ ev: 'test', file: f, name: 'steady', status: 'passed', duration: 1, retries: 0, errors: [], t: 1500 });
    events.push({ ev: 'file-end', file: f, state: 'passed', errors: [], t: 1600 });
    return [...greenFile('src/a.test.ts'), ...events, RUN_END];
  }

  it('more than 10 retried tests in one run is "overloaded"', () => {
    const v = run({ events: withRetried(11) });
    expect(v.result).toBe('overloaded');
    expect(v.code).toBe(EXIT_CODES.overloaded);
    expect(v.counts.retried).toBe(11);
  });

  it('exactly 10 retried tests is not overloaded', () => {
    const v = run({ events: withRetried(10) });
    expect(v.result).toBe('passed');
    expect(v.counts.retried).toBe(10);
  });

  it('the job summary lists every retried test with file, test, attempts and first error line', () => {
    const v = run({ events: withRetried(11) });
    const md = renderSummary({ verdict: v, verdictLine: verdictLine(v), preflight: { workers: '4 (default 4)' } });
    expect(md).toContain('Retried tests (11)');
    for (let i = 0; i < 11; i++) expect(md).toContain(`flaky ${i}`);
    expect(md).toContain('src/b.test.ts');
    expect(md).toContain('| 2 |'); // attempts = retries + 1
    expect(md).toContain('Error: timing');
    expect(md).toContain('workers: 4 (default 4)');
  });
});

describe('test:ci watchdog', () => {
  const started: TestCiEvent[] = [
    ...greenFile('src/healthy.test.ts', 2, 1000),
    { ev: 'file-start', file: 'src/hung.test.ts', t: 2000 },
    { ev: 'file-collected', file: 'src/hung.test.ts', tests: 3, t: 2001 },
  ];

  it('is quiet while events keep arriving', () => {
    expect(checkWatchdog({ events: started, now: 2500, startedAt: 0 })).toBeNull();
  });

  it('fires "no-event" after 240 s without any event, naming the last healthy file and the files in flight', () => {
    const bigFile = started.map((e) => (e.ev === 'file-collected' ? { ...e, tests: 100 } : e));
    const s = checkWatchdog({ events: bigFile, now: 2001 + 240_001, startedAt: 0 });
    expect(s).toMatchObject({ kind: 'no-event', lastHealthyFile: 'src/healthy.test.ts', inFlight: ['src/hung.test.ts'] });
  });

  it('does not fire at exactly 240 s', () => {
    const bigFile = started.map((e) => (e.ev === 'file-collected' ? { ...e, tests: 100 } : e));
    expect(checkWatchdog({ events: bigFile, now: 2001 + 240_000, startedAt: 0 })).toBeNull();
  });

  it('fires when one file runs past its share (test limit x its test count x 3 attempts + margin), even while other events arrive', () => {
    const share = 3 * 3 * 30_000 + 60_000; // 3 collected tests, --retry=2
    const events = [...started, { ev: 'test', file: 'src/other.test.ts', name: 'x', status: 'passed', duration: 1, retries: 0, errors: [], t: 2000 + share }];
    const s = checkWatchdog({ events, now: 2000 + share + 1, startedAt: 0 });
    expect(s).toMatchObject({ kind: 'file-overrun', file: 'src/hung.test.ts', allowedMs: share });
    expect(checkWatchdog({ events, now: 2000 + share, startedAt: 0 })).toBeNull();
  });

  it('a one-test file whose test times out twice and passes on its last attempt is not killed as stalled', () => {
    // one collected test, 30 s test limit, --retry=2: three attempts of 30 s plus the 60 s margin = 150 s
    const oneTest: TestCiEvent[] = [{ ev: 'file-start', file: 'src/slow.test.ts', t: 0 }, { ev: 'file-collected', file: 'src/slow.test.ts', tests: 1, t: 1 }];
    const lastAttempt = 3 * 30_000 + 5_000; // the third attempt ends 95 s in
    expect(checkWatchdog({ events: oneTest, now: lastAttempt, startedAt: 0, idleMs: 240_000 })).toBeNull();
    expect(checkWatchdog({ events: oneTest, now: 150_000, startedAt: 0, idleMs: 240_000 })).toBeNull();
    expect(checkWatchdog({ events: oneTest, now: 150_002, startedAt: 0, idleMs: 240_000 })).toMatchObject({ kind: 'file-overrun', allowedMs: 150_000 });
  });

  it('measures from the start of the run when no event has arrived yet', () => {
    expect(checkWatchdog({ events: [], now: 5000, startedAt: 1000, idleMs: 3000 })).toMatchObject({ kind: 'no-event', lastHealthyFile: null, inFlight: [] });
  });

  it('on the runner cancel signal, "failed so far" comes from the event file', () => {
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: 'src/b.test.ts', t: 3000 },
      { ev: 'test', file: 'src/b.test.ts', name: 'boom', status: 'failed', duration: 5, retries: 0, errors: ['Error: nope'], t: 3001 },
    ];
    const f = failedSoFar(events);
    expect(f.lines).toEqual(['FAILED src/b.test.ts > boom: Error: nope']);
    expect(f.passed).toBe(2);
    expect(f.inFlight).toEqual(['src/b.test.ts']);
  });

  it('a stalled run is its own word, whatever else the events say', () => {
    const v = evaluate({ events: started, expected: ['src/healthy.test.ts', 'src/hung.test.ts'], toolExitCode: null, args: ARGS, policy: POLICY, stalled: { kind: 'no-event' } });
    expect(v.result).toBe('stalled');
    expect(v.code).toBe(EXIT_CODES.stalled);
  });
});

describe('test:ci expected set, shards, workers, arguments', () => {
  it('the expected set is the tracked test files the tool would run', () => {
    expect(expectedFromTracked(['src/b.test.ts', 'src/a.test.tsx', 'src/helper.ts', 'e2e/x.test.ts', 'src/deep/c.test.ts', 'src/b.test.ts'])).toEqual(['src/a.test.tsx', 'src/b.test.ts', 'src/deep/c.test.ts']);
  });

  // sha1 of "/src/<x>.test.ts" starts 05bb (b), 5b79 (e), b9b9 (d), c91d (a), ecec (c): the tool sorts by it.
  const five = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts'];

  it('shards are dealt the way the tool deals them: sorted by path hash, larger shards first', () => {
    expect(shardSlice(five, 1, 2)).toEqual(['src/b.test.ts', 'src/e.test.ts', 'src/d.test.ts']);
    expect(shardSlice(five, 2, 2)).toEqual(['src/a.test.ts', 'src/c.test.ts']);
  });

  it('every file lands in exactly one shard', () => {
    const all = [1, 2, 3].flatMap((i) => shardSlice(five, i, 3));
    expect([...all].sort()).toEqual(five);
  });

  it('more shards than files leaves an empty slice', () => {
    expect(shardSlice(five, 6, 6)).toEqual([]);
    expect(shardSlice(five, 5, 6)).toHaveLength(1);
  });

  it('parses and validates the shard option', () => {
    expect(parseShard('2/6')).toEqual({ index: 2, count: 6 });
    expect(() => parseShard('7/6')).toThrow();
    expect(() => parseShard('x')).toThrow();
  });

  it('workers: never above an explicitly set variable, 4 when unset', () => {
    expect(resolveWorkers({}).workers).toBe(4);
    expect(resolveWorkers({ FRONTEND_TEST_WORKERS: '6' }).workers).toBe(6);
    expect(resolveWorkers({ VITEST_MAX_WORKERS: '2' }).workers).toBe(2);
    expect(resolveWorkers({ FRONTEND_TEST_WORKERS: '6', VITEST_MAX_WORKERS: '2' }).workers).toBe(2);
    expect(resolveWorkers({ FRONTEND_TEST_WORKERS: '2', VITEST_MAX_WORKERS: '6' })).toEqual({ workers: 2, why: 'FRONTEND_TEST_WORKERS=2' });
    expect(resolveWorkers({}).why).toContain('default');
    expect(() => resolveWorkers({ VITEST_MAX_WORKERS: 'many' })).toThrow();
  });

  it('compile cache: one shared directory inside node_modules by default; a caller\'s own setting and Node\'s off switch are left alone', () => {
    expect(compileCache({}, '/repo/frontend')).toEqual({
      vars: { NODE_COMPILE_CACHE: '/repo/frontend/node_modules/.cache/test-ci/compile-cache' },
      why: 'node_modules/.cache/test-ci/compile-cache',
    });
    expect(compileCache({ NODE_COMPILE_CACHE: '/elsewhere' }, '/repo/frontend').vars).toEqual({});
    expect(compileCache({ NODE_COMPILE_CACHE: '/elsewhere' }, '/repo/frontend').why).toContain('set by the caller');
    const off = compileCache({ NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '/elsewhere' }, '/repo/frontend');
    expect(off.vars).toEqual({});
    expect(off.why).toMatch(/^off /);
  });

  it('starts the tool with --retry=2 and --allowOnly=false always, --bail=50 only when asked', () => {
    const base = buildVitestArgs({ reporterPath: '/r.mjs' });
    expect(base).toEqual(expect.arrayContaining(['--retry=2', '--allowOnly=false', '--reporter=/r.mjs']));
    expect(base.some((a) => a.startsWith('--bail'))).toBe(false);
    expect(buildVitestArgs({ reporterPath: '/r.mjs', bail: 50 })).toContain('--bail=50');
    expect(buildVitestArgs({ reporterPath: '/r.mjs', shard: { index: 2, count: 6 } })).toContain('--shard=2/6');
  });

  it('prints one machine-readable line per retried test, so the weekly CI report can count the same test across runs (#3258)', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [{ ev: 'file-start', file: f, t: 1000 }];
    for (let i = 0; i < 2; i++) events.push({ ev: 'test', file: f, name: `flaky ${i}`, status: 'passed', duration: 12, retries: 1, errors: ['Error: timing'], t: 1001 + i });
    events.push({ ev: 'file-end', file: f, state: 'passed', errors: [], t: 1600 });
    const v = run({ events: [...greenFile('src/a.test.ts'), ...events, RUN_END] });
    expect(retriedLines(v)).toEqual([
      'TEST-CI-RETRIED attempts=2 file=src/b.test.ts test=flaky 0',
      'TEST-CI-RETRIED attempts=2 file=src/b.test.ts test=flaky 1',
    ]);
    expect(retriedLines(run())).toEqual([]);
  });

  it('a retried test whose name has line breaks still prints on one line', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'test', file: f, name: 'a\n  b', status: 'passed', duration: 1, retries: 2, errors: ['x'], t: 1001 },
      { ev: 'file-end', file: f, state: 'passed', errors: [], t: 1600 },
    ];
    const lines = retriedLines(run({ events: [...greenFile('src/a.test.ts'), ...events, RUN_END] }));
    expect(lines).toEqual(['TEST-CI-RETRIED attempts=3 file=src/b.test.ts test=a b']);
  });

  it('prints one machine-readable verdict line', () => {
    const v = run();
    expect(verdictLine(v)).toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=full files=2/2 passed=4 failed=0 retried=0');
    const red = run({ toolExitCode: 1 });
    expect(verdictLine(red, { shard: { index: 2, count: 6 } })).toBe('TEST-CI-VERDICT result=incomplete code=11 reasons=tool-exit-nonzero-clean-report mode=shard-2-of-6 files=2/2 passed=4 failed=0 retried=0');
  });
});

describe('test:ci retried-test attempts and empty sets', () => {
  it('the summary shows each attempt with its own status and duration', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'test', file: f, name: 'flaky', status: 'passed', duration: 807, retries: 1, errors: ['Error: first'], attempts: [{ attempt: 1, ms: 800, status: 'failed' }, { attempt: 2, ms: 0, status: 'passed' }], t: 1001 },
      { ev: 'file-end', file: f, state: 'passed', errors: [], suiteErrors: [], t: 1002 },
      RUN_END,
    ];
    const v = run({ events });
    const md = renderSummary({ verdict: v, verdictLine: verdictLine(v) });
    expect(md).toContain('attempt 1 failed 800 ms; attempt 2 passed 0 ms');
  });

  it('a retried test with no recorded attempts says so instead of guessing', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'test', file: f, name: 'flaky', status: 'passed', duration: 807, retries: 1, errors: ['Error: first'], t: 1001 },
      { ev: 'file-end', file: f, state: 'passed', errors: [], suiteErrors: [], t: 1002 },
      RUN_END,
    ];
    const md = renderSummary({ verdict: run({ events }), verdictLine: 'x' });
    expect(md).toContain('per-attempt times not recorded');
  });

  it('a hook timeout in a suite or file is a hook timeout, not a plain suite failure', () => {
    const f = 'src/b.test.ts';
    const events: TestCiEvent[] = [
      ...greenFile('src/a.test.ts'),
      { ev: 'file-start', file: f, t: 1000 },
      { ev: 'file-end', file: f, state: 'failed', errors: [], suiteErrors: ['Hook timed out in 300ms.'], t: 1002 },
      RUN_END,
    ];
    const v = run({ events, toolExitCode: 1 });
    expect(v.result).toBe('failed');
    expect(v.reasons).toContain('hook-timeout');
    expect(v.reasons).not.toContain('suite-failed');
  });

  it('an empty expected set or an empty shard slice is incomplete with its own reason, decided in the lib', () => {
    expect(emptySetVerdict([], 'shard')).toMatchObject({ result: 'incomplete', code: EXIT_CODES.incomplete, reasons: ['empty-slice'] });
    expect(emptySetVerdict([], 'full')).toMatchObject({ result: 'incomplete', reasons: ['empty-expected-set'] });
    expect(emptySetVerdict([], 'selected')).toMatchObject({ reasons: ['empty-expected-set'] });
    expect(emptySetVerdict(['src/a.test.ts'], 'shard')).toBeNull();
  });
});

describe('test:ci options', () => {
  it('parses the known options', () => {
    expect(parseOptions(['--shard=2/6', '--floor=10'])).toEqual({ shard: '2/6', floor: '10' });
  });

  it('refuses unknown options, bare words and non-numeric numbers instead of running everything', () => {
    expect(() => parseOptions(['--bogus=1'])).toThrow(/unknown option/);
    expect(() => parseOptions(['--files-fromm=x'])).toThrow(/unknown option/);
    expect(() => parseOptions(['src/a.test.ts'])).toThrow(/unknown or incomplete/);
    expect(() => parseOptions(['--shard'])).toThrow(/unknown or incomplete/);
    expect(() => parseOptions(['--floor=abc'])).toThrow(/whole number/);
    expect(() => parseOptions(['--idle-ms=1e3'])).toThrow(/whole number/);
  });
});

describe('test:ci policy file', () => {
  const policy = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/test-ci-policy.json'), 'utf8'));

  // The baseline is today's seven, in one file. The committed list may only shrink: every entry must be
  // in this baseline with a count at or below it. Adding a file or raising a count fails here.
  const BASELINE: Record<string, number> = { 'src/pages/phone/__tests__/incoming-call-card.test.tsx': 7 };

  it('the skip allow-list only shrinks: each entry is in the baseline, at or under its count', () => {
    for (const [file, count] of Object.entries(policy.skipAllowList as Record<string, number>)) {
      expect(BASELINE[file], `${file} is not in the baseline`).toBeDefined();
      expect(count).toBeLessThanOrEqual(BASELINE[file]);
    }
  });

  it('the floor is 16,900 or higher: lowering it is a visible edit of this test too', () => {
    expect(policy.floor).toBeGreaterThanOrEqual(16900);
  });

  it('at most 10 retried tests before a run is overloaded', () => {
    expect(policy.maxRetried).toBe(10);
  });
});

describe('test:ci with test selection (#3257): the verdict line names the mode and why', () => {
  it('a selected run says "selected N of M" and its reason', () => {
    const v = run({ mode: 'selected' });
    expect(verdictLine(v, { mode: 'selected', selected: { n: 2, of: 1563 }, selection: 'changed-files' }))
      .toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-2-of-1563 selection=changed-files files=2/2 passed=4 failed=0 retried=0');
  });

  it('a full run under selection says "full" and the reason code', () => {
    expect(verdictLine(run(), { selection: 'lockfile' }))
      .toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=full selection=lockfile files=2/2 passed=4 failed=0 retried=0');
  });

  it('with selection off the line is exactly what it was before (no selection token)', () => {
    expect(verdictLine(run(), { selection: null })).toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=full files=2/2 passed=4 failed=0 retried=0');
  });

  it('a selected run is incomplete when fewer tests passed than the always-run list holds', () => {
    const v = run({ mode: 'selected', policy: { ...POLICY, selectedFloor: 5 } });
    expect(v.result).toBe('incomplete');
    expect(v.reasons).toContain('floor-not-met');
  });

  it('a selected run at or above that floor passes, and the full-run floor is not applied to it', () => {
    expect(run({ mode: 'selected', policy: { ...POLICY, floor: 16900, selectedFloor: 4 } }).result).toBe('passed');
  });

  it('the job summary carries the selection note under the verdict line', () => {
    const v = run();
    const md = renderSummary({ verdict: v, verdictLine: verdictLine(v), selectionNote: 'Selection (on): selected 2 of 1563, reason=changed-files.' });
    expect(md).toContain('Selection (on): selected 2 of 1563, reason=changed-files.');
    expect(renderSummary({ verdict: v, verdictLine: verdictLine(v) })).not.toContain('Selection');
  });
});
