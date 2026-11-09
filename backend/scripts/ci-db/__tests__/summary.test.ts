/**
 * What a run prints (spec #3234, "What a run prints"): the server-log lines worth showing, and the closing block.
 */
import { describe, it, expect } from 'vitest';
import { fatalServerLines, renderSummary } from '../summary';
import { classify, reconcile, verdictLine, type DbEvent, type Policy } from '../results';

const POLICY: Policy = { floor: 1, maxRetried: 10, allowedSkips: [], totalTestSecondsBudget: 100 };

describe('the server log lines worth showing', () => {
  const log = [
    '2026-11-07 19:42:33.137 UTC [30377] FATAL:  terminating connection due to administrator command',
    '2026-11-07 19:45:14.704 UTC [3967] FATAL:  terminating autovacuum process due to administrator command',
    '2026-11-07 19:54:41.728 UTC [13164] LOG:  could not receive data from client: Connection reset by peer',
    '2026-11-07 19:55:00.000 UTC [1] LOG:  server process (PID 4242) was terminated by signal 9: Killed',
    '2026-11-07 19:55:01.000 UTC [1] PANIC:  could not write to file "pg_wal/xlogtemp.1": No space left on device',
    '2026-11-07 19:55:02.000 UTC [2] ERROR:  audit_logs is append-only: DELETE is refused',
  ].join('\n');

  it('keeps the server dying and failing, and leaves out what the run does to connections on purpose', () => {
    expect(fatalServerLines(log)).toEqual([
      '2026-11-07 19:55:00.000 UTC [1] LOG:  server process (PID 4242) was terminated by signal 9: Killed',
      '2026-11-07 19:55:01.000 UTC [1] PANIC:  could not write to file "pg_wal/xlogtemp.1": No space left on device',
    ]);
  });
});

describe('the closing block', () => {
  const events: DbEvent[] = [
    { ev: 'lane-start', t: 0, lane: 1, file: 'a-db.test.ts' },
    { ev: 'test', t: 5, phase: 'lanes', file: 'a-db.test.ts', name: 'x', state: 'passed', retries: 1, ms: 5, error: 'boom' },
    { ev: 'module', t: 4000, phase: 'lanes', file: 'a-db.test.ts', state: 'passed', ms: 4000 },
    { ev: 'lane-end', t: 4000, lane: 1, file: 'a-db.test.ts' },
  ];
  const r = reconcile(events, ['a-db.test.ts'], POLICY, 1, { full: true });
  const v = classify({ phaseFailures: [], reconciliation: r });
  const text = renderSummary({
    line: verdictLine(v, r, 1), verdict: v, reconciliation: r, events, policy: POLICY, preflight: { lanes: '1' }, phases: [{ name: 'migrations apply', ok: true, ms: 4200 }],
    serverFatal: [], peakConnections: 12, wallMs: 9000, full: true,
  });

  it('shows the verdict line, per-lane time, every retried test, the slowest files and the budget', () => {
    expect(text).toContain('DB-CI-VERDICT result=passed code=0');
    expect(text).toContain('| 1 | 1 | 1 | 4.0 s | 4.0 s |');
    expect(text).toContain('| a-db.test.ts | x | 1 | 2 | boom |');
    expect(text).toContain('### Ten slowest files');
    expect(text).toContain('Total test seconds: 4 of a budget of 100 (4%).');
    expect(text).toContain('Peak connections to the private server: 12.');
  });

  it('names the stalled file per lane', () => {
    const stalled = renderSummary({
      line: 'x', verdict: v, reconciliation: r, events, policy: POLICY, preflight: {}, phases: [], serverFatal: [], wallMs: 1, full: true,
      stall: { quietMs: 300000, inFlight: [{ lane: 2, file: 'hang-db.test.ts', sinceMs: 301000 }] },
    });
    expect(stalled).toContain('No test file finished for 300.0 s. In flight:');
    expect(stalled).toContain('- lane 2: `hang-db.test.ts` (301.0 s)');
  });
});

describe('the closing block of a run that skipped the lanes (#3238)', () => {
  const events: DbEvent[] = [
    { ev: 'test', t: 1, phase: 'rls-coverage', file: 'a-db.test.ts', name: 'x', state: 'passed', retries: 0, ms: 5 },
    { ev: 'module', t: 2, phase: 'rls-coverage', file: 'a-db.test.ts', state: 'passed', ms: 100 },
  ];
  const r = reconcile(events, ['a-db.test.ts'], POLICY, 0, { full: false, skippedByRule: ['b-db.test.ts', 'c-db.test.ts'] });
  const v = classify({ phaseFailures: [], reconciliation: r });
  const text = renderSummary({
    line: verdictLine(v, r, 0), verdict: v, reconciliation: r, events, policy: POLICY, preflight: {},
    phases: [{ name: 'migrations apply', ok: true, ms: 100 }, { name: 'lanes', ok: true, skippedReason: 'no relevant path changed', ms: 0 }],
    serverFatal: [], wallMs: 1000, full: false, skip: { reason: 'all-paths-irrelevant', files: 2 },
  });

  it('says the suites were skipped and why, and shows the lanes as skipped by rule rather than passed or failed', () => {
    expect(text).toContain('suites skipped: no relevant path changed');
    expect(text).toContain('| lanes | skipped: no relevant path changed |');
    expect(text).toContain('| migrations apply | passed |');
  });

  it('does not show the full-run floor or budget, and says nothing about skipping on a run that did not skip', () => {
    expect(text).not.toContain('Total test seconds');
    const none = renderSummary({ line: verdictLine(v, r, 0), verdict: v, reconciliation: r, events, policy: POLICY, preflight: {}, phases: [], serverFatal: [], wallMs: 1, full: false });
    expect(none).not.toContain('suites skipped');
  });
});
