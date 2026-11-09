/*
 * The private Postgres server of one Database check run: made fresh, answers on loopback TCP only, and is stopped and deleted
 * at the end. The decisions (which ports, which leftovers are orphans) are in decisions.ts; this is the thin shell around them.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, chownSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InfraError } from './errors';
import {
  candidatePorts, bootPortFor, findBinDir, findOrphans, majorVersion, orphanSegments, parseIpcs, parseIpcsCreators, parsePostgresProcesses,
  type PostgresProcess, type ShmSegment,
} from './decisions';

export interface PrivateServer {
  runDir: string;
  dataDir: string;
  logFile: string;
  port: number;
  bootPort: number;
  /** The database superuser: the account that runs the command, as the old job did with `whoami`. */
  user: string;
  binDir: string;
  /** Set when the command runs as root: the account the server process runs as (Postgres refuses to run as root). */
  osUser?: { name: string; uid: number; gid: number };
}

export const serverUrl = (s: Pick<PrivateServer, 'user' | 'port'>, database = ''): string => `postgresql://${s.user}@127.0.0.1:${s.port}${database ? `/${database}` : ''}`;

type RunOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'>;
const run = (cmd: string, args: string[], opts: RunOptions = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

export function currentUser(): string {
  return os.userInfo().username;
}

// ---- where a runner keeps its private servers ----------------------------------------------------------------------------

/**
 * In CI the runner program's own temporary folder (emptied by the runner at the start and end of every job, and a runner
 * program runs one job at a time, so everything in it is an orphan by construction). Elsewhere a private folder of the user's,
 * shared by that user's runs, where a server is an orphan only when its owner is dead.
 */
export function sweepLocation(env: NodeJS.ProcessEnv): { root: string; exclusive: boolean } {
  if (env.RUNNER_TEMP) return { root: path.join(env.RUNNER_TEMP, 'servwave-db'), exclusive: true };
  return { root: path.join(os.tmpdir(), `servwave-db-${currentUser()}`), exclusive: false };
}

// ---- finding and checking the programs --------------------------------------------------------------------------------------

export function locateBinaries(env: NodeJS.ProcessEnv): string {
  const hasServer = (dir: string) => existsSync(path.join(dir, 'postgres')) && existsSync(path.join(dir, 'initdb')) && existsSync(path.join(dir, 'pg_ctl'));
  const dir = findBinDir(env.PATH, hasServer);
  if (!dir) throw new InfraError('server-start', 'PostgreSQL 16 programs were not found. Install PostgreSQL 16 (apt install postgresql-16, or brew install postgresql@16) and run again.');
  const major = majorVersion(run(path.join(dir, 'postgres'), ['--version']).stdout ?? '');
  if (major !== 16) throw new InfraError('server-start', `${dir} is PostgreSQL ${major ?? 'of an unknown version'}, this check needs 16. Put the PostgreSQL 16 programs first on PATH.`);
  return dir;
}

// ---- orphans -----------------------------------------------------------------------------------------------------------------

/** Whose shared-memory segments are ours: the account the server runs as (not root, when the command is run as root). */
const segmentOwner = (): string => (process.getuid?.() === 0 && process.env.DB_CHECK_SERVER_USER) || currentUser();

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function waitGone(pid: number, ms: number): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    sleepSync(100);
  }
  return !alive(pid);
}

/** Children of a process, for the last resort. */
function childPids(pid: number): number[] {
  const ps = run('ps', ['-axo', 'pid=,ppid=']).stdout ?? '';
  return ps.split('\n').flatMap((l) => {
    const [p, pp] = l.trim().split(/\s+/).map(Number);
    return pp === pid && p ? [p] : [];
  });
}

/** Stops a server by its process id: gracefully, then forcibly after a timeout. */
export function killServerProcess(pid: number, gracefulMs = 15_000): 'graceful' | 'forced' | 'gone' {
  if (!alive(pid)) return 'gone';
  const kids = childPids(pid);
  try { process.kill(pid, 'SIGINT'); } catch { /* gone already */ }
  if (waitGone(pid, gracefulMs)) return 'graceful';
  try { process.kill(pid, 'SIGQUIT'); } catch { /* gone already */ }
  if (waitGone(pid, 5_000)) return 'forced';
  for (const p of [pid, ...kids]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone already */ } }
  waitGone(pid, 5_000);
  return 'forced';
}

export interface SweepReport {
  stopped: { pid: number; dataDir: string; how: string }[];
  removedDirs: string[];
  removedSegments: string[];
  segmentsBefore: number;
  segmentsAfter: number;
}

/** What is in the folder: the run directories. */
function runDirsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).map((n) => path.join(root, n)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

function ownerAliveFor(dataDir: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(path.join(path.dirname(dataDir), 'owner.json'), 'utf8')) as { pid: number };
    return alive(owner.pid);
  } catch {
    // No owner file: nothing says a live run owns it.
    return false;
  }
}

