/*
 * What a run proved, as pure functions over the events file the test run wrote (scripts/ci-db/reporter.ts and the lane setup)
 * and the list of files that were expected: the reconciliation, the verdict and its exit code, the stall rule, and the numbers
 * the job summary shows. Spec #3234, "Proof that everything ran" and "What a run prints".
 */
import type { InfraKind } from './errors';

// ---- the events -------------------------------------------------------------------------------------------------------------

export type TestState = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';

export type DbEvent =
  | { ev: 'test'; t: number; phase: string; file: string; name: string; state: TestState; retries: number; ms: number; error?: string }
  | { ev: 'module'; t: number; phase: string; file: string; state: 'passed' | 'failed' | 'skipped' | 'pending'; ms: number; errors?: string[] }
  | { ev: 'lane-start'; t: number; lane: number; file: string }
  | { ev: 'lane-end'; t: number; lane: number; file: string };

/** One event per line; a line that does not parse (a write cut off by a kill) is dropped, never a crash. */
export function parseEvents(text: string): DbEvent[] {
  const out: DbEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as DbEvent;
      if (e && typeof e === 'object' && typeof (e as { ev?: unknown }).ev === 'string') out.push(e);
    } catch {
      // A half-written last line.
    }
  }
  return out;
}

export interface Policy {
  /** The total test count a full run must reach; raised by hand. */
  floor: number;
  /** More retried tests than this fail the run. */
  maxRetried: number;
  /**
   * Files whose tests may skip, and why; may only shrink. `max` is how many tests may skip in the file (a skip beyond it is an
   * undeclared skip); without it every test of the file may skip, which also frees it from needing a passed test.
   */
  allowedSkips: { file: string; reason: string; max?: number }[];
  /** Total test seconds (the sum of every file's time) a full run should stay under; a warning shows at 80%. */
  totalTestSecondsBudget: number;
}

// ---- reconciliation --------------------------------------------------------------------------------------------------------

export type Problem =
  | { kind: 'missing'; file: string }
  | { kind: 'extra'; file: string }
  | { kind: 'twice'; file: string; times: number }
  | { kind: 'unfinished'; file: string; lane?: number }
  | { kind: 'zero-passed'; file: string }
  | { kind: 'undeclared-skip'; file: string; skipped: number }
  | { kind: 'below-floor'; passed: number; floor: number }
  | { kind: 'lane-missing'; lane: number }
  | { kind: 'retries-over-cap'; retried: number; cap: number };

export interface Reconciliation {
  problems: Problem[];
  counts: { filesExpected: number; filesRan: number; passed: number; failed: number; skipped: number; retried: number };
  failedTests: { file: string; name: string; lane?: number; error: string }[];
  failedModules: { file: string; lane?: number; errors: string[] }[];
  retried: { file: string; name: string; lane?: number; attempts: number; error: string }[];
  /** The lane of every file that ran in lane mode. */
  laneOf: Map<string, number>;
  /** Files the path-skip rule left out on purpose (#3238): not a problem, and told apart from a file that did not run. */
  skippedByRule: string[];
}

const firstLine = (s: string | undefined): string => (s ?? '').trim().split('\n')[0]!.slice(0, 300);

/** The lane each file ran in, from the lane setup's start notes. */
export function lanesOfFiles(events: readonly DbEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) if (e.ev === 'lane-start') out.set(e.file, e.lane);
  return out;
}

/**
 * Checks what ran against what was expected. Fails (a problem) unless: the executed files are exactly the expected ones, each
 * once; every executed file has a passed test; no test is skipped outside the allow-list; the passed count is at least the floor;
 * every lane that was needed ran and finished a file. `lanesNeeded` is 0 for a run with no lanes.
 */
