/*
 * The Database check as one run: a private Postgres server, the core checks on one database, that database copied once per lane,
 * every remaining real-database test file across the lanes in a single test run, proof that every expected file ran, and the
 * server stopped and deleted. Spec #3234 ("The Database test command"). The decisions are in decisions.ts and results.ts; this
 * file is the order in which things happen.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AFTER_LANES, PHASE, afterLanePhaseOrder, corePhaseOrder, expectedFiles, laneCount, runPlan, withoutLanes, type ExpectedFiles } from './decisions';
import { InfraError, type InfraKind } from './errors';
import {
  assertOwnServer, clientEnv, segmentCount, serverAlive, serverUrl, startServer, stopRun, sweepOrphans, type PrivateServer,
} from './server';
import { checkStall, classify, infraFromEvents, parseEvents, reconcile, verdictLine, type DbEvent, type Policy, type Stall } from './results';
import { npmBin, trackedFiles } from './files';
import { fatalServerLines, renderPreflight, renderSummary, type PhaseRecord } from './summary';
import { signalGroup, supervise } from './supervise';
import type { SkipDecision } from './skip';

const TEMPLATE_DB = 'servwave_core';
/** The test tool's retries in the lanes (today's number, for the rollout); the core checks get none. */
export const LANE_RETRIES = 2;
/** A hook timeout in the lane run is never a product signal, so it is longer than the 20 s every other run uses. */
export const LANE_HOOK_TIMEOUT_MS = 60_000;

export interface RunConfig {
  backendDir: string;
  env: NodeJS.ProcessEnv;
  patterns: string[];
  policy: Policy;
  /** Run the built server and hit its health endpoints: in CI, and on request elsewhere. */
  boot: boolean;
  stallMs: number;
  /** The path-skip rule's decision (#3238). Absent = run everything. */
  skip?: SkipDecision;
  deadlineMs?: number;
  out: (text: string) => void;
}

// ---- what the test run is given -------------------------------------------------------------------------------------------------

/** Settings of this environment that decide what a test can see or skip; none of them may leak into the run. */
const SCRUBBED = [
  'DATABASE_URL', 'DIRECT_URL', 'TEST_DATABASE_URL', 'MIGRATION_BASE_DB', 'MIGRATION_SHAPE_DB_URL',
  'RUN_INTEGRATION_TESTS', 'RUN_ANON_LOCKOUT_TEST', 'STRIPE_SANDBOX_E2E', 'SPIDER_2990_CAPTURE', 'SPIDER_2989_DUMP', 'SHARED_SEND_CAPTURE',
  'DRY_RUN', 'DB_TENANT_GUARD', 'E2E_TEST_DOORS', 'SEED_ALLOW_DEMO_ORG', 'VITEST_MAX_WORKERS', 'VITEST_POOL_ID',
  'DB_LANE_URL_BASE', 'DB_LANE_COUNT', 'DB_LANE_PSQL', 'DB_LANE_LOCK_GRACE_MS', 'DB_CHECK_EVENTS_FILE', 'DB_CHECK_PHASE',
];

/** The environment every step starts from: this one without those settings and without any libpq setting of the caller's. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SCRUBBED.includes(k) && !k.startsWith('PG')) out[k] = v;
  return out;
}

const NO_ENV_FILE = path.join(__dirname, 'no-env-file.cjs');

/**
 * `env` with the preload that hides the developer's env files from every node process of the run (no-env-file.cjs). The scrub above
 * only clears what this environment already holds; the Prisma client, dotenv and the Prisma command line would put a database address
 * from backend/.env back into the process that imports them. Added to any NODE_OPTIONS the caller has.
 */
export function withoutEnvFiles(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const preload = `--require "${NO_ENV_FILE}"`;
  return { ...env, NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload };
}

export function coreVitestArgs(reporter: string, file: string): string[] {
  return ['run', '--reporter=default', `--reporter=${reporter}`, file];
}

