/*
 * The Database check's decisions, as pure functions: nothing here starts a process or reads a file. scripts/ci-db/cli.ts
 * is the thin shell that feeds them real input. Spec: #3234, "The Database test command".
 */
import path from 'node:path';

// ---- the private server's port ----------------------------------------------------------------------------------------

/** The first port a private server tries. Outside 49152-65535 (the kernel hands those out at random to outgoing connections). */
export const PORT_FIRST = 24500;
/** How many ports in a row a private server may try: 32 runs on one machine at once is far more than it will ever see. */
export const PORT_COUNT = 32;
/** The built server's port for the boot check is the database port plus this: derived from it, so it is outside the same range. */
export const BOOT_PORT_OFFSET = 100;
/** Ports no private server or boot check may use: the shared server, its neighbour, and the boot check the old job used. */
export const FORBIDDEN_PORTS: readonly number[] = [5432, 5433, 3111];
export const KERNEL_RANDOM_PORTS = { first: 49152, last: 65535 } as const;

export function portIsAllowed(port: number): boolean {
  return Number.isInteger(port) && port > 1023 && !FORBIDDEN_PORTS.includes(port)
    && !(port >= KERNEL_RANDOM_PORTS.first && port <= KERNEL_RANDOM_PORTS.last);
}

/** The ports a server tries, in order: the next one only when the bind of the one before was refused. */
export function candidatePorts(): number[] {
  return Array.from({ length: PORT_COUNT }, (_, i) => PORT_FIRST + i);
}

export const bootPortFor = (databasePort: number): number => databasePort + BOOT_PORT_OFFSET;

// ---- lanes ------------------------------------------------------------------------------------------------------------

/**
 * The lane count: one setting. `setting` is DB_LANES (the workflow sets it to 6 on the reserved runner and leaves it empty
 * everywhere else). Without it, the smaller of four and the processor count, and at least one.
 */
export function laneCount(setting: string | undefined, cpus: number): number {
  const asked = Number(setting);
  if (setting && Number.isInteger(asked) && asked >= 1) return asked;
  return Math.max(1, Math.min(4, cpus));
}

// ---- the expected files -----------------------------------------------------------------------------------------------

/** Core checks that are vitest files, in today's order, with the phase name each one is reported under. */
export const CORE_BEFORE_SEED = [
  { phase: 'rls-isolation', file: 'src/__tests__/rls-isolation.test.ts' },
  { phase: 'login-lockout-rls', file: 'src/__tests__/login-lockout-rls.test.ts' },
  { phase: 'rls-coverage', file: 'src/__tests__/rls-coverage.test.ts' },
] as const;
export const CORE_VERIFY_SEED = { phase: 'verify-seed', file: 'src/__tests__/seed-organization-db.test.ts' } as const;
/** The six suites that have had a step of their own: serial, no retry, on the template before the lanes are copied. */
export const CORE_OWN_STEP_SUITES = [
  'src/__tests__/task-categories-seed-db.test.ts',
  'src/__tests__/task-category-writes-db.test.ts',
  'src/__tests__/task-category-delete-db.test.ts',
  'src/__tests__/walkthrough-removal-race-db.test.ts',
  'src/__tests__/lead-walkthrough-window-scope-db.test.ts',
  'src/__tests__/lead-statuses-fixed-db.test.ts',
] as const;
/** Runs after the lanes, on the reopened template, with no retry. */
export const AFTER_LANES = { phase: 'numbering', file: 'src/__tests__/numbering.integration.test.ts' } as const;

/** Fewer tracked real-database files than this means the list could not be produced (it was 400 when this was written). */
export const MIN_TRACKED_DB_FILES = 300;

export interface ExpectedFiles {
  /** Core vitest files in the order they run, each with its phase name. */
  core: { phase: string; file: string }[];
  /** Everything else, sorted: the lanes' files. */
  lanes: string[];
  after: { phase: string; file: string }[];
  /** All of them: what must have run, each exactly once. */
  all: string[];
  /** Files the path-skip rule left out of this run (#3238): not expected, and not "missing" either. Absent when nothing was skipped. */
  skippedByRule?: string[];
}

/**
 * The files a full run must run, from the tracked file names (paths relative to the backend folder): every `*-db.test.ts`, the
 * three RLS files and the numbering integration suite. Throws when the list cannot be produced: too few files, or a core file
 * that is not tracked. `patterns` (substrings of the path) narrow it to the matching files; no match is an error.
 */