export function reconcile(
  events: readonly DbEvent[], expected: readonly string[], policy: Policy, lanesNeeded: number,
  opts: { full: boolean; skippedByRule?: readonly string[] },
): Reconciliation {
  const problems: Problem[] = [];
  const laneOf = lanesOfFiles(events);
  const expectedSet = new Set(expected);
  const modules = new Map<string, number>();
  const tests = events.filter((e): e is Extract<DbEvent, { ev: 'test' }> => e.ev === 'test');
  for (const e of events) if (e.ev === 'module') modules.set(e.file, (modules.get(e.file) ?? 0) + 1);

  for (const file of expected) {
    const times = modules.get(file) ?? 0;
    if (times === 0) {
      // Started and never finished (the worker died) is told apart from never started.
      problems.push(tests.some((t) => t.file === file) || laneOf.has(file) ? { kind: 'unfinished', file, lane: laneOf.get(file) } : { kind: 'missing', file });
    } else if (times > 1) problems.push({ kind: 'twice', file, times });
  }
  for (const file of modules.keys()) if (!expectedSet.has(file)) problems.push({ kind: 'extra', file });

  const allowed = new Map(policy.allowedSkips.map((s) => [s.file, s.max] as const));
  const perFile = new Map<string, { passed: number; skipped: number }>();
  for (const t of tests) {
    const rec = perFile.get(t.file) ?? { passed: 0, skipped: 0 };
    if (t.state === 'passed') rec.passed += 1;
    else if (t.state !== 'failed') rec.skipped += 1;
    perFile.set(t.file, rec);
  }
  for (const file of expected) {
    if (!modules.has(file)) continue;
    const rec = perFile.get(file) ?? { passed: 0, skipped: 0 };
    const listed = allowed.has(file);
    const max = allowed.get(file);
    if (rec.passed === 0 && !(listed && max === undefined)) problems.push({ kind: 'zero-passed', file });
    if (rec.skipped > (listed ? (max ?? Number.POSITIVE_INFINITY) : 0)) problems.push({ kind: 'undeclared-skip', file, skipped: rec.skipped });
  }

  const passed = tests.filter((t) => t.state === 'passed').length;
  const failedTests = tests.filter((t) => t.state === 'failed').map((t) => ({ file: t.file, name: t.name, lane: laneOf.get(t.file), error: firstLine(t.error) }));
  const failedModules = events
    .filter((e): e is Extract<DbEvent, { ev: 'module' }> => e.ev === 'module' && e.state === 'failed')
    .map((e) => ({ file: e.file, lane: laneOf.get(e.file), errors: (e.errors ?? []).map(firstLine) }));
  const retried = tests.filter((t) => t.retries > 0).map((t) => ({ file: t.file, name: t.name, lane: laneOf.get(t.file), attempts: t.retries + 1, error: firstLine(t.error) || '(first attempt\'s error is not kept by the test tool)' }));

  if (opts.full && passed < policy.floor) problems.push({ kind: 'below-floor', passed, floor: policy.floor });
  if (retried.length > policy.maxRetried) problems.push({ kind: 'retries-over-cap', retried: retried.length, cap: policy.maxRetried });

  const finishedLanes = new Set(events.filter((e) => e.ev === 'lane-end').map((e) => (e as { lane: number }).lane));
  for (let lane = 1; lane <= lanesNeeded; lane++) if (!finishedLanes.has(lane)) problems.push({ kind: 'lane-missing', lane });
  // A file that started on a lane and never ended there. A file whose tests are all skipped runs no hook, so it says nothing at
  // its end but the reporter still reports it: either one closes the start.
  const ended = new Set(events.filter((e) => e.ev === 'lane-end' || e.ev === 'module').map((e) => (e as { file: string }).file));
  for (const [file, lane] of laneOf) if (!ended.has(file) && !problems.some((p) => p.kind === 'unfinished' && p.file === file)) problems.push({ kind: 'unfinished', file, lane });

  return {
    problems,
    counts: {
      filesExpected: expected.length,
      filesRan: expected.filter((f) => modules.has(f)).length,
      passed,
      failed: failedTests.length,
      skipped: tests.filter((t) => t.state !== 'passed' && t.state !== 'failed').length,
      retried: retried.length,
    },
    failedTests,
    failedModules,
    retried,
    laneOf,
    // Not in `expected`, so a skipped file that ran anyway is reported as an extra file above.
    skippedByRule: [...(opts.skippedByRule ?? [])],
  };
}

// ---- infrastructure signs in the events ---------------------------------------------------------------------------------------

const LANE_ERROR = /^(Error: )?db lanes:/;
const WORKER_DIED = /worker (exited unexpectedly|terminated)|\[vitest-pool\]|channel closed|Worker forks emitted error/i;

/** The infrastructure failure a run's events show: a worker with no lane (or a second one on a lane), or a worker that died. */
export function infraFromEvents(events: readonly DbEvent[]): { kind: InfraKind; detail: string } | undefined {
  for (const e of events) {
    if (e.ev !== 'module' || e.state !== 'failed') continue;
    const lane = (e.errors ?? []).find((m) => LANE_ERROR.test(m.trim()));
    if (lane) return { kind: 'wiring', detail: `${e.file}: ${firstLine(lane)}` };
  }
  for (const e of events) {
    if (e.ev !== 'module' || e.state !== 'failed') continue;
    const died = (e.errors ?? []).find((m) => WORKER_DIED.test(m));
    if (died) return { kind: 'lane-died', detail: `${e.file}: ${firstLine(died)}` };
  }
  const ended = new Set(events.filter((e) => e.ev === 'lane-end').map((e) => (e as { file: string }).file));
  const open = events.filter((e): e is Extract<DbEvent, { ev: 'lane-start' }> => e.ev === 'lane-start' && !ended.has(e.file));
  const done = new Set(events.filter((e) => e.ev === 'module').map((e) => (e as { file: string }).file));
  const dead = open.filter((e) => !done.has(e.file));
  if (dead.length > 0) return { kind: 'lane-died', detail: `lane ${dead[0]!.lane} started ${dead[0]!.file} and never finished it` };
  return undefined;
}