function listSegments(user: string = segmentOwner()): ShmSegment[] {
  const plain = run('ipcs', ['-m', '-a']);
  if (plain.error || plain.status !== 0) return [];
  let segments = parseIpcs(plain.stdout ?? '');
  if (segments.some((s) => s.creator === undefined)) {
    // Linux: the creators are in a second listing.
    const creators = parseIpcsCreators(run('ipcs', ['-m', '-p']).stdout ?? '');
    segments = segments.map((s) => ({ ...s, creator: s.creator ?? creators.get(s.id) }));
  }
  return segments.filter((s) => s.owner === user);
}

/**
 * Orphan sweep by identity, never by age (spec "The private Postgres server"): stops the servers of earlier runs that left theirs
 * behind, deletes their directories, then removes the shared-memory segments that nothing is attached to and whose creator is dead.
 */
export function sweepOrphans(env: NodeJS.ProcessEnv, ownDataDir?: string): SweepReport {
  const { root, exclusive } = sweepLocation(env);
  const user = segmentOwner();
  const procs: PostgresProcess[] = parsePostgresProcesses(run('ps', ['-axo', 'pid=,command=']).stdout ?? '');
  const orphans = findOrphans(procs, { sweepRoot: root, exclusive, ownDataDir, ownerAlive: ownerAliveFor });
  const stopped = orphans.map((o) => ({ pid: o.pid, dataDir: o.dataDir, how: killServerProcess(o.pid) }));

  const removedDirs: string[] = [];
  const ownRun = ownDataDir ? path.dirname(ownDataDir) : undefined;
  const live = new Set(procs.map((p) => path.dirname(path.resolve(p.dataDir))));
  for (const dir of runDirsIn(root)) {
    if (dir === ownRun) continue;
    // A directory of a server still running (another live run, in a shared folder) is not ours to remove.
    if (live.has(dir) && !orphans.some((o) => path.dirname(path.resolve(o.dataDir)) === dir)) continue;
    if (!exclusive && ownerAliveFor(path.join(dir, 'data'))) continue;
    rmSync(dir, { recursive: true, force: true });
    removedDirs.push(dir);
  }

  const segmentsBefore = listSegments(user);
  const removedSegments: string[] = [];
  for (const s of orphanSegments(segmentsBefore, user, alive)) {
    if (run('ipcrm', ['-m', s.id]).status === 0) removedSegments.push(s.id);
  }
  return { stopped, removedDirs, removedSegments, segmentsBefore: segmentsBefore.length, segmentsAfter: listSegments(user).length };
}

export const segmentCount = (): number => listSegments().length;

// ---- start ----------------------------------------------------------------------------------------------------------------------

/** The account the server process runs as when the command is run as root. */
function unprivilegedUser(env: NodeJS.ProcessEnv): { name: string; uid: number; gid: number } | undefined {
  if (process.getuid?.() !== 0) return undefined;
  const name = env.DB_CHECK_SERVER_USER;
  if (!name) throw new InfraError('server-start', 'PostgreSQL will not run as root. Run the command as a normal user, or set DB_CHECK_SERVER_USER to an unprivileged account.');
  const uid = Number(run('id', ['-u', name]).stdout);
  const gid = Number(run('id', ['-g', name]).stdout);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) throw new InfraError('server-start', `DB_CHECK_SERVER_USER=${name} is not an unprivileged account that exists`);
  return { name, uid, gid };
}

const tail = (file: string, lines = 40): string => {
  try { return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return '(no server log)'; }
};

/**
 * Makes the data directory under the run directory and starts a server on the first free port of the fixed range. The bind is
 * the claim: a port in use is found out by the server's own refusal, and the next is tried. No probe-then-start.
 */
export function startServer(env: NodeJS.ProcessEnv): PrivateServer {
  const made: { runDir?: string } = {};
  try {
    return startServerIn(env, made);
  } catch (e) {
    // A server that did not start leaves nothing behind.
    if (made.runDir) stopRun(made.runDir);
    throw e;
  }
}

