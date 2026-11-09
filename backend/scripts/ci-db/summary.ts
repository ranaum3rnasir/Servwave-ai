/*
 * The text a run prints: the preflight block and the closing block for the job summary (GitHub renders it as markdown).
 * Pure: strings in, strings out.
 */
import { budgetUse, laneStats, slowestFiles, type DbEvent, type Policy, type Problem, type Reconciliation, type Stall, type Verdict } from './results';

const cell = (s: unknown): string => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export interface PhaseRecord { name: string; ok: boolean; skippedReason?: string; ms: number }

export interface SummaryInput {
  line: string;
  verdict: Verdict;
  reconciliation: Reconciliation;
  events: readonly DbEvent[];
  policy: Policy;
  preflight: Record<string, string>;
  phases: readonly PhaseRecord[];
  stall?: Stall | null;
  infraDetail?: string;
  serverFatal: readonly string[];
  peakConnections?: number;
  wallMs: number;
  selected?: readonly string[];
  full: boolean;
  /** Set when the path-skip rule skipped the lanes and what follows them (#3238). */
  skip?: { reason: string; files: number };
}

/**
 * The server log's lines that tell something went wrong with the server itself. The ones the run causes on purpose are left out: the
 * lane setup ending leftover connections and the suites dropping scratch databases ("due to administrator command"), and a client
 * that closed its socket.
 */
export function fatalServerLines(log: string, limit = 20): string[] {
  return log
    .split('\n')
    .filter((l) => /\b(FATAL|PANIC)\b|terminated by signal|server process .* was terminated/.test(l))
    .filter((l) => !/due to administrator command|Connection reset by peer|connection to client lost/.test(l))
    .slice(-limit);
}

export function renderPreflight(preflight: Record<string, string>): string {
  return ['Database check preflight', ...Object.entries(preflight).map(([k, v]) => `  ${k}: ${v}`)].join('\n');
}

const problemText = (p: Problem): string => {
  switch (p.kind) {
    case 'missing': return `Expected file never ran: ${p.file}`;
    case 'extra': return `File ran that was not expected: ${p.file}`;
    case 'twice': return `File ran ${p.times} times: ${p.file}`;
    case 'unfinished': return `File started and never finished${p.lane ? ` (lane ${p.lane})` : ''}: ${p.file}`;
    case 'zero-passed': return `File has no passed test: ${p.file}`;
    case 'undeclared-skip': return `Skipped tests outside the allow-list (${p.skipped}): ${p.file}`;
    case 'below-floor': return `Only ${p.passed} tests passed; the floor is ${p.floor}`;
    case 'lane-missing': return `Lane ${p.lane} finished no file`;
    case 'retries-over-cap': return `${p.retried} tests needed a retry; more than ${p.cap} fails the run`;
  }
};

export function renderSummary(i: SummaryInput): string {
  const r = i.reconciliation;
  const out: string[] = ['## Database check', '', '```', i.line, '```', ''];
  if (i.infraDetail) out.push(`Infrastructure: ${i.infraDetail}`, '');
  if (i.stall) {
    out.push('### Stalled', '', `No test file finished for ${secs(i.stall.quietMs)}. In flight:`, '');
    for (const f of i.stall.inFlight) out.push(`- lane ${f.lane}: \`${f.file}\` (${secs(f.sinceMs)})`);
    if (i.stall.inFlight.length === 0) out.push('- nothing was in flight in a lane');
    out.push('');
  }
  if (i.skip) {
    out.push(
      'suites skipped: no relevant path changed',
      '',
      `The lanes, the numbering suite and the permission drift check were skipped by rule (${i.skip.files} real-database files, rule result \`${i.skip.reason}\`). The migrations, the boot check, the RLS suites, the seed and the other core checks ran. A green check on this pull request means "passed, or clearly not relevant".`,
      '',
    );
  }
  if (i.selected) out.push(`Selected files only (${i.selected.length}): the floor and the full-run totals do not apply.`, '');

  out.push('### Preflight', '', ...Object.entries(i.preflight).map(([k, v]) => `- ${k}: ${v}`), '');

  out.push('### Core checks', '', '| Phase | Result | Time |', '|---|---|---|');
  for (const p of i.phases) out.push(`| ${cell(p.name)} | ${p.skippedReason ? `skipped: ${cell(p.skippedReason)}` : p.ok ? 'passed' : 'FAILED'} | ${p.skippedReason ? '' : secs(p.ms)} |`);
  out.push('');

  const lanes = laneStats(i.events);
  if (lanes.length) {
    out.push('### Lanes', '', '| Lane | Files | Tests | Busy | Wall |', '|---|---|---|---|---|');
    for (const l of lanes) out.push(`| ${l.lane} | ${l.files} | ${l.tests} | ${secs(l.busyMs)} | ${secs(l.wallMs)} |`);
    out.push('');
  }

  out.push(`### Retried tests (${r.retried.length}, more than ${i.policy.maxRetried} fails the run)`, '');
  if (r.retried.length) {
    out.push('| File | Test | Lane | Attempts | First error |', '|---|---|---|---|---|');
    for (const t of r.retried) out.push(`| ${cell(t.file)} | ${cell(t.name)} | ${t.lane ?? ''} | ${t.attempts} | ${cell(t.error)} |`);
  } else out.push('None.');
  out.push('');

  const problems: string[] = [];
  for (const t of r.failedTests.slice(0, 50)) problems.push(`Failed${t.lane ? ` (lane ${t.lane})` : ''}: ${t.file} > ${t.name}: ${t.error}`);
  for (const m of r.failedModules.slice(0, 50)) problems.push(`File failed${m.lane ? ` (lane ${m.lane})` : ''}: ${m.file}: ${m.errors[0] ?? ''}`);
  for (const p of i.phases.filter((x) => !x.ok && !x.skippedReason)) problems.push(`Core phase failed: ${p.name}`);
  for (const p of r.problems) problems.push(problemText(p));
  out.push('### Problems', '', ...(problems.length ? problems.map((p) => `- ${p}`) : ['None.']), '');

  const slow = slowestFiles(i.events, 10);
  if (slow.length) {
    out.push('### Ten slowest files', '', '| File | Lane | Time |', '|---|---|---|');
    for (const f of slow) out.push(`| ${cell(f.file)} | ${f.lane ?? ''} | ${secs(f.ms)} |`);
    out.push('');
  }

  if (i.full) {
    const b = budgetUse(i.events, i.policy);
    out.push(`Total test seconds: ${b.seconds.toFixed(0)} of a budget of ${b.budget} (${Math.round(b.ratio * 100)}%).${b.warn ? ' **Warning: at or above 80% of the budget. Make tests cheaper or add lanes; never raise a time limit.**' : ''}`, '');
  }
  out.push(`Wall time: ${secs(i.wallMs)}.${i.peakConnections !== undefined ? ` Peak connections to the private server: ${i.peakConnections}.` : ''}`, '');
  if (i.serverFatal.length) out.push('### Fatal lines from the server log', '', '```', ...i.serverFatal.slice(0, 20), '```', '');
  return out.join('\n');
}