// ---- the verdict --------------------------------------------------------------------------------------------------------------

export const EXIT_CODES = {
  passed: 0,
  failed: 10,
  incomplete: 11,
  stalled: 12,
  cancelled: 14,
  /** Same code as the frontend runner's overloaded (#3253): too many retried tests. */
  overloaded: 13,
  'server-start': 20,
  clone: 21,
  'lane-died': 22,
  wiring: 23,
  'server-died': 24,
} as const;

export type ResultWord = 'passed' | 'failed' | 'incomplete' | 'stalled' | 'overloaded' | 'cancelled' | 'infrastructure';

export interface Verdict {
  result: ResultWord;
  /** For `infrastructure`: which kind. */
  kind?: InfraKind;
  code: number;
  reasons: string[];
}

export interface VerdictInput {
  cancelled?: boolean;
  infra?: { kind: InfraKind; detail: string };
  stalled?: boolean;
  /** Core phases (migrations, boot, seed, ...) that failed, by name. */
  phaseFailures: readonly string[];
  reconciliation: Reconciliation;
}

const describeProblem = (p: Problem): string => {
  switch (p.kind) {
    case 'missing': return `missing:${p.file}`;
    case 'extra': return `extra:${p.file}`;
    case 'twice': return `twice:${p.file}`;
    case 'unfinished': return `unfinished:${p.file}`;
    case 'zero-passed': return `zero-passed:${p.file}`;
    case 'undeclared-skip': return `undeclared-skip:${p.file}`;
    case 'below-floor': return `below-floor:${p.passed}<${p.floor}`;
    case 'lane-missing': return `lane-missing:${p.lane}`;
    case 'retries-over-cap': return `retries:${p.retried}>${p.cap}`;
  }
};

/**
 * One classification, in this order: cancelled, an infrastructure kind (what failed was the machinery, so the test failures that
 * follow from it are not the news), stalled, failed (a test, a file that did not load, a core phase),
 * incomplete (something that should have run did not, or ran twice, or skipped), overloaded (more retried tests than the cap, exit 13 like
 * the frontend runner), passed.
 */
export function classify(input: VerdictInput): Verdict {
  const { reconciliation: r } = input;
  const reasons: string[] = [];
  if (input.cancelled) return { result: 'cancelled', code: EXIT_CODES.cancelled, reasons: ['cancelled'] };
  if (input.infra) return { result: 'infrastructure', kind: input.infra.kind, code: EXIT_CODES[input.infra.kind], reasons: [`${input.infra.kind}:${firstLine(input.infra.detail)}`] };
  if (input.stalled) return { result: 'stalled', code: EXIT_CODES.stalled, reasons: ['stalled'] };

  for (const t of r.failedTests.slice(0, 5)) reasons.push(`test-failed:${t.file}`);
  for (const m of r.failedModules.slice(0, 5)) reasons.push(`file-failed:${m.file}`);
  for (const p of input.phaseFailures) reasons.push(`phase-failed:${p}`);
  if (reasons.length > 0) return { result: 'failed', code: EXIT_CODES.failed, reasons };

  const incomplete = r.problems.filter((p) => p.kind !== 'retries-over-cap');
  if (incomplete.length > 0) return { result: 'incomplete', code: EXIT_CODES.incomplete, reasons: incomplete.slice(0, 8).map(describeProblem) };
  const overCap = r.problems.find((p) => p.kind === 'retries-over-cap');
  if (overCap) return { result: 'overloaded', code: EXIT_CODES.overloaded, reasons: [describeProblem(overCap)] };
  return { result: 'passed', code: EXIT_CODES.passed, reasons: [] };
}

/** The one line a run ends with (also the error annotation). */
export function verdictLine(v: Verdict, r: Reconciliation, lanes: number): string {
  const c = r.counts;
  return [
    'DB-CI-VERDICT',
    `result=${v.result}`,
    ...(v.kind ? [`kind=${v.kind}`] : []),
    `code=${v.code}`,
    `reasons=${v.reasons.length ? v.reasons.join(',') : 'none'}`,
    `files=${c.filesRan}/${c.filesExpected}`,
    `passed=${c.passed}`,
    `failed=${c.failed}`,
    `retried=${c.retried}`,
    `lanes=${lanes}`,
    ...(r.skippedByRule.length > 0 ? [`suites-skipped=${r.skippedByRule.length}`] : []),
  ].join(' ');
}