export function laneVitestArgs(reporter: string, workers: number, files: readonly string[]): string[] {
  return [
    'run', '--reporter=default', `--reporter=${reporter}`,
    `--maxWorkers=${workers}`, `--retry=${LANE_RETRIES}`, `--hookTimeout=${LANE_HOOK_TIMEOUT_MS}`,
    ...files,
  ];
}

// ---- small helpers ----------------------------------------------------------------------------------------------------------------

const here = __dirname;
const REPORTER = path.join(here, 'reporter.ts');

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync(cmd, args, { env, cwd, encoding: 'utf8' });
}

/** Who is listening on a TCP port (the process id), or undefined when nobody is. */
export function listenerPid(port: number): number | undefined {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  if (!lsof.error) {
    const m = /^p(\d+)/m.exec(lsof.stdout ?? '');
    return m ? Number(m[1]) : undefined;
  }
  const ss = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8' });
  if (!ss.error) {
    const m = /pid=(\d+)/.exec(ss.stdout ?? '');
    return m ? Number(m[1]) : undefined;
  }
  throw new InfraError('wiring', 'neither lsof nor ss is installed, so the boot check cannot tell which process answers on its port');
}

function swapUsedMb(): string {
  try {
    const mem = readFileSync('/proc/meminfo', 'utf8');
    const num = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(mem)?.[1] ?? 0);
    return `${Math.round((num('SwapTotal') - num('SwapFree')) / 1024)} MB`;
  } catch {
    const r = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
    return (r.stdout ?? '').trim().replace(/\s+/g, ' ') || 'unknown';
  }
}

const fatalLines = (logFile: string): string[] => {
  try {
    return fatalServerLines(readFileSync(logFile, 'utf8'));
  } catch {
    return [];
  }
};

const psqlOut = (server: PrivateServer, env: NodeJS.ProcessEnv, db: string, sql: string) =>
  sh(path.join(server.binDir, 'psql'), ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { ...env, ...clientEnv(server) });

// ---- the run ----------------------------------------------------------------------------------------------------------------------

