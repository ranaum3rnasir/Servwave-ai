/*
 * `npm run test:db [-- <file-name pattern>...]` runs the whole Database check; with patterns it runs the same setup and only the
 * matching files. `npm run test:db:stop` stops and deletes the private server of a run (idempotent; an always-run workflow step).
 *
 * A pull request whose every changed path is known to be irrelevant (scripts/ci-db/skip.ts) skips the lanes and what follows them; the core
 * checks run on every run, and a push, a laptop run or any doubt runs everything.
 *
 * Exit codes: 0 passed, 10 failed, 11 incomplete, 12 stalled, 13 overloaded (more than 10 retried tests), 14 cancelled, 20-24 infrastructure (see results.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterLanePhaseOrder, corePhaseOrder, expectedFiles } from './decisions';
import { gitIn, trackedFiles } from './files';
import { runCheck } from './run';
import { segmentCount, stopRun, sweepOrphans } from './server';
import type { Policy } from './results';
import { skipDecisionFor } from './skip';

const BACKEND = path.resolve(__dirname, '../..');
const out = (text: string) => { process.stdout.write(text); };

function stopCommand(env: NodeJS.ProcessEnv): number {
  const dir = env.DB_CHECK_RUN_DIR;
  const report = stopRun(dir);
  out(report.stopped ? `Server log (tail):\n${report.logTail}\nStopped the private server (${report.how}).\n` : 'No private server of this run to stop.\n');
  // A run that was killed before it could say where its server was: in CI everything in the runner's own folder is its orphan.
  const sweep = sweepOrphans(env);
  out(`Orphan servers stopped: ${sweep.stopped.length}; leftover directories removed: ${sweep.removedDirs.length}; shared-memory segments: ${segmentCount()}.\n`);
  return 0;
}

/**
 * The path-skip rule (#3238) for this run: pull requests only, from the merge commit against its first parent. DB_CHECK_DIFF_DIR names
 * another repository to read that from (the end-to-end test builds a scratch repository); any trouble reading it runs everything.
 */
function pathSkip() {
  return skipDecisionFor(gitIn(process.env.DB_CHECK_DIFF_DIR || BACKEND), process.env);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'stop') return stopCommand(process.env);
  if (command === 'list') {
    const e = expectedFiles(trackedFiles(BACKEND), rest);
    out(`${JSON.stringify({ ...e, coreOrder: corePhaseOrder(e, { filtered: rest.length > 0, boot: true }), afterOrder: afterLanePhaseOrder(e, { filtered: rest.length > 0 }), skip: pathSkip() })}\n`);
    return 0;
  }
  if (command !== 'run') {
    process.stderr.write('usage: test-db run [--boot] [file-name pattern ...] | test-db stop | test-db list [file-name pattern ...]\n');
    return 2;
  }
  const patterns = rest.filter((a) => !a.startsWith('--'));
  const boot = rest.includes('--boot') || process.env.CI === 'true';
  const policy = JSON.parse(readFileSync(path.join(__dirname, 'policy.json'), 'utf8')) as Policy;
  const seconds = (name: string, fallback?: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v * 1000 : fallback;
  };
  const skip = pathSkip();
  return runCheck({
    backendDir: BACKEND,
    skip,
    env: process.env,
    patterns,
    policy,
    boot,
    stallMs: seconds('DB_CHECK_STALL_SECONDS', 300_000)!,
    deadlineMs: seconds('DB_CHECK_DEADLINE_SECONDS'),
    out,
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(23);
  },
);