// ---- the stall rule --------------------------------------------------------------------------------------------------------------

export interface Stall {
  quietMs: number;
  /** The file each lane is in, with how long it has been there. */
  inFlight: { lane: number; file: string; sinceMs: number }[];
}

/**
 * Stalled: no test file has finished for `stallMs`. `startedAt` is when the lane phase began (a phase that never finishes a first
 * file counts from then). Null while the run is moving.
 */
export function checkStall(events: readonly DbEvent[], now: number, startedAt: number, stallMs: number): Stall | null {
  const finishes = events.filter((e) => e.ev === 'module' || e.ev === 'lane-end').map((e) => e.t);
  const last = finishes.length ? Math.max(startedAt, ...finishes) : startedAt;
  const quietMs = now - last;
  if (quietMs <= stallMs) return null;
  const ended = new Set(events.filter((e) => e.ev === 'lane-end' || e.ev === 'module').map((e) => (e as { file: string }).file));
  const inFlight = events
    .filter((e): e is Extract<DbEvent, { ev: 'lane-start' }> => e.ev === 'lane-start' && !ended.has(e.file))
    .map((e) => ({ lane: e.lane, file: e.file, sinceMs: now - e.t }))
    .sort((a, b) => a.lane - b.lane);
  return { quietMs, inFlight };
}

// ---- the numbers of the summary ------------------------------------------------------------------------------------------------

export interface LaneStat { lane: number; files: number; tests: number; busyMs: number; wallMs: number }

/** Per lane: files, tests, time busy inside files, and the wall time from its first start to its last end. */
export function laneStats(events: readonly DbEvent[]): LaneStat[] {
  const stats = new Map<number, LaneStat & { first: number; last: number }>();
  const startOf = new Map<string, number>();
  for (const e of events) {
    if (e.ev === 'lane-start') startOf.set(e.file, e.t);
  }
  const laneOf = lanesOfFiles(events);
  for (const [file, end] of fileEnds(events)) {
    const lane = laneOf.get(file);
    if (lane === undefined) continue;
    const s = stats.get(lane) ?? { lane, files: 0, tests: 0, busyMs: 0, wallMs: 0, first: Infinity, last: 0 };
    const start = startOf.get(file) ?? end;
    s.files += 1;
    s.busyMs += end - start;
    s.first = Math.min(s.first, start);
    s.last = Math.max(s.last, end);
    stats.set(lane, s);
  }
  for (const e of events) {
    if (e.ev !== 'test') continue;
    const lane = laneOf.get(e.file);
    if (lane !== undefined && stats.has(lane)) stats.get(lane)!.tests += 1;
  }
  return [...stats.values()].map((s) => ({ lane: s.lane, files: s.files, tests: s.tests, busyMs: s.busyMs, wallMs: s.last - s.first })).sort((a, b) => a.lane - b.lane);
}

/** When each file that ran in a lane ended: its end note, or (a file with every test skipped writes none) the reporter's note. */
function fileEnds(events: readonly DbEvent[]): Map<string, number> {
  const ends = new Map<string, number>();
  for (const e of events) if (e.ev === 'lane-end') ends.set(e.file, e.t);
  for (const e of events) if (e.ev === 'module' && !ends.has(e.file) && lanesOfFiles(events).has(e.file)) ends.set(e.file, e.t);
  return ends;
}

/** The slowest files: a lane file's time from its start to its end; any other file's own module time. */
export function slowestFiles(events: readonly DbEvent[], n = 10): { file: string; ms: number; lane?: number }[] {
  const startOf = new Map<string, number>();
  const laneOf = lanesOfFiles(events);
  for (const e of events) if (e.ev === 'lane-start') startOf.set(e.file, e.t);
  const ms = new Map<string, number>();
  for (const [file, end] of fileEnds(events)) ms.set(file, end - (startOf.get(file) ?? end));
  for (const e of events) if (e.ev === 'module' && !ms.has(e.file)) ms.set(e.file, e.ms);
  return [...ms.entries()].map(([file, v]) => ({ file, ms: v, lane: laneOf.get(file) })).sort((a, b) => b.ms - a.ms).slice(0, n);
}

/** Total test seconds: the sum of every file's time, against the budget. */
export function budgetUse(events: readonly DbEvent[], policy: Policy): { seconds: number; budget: number; ratio: number; warn: boolean } {
  const seconds = slowestFiles(events, Number.MAX_SAFE_INTEGER).reduce((a, f) => a + f.ms, 0) / 1000;
  const ratio = seconds / policy.totalTestSecondsBudget;
  return { seconds, budget: policy.totalTestSecondsBudget, ratio, warn: ratio >= 0.8 };
}