function startServerIn(env: NodeJS.ProcessEnv, made: { runDir?: string }): PrivateServer {
  const binDir = locateBinaries(env);
  const osUser = unprivilegedUser(env);
  const { root } = sweepLocation(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const runDir = mkdtempSync(path.join(root, 'run-'));
  made.runDir = runDir;
  const dataDir = path.join(runDir, 'data');
  const logFile = path.join(runDir, 'server.log');
  const user = currentUser();
  writeFileSync(path.join(runDir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  if (osUser) {
    for (const p of [root, runDir, path.join(runDir, 'owner.json')]) chownSync(p, osUser.uid, osUser.gid);
  }
  // The locale variable is set for creation AND start: the runner service's environment has none, a certain day-one failure otherwise.
  const toolEnv: NodeJS.ProcessEnv = { ...env, PATH: `${binDir}${path.delimiter}${env.PATH ?? ''}`, LC_ALL: 'C', LANG: 'C', HOME: runDir };
  const asUser: RunOptions = { env: toolEnv, ...(osUser ? { uid: osUser.uid, gid: osUser.gid } : {}) };

  const init = run(path.join(binDir, 'initdb'), ['-D', dataDir, '-U', user, '--auth=trust', '--encoding=UTF8', '--locale=C'], asUser);
  if (init.status !== 0) throw new InfraError('server-start', `initdb failed: ${(init.stderr || init.stdout || String(init.error)).trim().split('\n').slice(-3).join(' | ')}`);
  appendFileSync(path.join(dataDir, 'postgresql.conf'), [
    '',
    '# Database check: loopback TCP only, no Unix socket, explicit and identical on every platform.',
    "listen_addresses = '127.0.0.1'",
    "unix_socket_directories = ''",
    'max_connections = 300',
    "timezone = 'UTC'",
    "log_timezone = 'UTC'",
    "lc_messages = 'C'",
    '',
  ].join('\n'));
  if (osUser) writeFileSync(logFile, '', { mode: 0o600 }), chownSync(logFile, osUser.uid, osUser.gid);

  let lastLog = '';
  for (const port of candidatePorts()) {
    const start = run(path.join(binDir, 'pg_ctl'), ['-D', dataDir, '-l', logFile, '-w', '-t', '60', '-o', `-p ${port}`, 'start'], asUser);
    if (start.status === 0) {
      const server: PrivateServer = { runDir, dataDir, logFile, port, bootPort: bootPortFor(port), user, binDir, osUser };
      writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(server));
      return server;
    }
    lastLog = tail(logFile);
    if (!/address already in use|could not bind|could not create any TCP\/IP sockets/i.test(lastLog)) {
      throw new InfraError('server-start', `the private server did not start on port ${port}:\n${lastLog}`);
    }
  }
  throw new InfraError('server-start', `no free port in ${candidatePorts()[0]}-${candidatePorts().at(-1)} for the private server:\n${lastLog}`);
}

/** The environment a bare client command (psql, createdb) needs to reach the private server and nothing else. */
export function clientEnv(s: PrivateServer): Record<string, string> {
  return { PGHOST: '127.0.0.1', PGPORT: String(s.port), PGUSER: s.user, PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '10' };
}

/** Asserts the server answering on the port is the one this run made: its data directory is ours, before anything else runs. */
export function assertOwnServer(s: PrivateServer, env: NodeJS.ProcessEnv): void {
  const r = run(path.join(s.binDir, 'psql'), ['-X', '-A', '-t', '-d', 'postgres', '-c', 'SHOW data_directory'], { env: { ...env, ...clientEnv(s) } });
  const answered = (r.stdout ?? '').trim();
  if (r.status !== 0 || !answered || realpathSync(answered) !== realpathSync(s.dataDir)) {
    throw new InfraError('wiring', `the server on port ${s.port} is not the one this run started (data directory "${answered || (r.stderr ?? '').trim()}", expected "${s.dataDir}")`);
  }
}

// ---- stop -----------------------------------------------------------------------------------------------------------------------

export interface StopReport {
  stopped: boolean;
  logTail: string;
  how: string;
}

/**
 * Unconditional and idempotent: prints the tail of the server log, stops the server, removes the directory. A directory that is
 * already gone is a report of "nothing to stop", never an error.
 */
export function stopRun(runDir: string | undefined): StopReport {
  if (!runDir || !existsSync(runDir)) return { stopped: false, logTail: '', how: 'nothing to stop' };
  const logTail = tail(path.join(runDir, 'server.log'));
  let how = 'no server was running';
  // A step the command was running when it was killed (the test run, with its workers) goes first: it holds connections to the server.
  try {
    const child = Number(readFileSync(path.join(runDir, 'child.pid'), 'utf8'));
    if (child > 0 && alive(child)) {
      try { process.kill(-child, 'SIGKILL'); } catch { try { process.kill(child, 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* none recorded */ }
  const dataDir = path.join(runDir, 'data');
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
    if (pid && alive(pid)) how = killServerProcess(pid);
  }
  rmSync(runDir, { recursive: true, force: true });
  return { stopped: true, logTail, how };
}

/** Whether the server of this run is still alive (a killed server mid-run is infrastructure, not a failed test). */
export function serverAlive(s: Pick<PrivateServer, 'dataDir'>): boolean {
  try {
    const pid = Number(readFileSync(path.join(s.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    return pid > 0 && alive(pid);
  } catch {
    return false;
  }
}