export function expectedFiles(tracked: readonly string[], patterns: readonly string[] = []): ExpectedFiles {
  const dbFiles = tracked.filter((f) => f.endsWith('-db.test.ts'));
  if (dbFiles.length < MIN_TRACKED_DB_FILES) {
    throw new Error(`the list of real-database test files has ${dbFiles.length} files, expected at least ${MIN_TRACKED_DB_FILES}: the file list could not be produced`);
  }
  const trackedSet = new Set(tracked);
  const core: { phase: string; file: string }[] = [...CORE_BEFORE_SEED, CORE_VERIFY_SEED, ...CORE_OWN_STEP_SUITES.map((file) => ({ phase: `suite:${path.basename(file, '-db.test.ts')}`, file }))];
  for (const c of [...core, AFTER_LANES]) {
    if (!trackedSet.has(c.file)) throw new Error(`core check file ${c.file} is not tracked`);
  }
  const coreFiles = new Set(core.map((c) => c.file));
  const matches = (f: string) => patterns.length === 0 || patterns.some((p) => f.includes(p));
  const lanes = dbFiles.filter((f) => !coreFiles.has(f) && f !== AFTER_LANES.file).sort(byPath).filter(matches);
  const selectedCore = core.filter((c) => matches(c.file));
  const after = matches(AFTER_LANES.file) ? [AFTER_LANES] : [];
  const all = [...selectedCore.map((c) => c.file), ...lanes, ...after.map((a) => a.file)];
  if (all.length === 0) throw new Error(`no real-database test file matches ${patterns.map((p) => `"${p}"`).join(', ')}`);
  return { core: selectedCore, lanes, after: [...after], all };
}

/**
 * The files of a run whose lanes the path-skip rule skipped: the core files only. The lanes' files and the suite that follows them
 * are listed apart as skipped by rule, so the proof that everything ran can tell "skipped on purpose" from "did not run".
 */
export function withoutLanes(e: ExpectedFiles): ExpectedFiles {
  return {
    core: e.core,
    lanes: [],
    after: [],
    all: e.core.map((c) => c.file),
    skippedByRule: [...e.lanes, ...e.after.map((a) => a.file)],
  };
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- the order of the core checks ----------------------------------------------------------------------------------------------

export const PHASE = {
  roles: 'outside roles',
  migrate: 'migrations apply',
  status: 'migrations match the schema',
  boot: 'boot the built server',
  seed: 'seed organization',
  drift: 'permission drift check',
} as const;

/**
 * The checks before the lanes, in today's order: the outside roles, the migrations, migration status and drift, the boot of the built
 * server, tenant isolation, login-not-locked-out, RLS coverage, the seed and its verification, then the six suites that used to have
 * a step of their own. A filtered run keeps the setup (roles, migrations) and the selected checks; the seed comes before its
 * verification wherever that is selected. The login-lockout check has to come before the lanes because it creates a cluster-wide
 * role that two lane files would otherwise race to create.
 */
export function corePhaseOrder(expected: ExpectedFiles, o: { filtered: boolean; boot: boolean }): string[] {
  const selected = new Set(expected.core.map((c) => c.phase));
  const phases: string[] = [PHASE.roles, PHASE.migrate];
  if (!o.filtered) phases.push(PHASE.status);
  if (!o.filtered && o.boot) phases.push(PHASE.boot);
  for (const c of CORE_BEFORE_SEED) if (selected.has(c.phase)) phases.push(c.phase);
  if (!o.filtered || selected.has(CORE_VERIFY_SEED.phase)) phases.push(PHASE.seed);
  if (selected.has(CORE_VERIFY_SEED.phase)) phases.push(CORE_VERIFY_SEED.phase);
  for (const file of CORE_OWN_STEP_SUITES) {
    const phase = `suite:${path.basename(file, '-db.test.ts')}`;
    if (selected.has(phase)) phases.push(phase);
  }
  return phases;
}

/** The checks after the lanes, on the reopened template, with no retry. None when the path-skip rule skipped the lanes and what follows. */
export function afterLanePhaseOrder(expected: ExpectedFiles, o: { filtered: boolean; skipped?: boolean }): string[] {
  if (o.skipped) return [];
  return [...expected.after.map((a) => a.phase), ...(o.filtered ? [] : [PHASE.drift])];
}

/**
 * Runs the checks one after the other. A check that failed does not stop the ones after it (an early red never hides a later one);
 * only `halted` does (a cancel, the stall rule, a deadline, the server dying), because nothing after that can run.
 */
export async function runPlan(plan: readonly { name: string; run: () => Promise<unknown> }[], halted: () => boolean): Promise<string[]> {
  const ran: string[] = [];
  for (const item of plan) {
    if (halted()) break;
    await item.run();
    ran.push(item.name);
  }
  return ran;
}

// ---- orphans: leftovers of a run that never stopped its server ---------------------------------------------------------

export interface PostgresProcess {
  pid: number;
  /** The `-D` argument of the server's command line. */
  dataDir: string;
}

/** The main server processes in `ps -axo pid=,command=` output: a program called postgres with a -D data directory. */
export function parsePostgresProcesses(psOutput: string): PostgresProcess[] {
  const found: PostgresProcess[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\S*\/)?postgres\s+(?:.*?\s)?-D\s+(\S+)/.exec(line);
    if (m) found.push({ pid: Number(m[1]), dataDir: m[3]! });
  }
  return found;
}