export async function runCheck(cfg: RunConfig): Promise<number> {
  const { out, backendDir } = cfg;
  const t0 = Date.now();
  const phases: PhaseRecord[] = [];
  const phaseFailures: string[] = [];
  // Set from inside callbacks, so one object rather than variables the compiler would narrow to their first value.
  const st = { cancelled: false, deadlineHit: false, serverDied: false, stall: undefined as Stall | undefined };
  let currentPid: number | undefined;
  const onSignal = () => {
    st.cancelled = true;
    if (currentPid) signalGroup(currentPid, 'SIGTERM');
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, onSignal);

  let server: PrivateServer | undefined;
  let eventsFile = '';
  let infra: { kind: InfraKind; detail: string } | undefined;
  let expected: ExpectedFiles | undefined;
  let lanes = 0;
  let peakConnections = 0;
  let preflight: Record<string, string> = {};
  let segmentsAtStart = 0;
  let laneStartedAt = 0;
  const deadlineAt = cfg.deadlineMs !== undefined ? t0 + cfg.deadlineMs : undefined;
  const skipped = cfg.skip?.skip === true;

  const note = (e: unknown) => out(`${e instanceof Error ? e.message : String(e)}\n`);

  /** Runs one step under watch; the verdict of a stopped step is recorded for the final classification. */
  async function step(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, opts: { stalls?: boolean } = {}): Promise<{ ok: boolean; events: DbEvent[] }> {
    const started = Date.now();
    out(`\n::group::${name}\n`);
    const r = await supervise({
      cmd, args, env, cwd: backendDir, eventsFile,
      stallMs: opts.stalls ? cfg.stallMs : 0,
      deadlineMs: deadlineAt !== undefined ? Math.max(1, deadlineAt - Date.now()) : undefined,
      serverAlive: server ? () => serverAlive(server!) : undefined,
      cancelled: () => st.cancelled,
      onChild: (pid) => {
        currentPid = pid;
        // Where a stop that finds this run killed can find the step that was running (it holds connections to the server).
        if (server) { try { if (pid) writeFileSync(path.join(server.runDir, 'child.pid'), String(pid)); else rmSync(path.join(server.runDir, 'child.pid'), { force: true }); } catch { /* the directory is gone */ } }
      },
    });
    out('::endgroup::\n');
    if (r.ended === 'stall') st.stall = r.stall;
    if (r.ended === 'deadline') st.deadlineHit = true;
    if (r.ended === 'server-died') st.serverDied = true;
    const ok = r.ended === 'exit' && r.code === 0;
    phases.push({ name, ok, ms: Date.now() - started });
    if (!ok) phaseFailures.push(name);
    return { ok, events: r.events };
  }

  const halted = () => st.cancelled || st.deadlineHit || st.serverDied || st.stall !== undefined;

  try {
    expected = expectedFiles(trackedFiles(backendDir), cfg.patterns);
    // Skipped by rule: the lanes and what follows them. The core checks (everything before the lanes) are never skipped.
    if (skipped) expected = withoutLanes(expected);
    const filtered = cfg.patterns.length > 0;
    lanes = expected.lanes.length === 0 ? 0 : Math.min(laneCount(cfg.env.DB_LANES, os.cpus().length), expected.lanes.length);

    const sweep = sweepOrphans(cfg.env);
    server = startServer(cfg.env);
    const baseEnv: NodeJS.ProcessEnv = {
      ...withoutEnvFiles(scrubbedEnv(cfg.env)),
      PATH: `${server.binDir}${path.delimiter}${cfg.env.PATH ?? ''}`,
      CI: 'true',
      // No update check or telemetry from the Prisma command line: the suites that run it read its standard error, and a notice about a
      // newer version (whether it shows depends on the machine's network) would fail them for no reason of ours.
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      CHECKPOINT_DISABLE: '1',
      ...clientEnv(server),
    };
    assertOwnServer(server, baseEnv);
    eventsFile = path.join(server.runDir, 'events.jsonl');
    writeFileSync(eventsFile, '');
    exportToLaterSteps(cfg.env, server);

    const version = psqlOut(server, baseEnv, 'postgres', 'SHOW server_version').stdout.trim();
    const collation = psqlOut(server, baseEnv, 'postgres', "SELECT datcollate || ' / ' || pg_encoding_to_char(encoding) FROM pg_database WHERE datname = 'template1'").stdout.trim();
    segmentsAtStart = segmentCount();
    preflight = {
      where: `${cfg.env.RUNNER_ENVIRONMENT ?? 'local'}, ${os.platform()} ${os.arch()}, ${os.cpus().length} processors`,
      lanes: `${lanes}${cfg.env.DB_LANES ? ' (DB_LANES)' : ` (smaller of 4 and ${os.cpus().length} processors)`}${expected.lanes.length < laneCount(cfg.env.DB_LANES, os.cpus().length) ? ', limited by the number of files' : ''}`,
      load: os.loadavg().map((l) => l.toFixed(2)).join(' '),
      'swap in use': swapUsedMb(),
      postgres: `${version}, port ${server.port}, boot-check port ${server.bootPort}`,
      'collation / encoding': collation,
      'data directory': server.dataDir,
      'shared-memory segments': `${segmentsAtStart} (${sweep.removedSegments.length} orphans removed, ${sweep.stopped.length} orphan servers stopped, ${sweep.removedDirs.length} leftover directories removed)`,
      'path rule': skipped ? `skip the lanes and what follows (${cfg.skip!.reason})` : `run everything (${cfg.skip?.reason ?? 'no rule given'})`,
      selection: filtered ? `${expected.all.length} files matching ${cfg.patterns.join(', ')}` : `${expected.all.length} files (all)`,
    };
    out(`${renderPreflight(preflight)}\n`);

    const urlFor = (db: string) => serverUrl(server!, db);
    const template = urlFor(TEMPLATE_DB);
    const dbEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...baseEnv, ...extra });
    const vitest = npmBin(backendDir, 'vitest');
    const tsx = npmBin(backendDir, 'tsx');
    const prisma = npmBin(backendDir, 'prisma');
    const psql = path.join(server.binDir, 'psql');
    const migrateEnv = dbEnv({ DATABASE_URL: template, DIRECT_URL: template });

    const created = sh(path.join(server.binDir, 'createdb'), [TEMPLATE_DB], baseEnv);
    if (created.status !== 0) throw new InfraError('server-start', `could not create the template database: ${created.stderr.trim()}`);

    const coreVitest = (phase: string, file: string, extra: NodeJS.ProcessEnv = {}) =>
      step(phase, vitest, coreVitestArgs(REPORTER, file), dbEnv({ TEST_DATABASE_URL: template, DB_CHECK_EVENTS_FILE: eventsFile, DB_CHECK_PHASE: phase, ...extra }), { stalls: true });

    // Core checks, in today's order (decisions.ts, corePhaseOrder). No retry. Every one runs even when an earlier one fails.
    const thunks: Record<string, () => Promise<unknown>> = {
      [PHASE.roles]: () => step(PHASE.roles, psql, ['-X', '-v', 'ON_ERROR_STOP=1', '-d', TEMPLATE_DB, '-f', 'scripts/ci-outside-roles.sql'], baseEnv),
      [PHASE.migrate]: () => step(PHASE.migrate, prisma, ['migrate', 'deploy'], migrateEnv),
      [PHASE.status]: () => step(PHASE.status, prisma, ['migrate', 'status'], migrateEnv),
      [PHASE.boot]: () => bootPhase(),
      [PHASE.seed]: () => step(PHASE.seed, tsx, ['src/seed-organization.ts'], dbEnv({ DATABASE_URL: template, DIRECT_URL: template, SEED_ALLOW_DEMO_ORG: 'true' })),
      [PHASE.drift]: () => step(PHASE.drift, tsx, ['src/scripts/check-role-permission-drift.ts'], migrateEnv),
    };
    for (const c of [...expected.core, ...expected.after]) thunks[c.phase] = () => coreVitest(c.phase, c.file, c.phase === AFTER_LANES.phase ? { RUN_INTEGRATION_TESTS: '1', DATABASE_URL: template, DIRECT_URL: template } : {});
    const planFor = (names: string[]) => names.map((name) => ({ name, run: thunks[name]! }));
    await runPlan(planFor(corePhaseOrder(expected, { filtered, boot: cfg.boot })), halted);

    // Skipped by the path rule: say so in the phase table, once the core checks have run.
    if (skipped) {
      for (const name of ['lanes', 'numbering suite and permission drift check (after the lanes)']) phases.push({ name, ok: true, skippedReason: 'no relevant path changed', ms: 0 });
    }

    // The lanes.
    if (!halted() && lanes > 0) {
      await cloneLanes();
      laneStartedAt = Date.now();
      const laneEnv = dbEnv({
        TEST_DATABASE_URL: urlFor('postgres'), DB_LANE_URL_BASE: serverUrl(server), DB_LANE_COUNT: String(lanes), DB_LANE_PSQL: psql,
        DB_CHECK_EVENTS_FILE: eventsFile, DB_CHECK_PHASE: 'lanes',
      });
      const sampler = setInterval(() => { peakConnections = Math.max(peakConnections, connectionCount()); }, 5_000);
      try {
        await step('lanes', vitest, laneVitestArgs(REPORTER, lanes, expected.lanes), laneEnv, { stalls: true });
      } finally {
        clearInterval(sampler);
        reopenTemplate();
      }
    }

    // After the lanes, on the reopened template. No retry.
    await runPlan(planFor(afterLanePhaseOrder(expected, { filtered, skipped })), halted);

    /** The built server answers, and the process answering is the one this check started. */
    async function bootPhase(): Promise<void> {
      const started = Date.now();
      out('\n::group::boot the built server\n');
      let ok = false;
      let why = '';
      const logFile = path.join(server!.runDir, 'boot.log');
      try {
        if (!existsSync(path.join(backendDir, 'dist/index.js'))) throw new Error('dist/index.js does not exist; run the build first (npm run build)');
        const port = server!.bootPort;
        const squatter = listenerPid(port);
        if (squatter) throw new Error(`boot-check port ${port} is already in use by process ${squatter}`);
        const fd = openLog(logFile);
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['dist/index.js'], {
          cwd: backendDir, stdio: ['ignore', fd, fd], detached: true,
          env: dbEnv({
            PORT: String(port), DATABASE_URL: template, DIRECT_URL: template,
            SUPABASE_URL: 'https://ci-placeholder.invalid',
            // A made-up value for a client that is never called: random at run time, so no key is written in the repository.
            SUPABASE_SERVICE_ROLE_KEY: `placeholder-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
          }),
        });
        let exited = false;
        child.on('exit', () => { exited = true; });
        try {
          const deadline = Date.now() + 45_000;
          while (Date.now() < deadline && !ok) {
            if (exited) throw new Error('the server exited during boot before it reached /health/deep');
            try {
              const deep = await fetch(`http://127.0.0.1:${port}/health/deep`, { signal: AbortSignal.timeout(5_000) });
              if (deep.ok) {
                const plain = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) });
                if (!plain.ok) throw new Error('/health did not answer although /health/deep did');
                const owner = listenerPid(port);
                if (owner !== child.pid) throw new Error(`the process answering on port ${port} (${owner ?? 'none'}) is not the one this check started (${child.pid})`);
                ok = true;
                break;
              }
            } catch (e) {
              if (e instanceof Error && /health|answering|exited/.test(e.message)) throw e;
            }
            await new Promise((r) => setTimeout(r, 1_000));
          }
          if (!ok) throw new Error('timed out after 45 s waiting for /health/deep');
        } finally {
          if (child.pid) signalGroup(child.pid, 'SIGKILL');
        }
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
        out(`${why}\n`);
        try { out(`${readFileSync(logFile, 'utf8')}\n`); } catch { /* no log */ }
      }
      out('::endgroup::\n');
      phases.push({ name: 'boot the built server', ok, ms: Date.now() - started });
      if (!ok) phaseFailures.push('boot the built server');
    }

    function openLog(file: string): number {
      writeFileSync(file, '');
      return openSync(file, 'a');
    }

    function connectionCount(): number {
      const r = psqlOut(server!, baseEnv, 'postgres', 'SELECT count(*) FROM pg_stat_activity');
      return Number(r.stdout.trim()) || 0;
    }

    /** Copies the template once per lane, then closes it to connections until the lanes finish. */
    async function cloneLanes(): Promise<void> {
      out('\n::group::copy the database once per lane\n');
      const started = Date.now();
      try {
        // Nothing may be connected to the template: every earlier step has ended, a connection closing is a moment's wait.
        const end = Date.now() + 5_000;
        let connected = connectionCountTo(TEMPLATE_DB);
        while (connected > 0 && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 200));
          connected = connectionCountTo(TEMPLATE_DB);
        }
        if (connected > 0) throw new InfraError('clone', `${connected} connection(s) are still open to the template database, so it cannot be copied`);
        for (let lane = 1; lane <= lanes; lane++) {
          const r = psqlOut(server!, baseEnv, 'postgres', `CREATE DATABASE lane_${lane} TEMPLATE ${TEMPLATE_DB}`);
          if (r.status !== 0) throw new InfraError('clone', `could not create lane ${lane}: ${r.stderr.trim()}`);
        }
        const close = psqlOut(server!, baseEnv, 'postgres', `ALTER DATABASE ${TEMPLATE_DB} WITH ALLOW_CONNECTIONS false`);
        if (close.status !== 0) throw new InfraError('clone', `could not close the template to connections: ${close.stderr.trim()}`);
        phases.push({ name: 'copy the database per lane', ok: true, ms: Date.now() - started });
      } catch (e) {
        phases.push({ name: 'copy the database per lane', ok: false, ms: Date.now() - started });
        throw e;
      } finally {
        out('::endgroup::\n');
      }
    }

    function connectionCountTo(db: string): number {
      const r = psqlOut(server!, baseEnv, 'postgres', `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}'`);
      return Number(r.stdout.trim()) || 0;
    }

    function reopenTemplate(): void {
      if (server && serverAlive(server)) psqlOut(server, baseEnv, 'postgres', `ALTER DATABASE ${TEMPLATE_DB} WITH ALLOW_CONNECTIONS true`);
    }
  } catch (e) {
    note(e);
    infra = e instanceof InfraError ? { kind: e.kind, detail: e.message } : { kind: 'wiring', detail: e instanceof Error ? e.message : String(e) };
  }

  // ---- the verdict, written before the server goes away (its log is part of the report) -------------------------------------------
  const events = eventsFile && existsSync(eventsFile) ? parseEvents(readFileSync(eventsFile, 'utf8')) : [];
  const policy = cfg.policy;
  const reconciliation = reconcile(events, expected?.all ?? [], policy, lanes, { full: cfg.patterns.length === 0 && !skipped, skippedByRule: expected?.skippedByRule });
  if (!infra && st.serverDied) infra = { kind: 'server-died', detail: 'the private server stopped while the run was going' };
  if (!infra && !st.stall && !st.deadlineHit && !st.cancelled) infra = infraFromEvents(events);
  // A deadline is a stall of the whole run.
  const stalled = st.stall !== undefined || st.deadlineHit;
  const verdict = classify({ cancelled: st.cancelled, infra, stalled, phaseFailures, reconciliation });
  const line = verdictLine(verdict, reconciliation, lanes);
  const stallInfo = st.stall ?? (st.deadlineHit ? checkStall(events, Date.now(), laneStartedAt || t0, 0) ?? undefined : undefined);
  const summary = renderSummary({
    line, verdict, reconciliation, events, policy, preflight, phases, stall: stallInfo, infraDetail: infra?.detail,
    serverFatal: server ? fatalLines(server.logFile) : [], peakConnections: lanes > 0 ? peakConnections : undefined,
    wallMs: Date.now() - t0, selected: cfg.patterns.length ? expected?.all : undefined, full: cfg.patterns.length === 0 && !skipped,
    skip: skipped ? { reason: cfg.skip!.reason, files: expected?.skippedByRule?.length ?? 0 } : undefined,
  });
  out(`\n${summary}\n`);
  if (cfg.env.GITHUB_STEP_SUMMARY) appendFileSync(cfg.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  // For the next steps of the job (#3240): did the lanes run? The workflow records "this run tested the tree" only when they did, so a
  // run that skipped them by rule (#3238) is never taken, later, as proof for a push to main.
  if (cfg.env.GITHUB_OUTPUT) appendFileSync(cfg.env.GITHUB_OUTPUT, `suites_skipped=${skipped}\n`);

  // ---- stop: unconditional ----------------------------------------------------------------------------------------------------------
  const stopped = stopRun(server?.runDir);
  if (stopped.stopped) out(`\nServer log (tail):\n${stopped.logTail}\nServer stopped (${stopped.how}). Shared-memory segments now: ${segmentCount()} (${segmentsAtStart} at start).\n`);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(s, onSignal);

  out(`\n${line}\n`);
  if (cfg.env.GITHUB_ACTIONS && skipped) out('::notice title=Database check::suites skipped: no relevant path changed\n');
  if (cfg.env.GITHUB_ACTIONS && verdict.result !== 'passed') out(`::error title=Database check::${line}\n`);
  return verdict.code;
}

/** The host and port, for every later step of the job: a bare client command there reaches the private server and nothing else. */
function exportToLaterSteps(env: NodeJS.ProcessEnv, server: PrivateServer): void {
  if (!env.GITHUB_ENV) return;
  const lines = Object.entries({ ...clientEnv(server), DB_CHECK_RUN_DIR: server.runDir }).map(([k, v]) => `${k}=${v}`);
  appendFileSync(env.GITHUB_ENV, `${lines.join('\n')}\n`);
}