export interface OrphanContext {
  /** The folder this runner (or this user, outside CI) keeps its private servers in. */
  sweepRoot: string;
  /** True when that folder belongs to this one runner program, which runs one job at a time: everything in it is an orphan. */
  exclusive: boolean;
  /** The data directory of the server this run just started, never an orphan. */
  ownDataDir?: string;
  /** For a folder that is not exclusive: whether the process that started the server in this data directory is still alive. */
  ownerAlive: (dataDir: string) => boolean;
}

/**
 * Which servers are orphans: those whose data directory is under this runner's own folder, by identity and never by age. A
 * server under another folder (another runner's, the two long-lived servers') is never one. In a folder shared by several
 * runs of one user (a laptop, the agents' runner) a server is an orphan only when its owner is dead.
 */
export function findOrphans(procs: readonly PostgresProcess[], ctx: OrphanContext): PostgresProcess[] {
  const root = ctx.sweepRoot.endsWith(path.sep) ? ctx.sweepRoot : ctx.sweepRoot + path.sep;
  return procs.filter((p) => {
    if (ctx.ownDataDir && path.resolve(p.dataDir) === path.resolve(ctx.ownDataDir)) return false;
    if (!path.resolve(p.dataDir).startsWith(root)) return false;
    return ctx.exclusive || !ctx.ownerAlive(p.dataDir);
  });
}

export interface ShmSegment {
  id: string;
  owner: string;
  attached: number;
  /** The creating process; unknown when the platform's tool did not say. */
  creator?: number;
}

/**
 * `ipcs -m` output (header-driven, so Linux's `key shmid owner perms bytes nattch status` and macOS's
 * `T ID KEY MODE OWNER GROUP CREATOR CGROUP NATTCH SEGSZ CPID LPID ...` both read). `ipcs -m -p` adds the creator on Linux.
 */
export function parseIpcs(text: string): ShmSegment[] {
  const lines = text.split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => /\b(shmid|id)\b/i.test(l) && /\bowner\b/i.test(l));
  if (at < 0) return [];
  const header = lines[at]!.toLowerCase().split(/\s+/);
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iId = col('shmid', 'id');
  const iOwner = col('owner');
  const iAttached = col('nattch');
  const iCreator = col('cpid');
  const segments: ShmSegment[] = [];
  for (const line of lines.slice(at + 1)) {
    const cells = line.split(/\s+/);
    // macOS's header starts with `T` (the kind) and each row with `m`, so the columns line up with the cells.
    const id = cells[iId];
    const owner = cells[iOwner];
    if (!id || !owner || !/^\d+$/.test(id)) continue;
    const attachedCell = iAttached >= 0 ? cells[iAttached] : undefined;
    const creatorCell = iCreator >= 0 ? cells[iCreator] : undefined;
    segments.push({
      id,
      owner,
      attached: attachedCell && /^\d+$/.test(attachedCell) ? Number(attachedCell) : 0,
      creator: creatorCell && /^\d+$/.test(creatorCell) ? Number(creatorCell) : undefined,
    });
  }
  return segments;
}

/** The creator pid per segment id from Linux's `ipcs -m -p` (columns `shmid owner cpid lpid`). */
export function parseIpcsCreators(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of parseIpcs(text)) if (s.creator !== undefined) out.set(s.id, s.creator);
  return out;
}

/** Segments that are safe to remove: ours, attached to nothing, and made by a process that no longer exists. Unknown creator = keep. */
export function orphanSegments(segments: readonly ShmSegment[], user: string, alive: (pid: number) => boolean): ShmSegment[] {
  return segments.filter((s) => s.owner === user && s.attached === 0 && s.creator !== undefined && !alive(s.creator));
}

// ---- finding the server programs ---------------------------------------------------------------------------------------

/** Where Postgres 16 usually lives: the system path, then the package locations of Linux and macOS. */
export const POSTGRES_BIN_LOCATIONS: readonly string[] = [
  '/usr/lib/postgresql/16/bin',
  '/usr/pgsql-16/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@16/bin',
];

/** The first folder that holds a postgres program, trying the folders on PATH first and the usual package locations after. */
export function findBinDir(pathEnv: string | undefined, hasServer: (dir: string) => boolean): string | undefined {
  const onPath = (pathEnv ?? '').split(path.delimiter).filter(Boolean);
  return [...onPath, ...POSTGRES_BIN_LOCATIONS].find(hasServer);
}

/** The major version in `postgres --version` output ("postgres (PostgreSQL) 16.15 (...)"), or undefined. */
export function majorVersion(versionOutput: string): number | undefined {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput);
  return m ? Number(m[1]) : undefined;
}
