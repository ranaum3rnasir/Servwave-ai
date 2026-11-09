/**
 * The Database command's decision functions (spec #3234, "Testing Decisions"): the expected file set, the port rule, the lane
 * count, orphan identification and the shared-memory sweep. Fixture inputs in, answers out; nothing is started.
 */
import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_PORTS, afterLanePhaseOrder, withoutLanes, bootPortFor, corePhaseOrder, runPlan, candidatePorts, expectedFiles, findBinDir, findOrphans, laneCount, majorVersion, orphanSegments,
  parseIpcs, parseIpcsCreators, parsePostgresProcesses, portIsAllowed,
} from '../decisions';

describe('the private server port', () => {
  it('is never in the kernel random range 49152-65535, and never 5432, 5433 or 3111', () => {
    const ports = candidatePorts();
    expect(ports.length).toBeGreaterThanOrEqual(16);
    for (const p of ports) {
      expect(p, `port ${p}`).toBeLessThan(49152);
      expect([5432, 5433, 3111]).not.toContain(p);
      expect(portIsAllowed(p)).toBe(true);
    }
  });

  it('gives a boot-check port derived from the database port that is also outside the range and never 3111', () => {
    for (const p of candidatePorts()) {
      const boot = bootPortFor(p);
      expect(boot, `boot port for ${p}`).toBeLessThan(49152);
      expect(boot).not.toBe(3111);
      expect(portIsAllowed(boot)).toBe(true);
      // The boot port of one run is never the database port of another.
      expect(candidatePorts()).not.toContain(boot);
    }
  });

  it('refuses the shared ports and the kernel range', () => {
    for (const p of [...FORBIDDEN_PORTS, 49152, 50000, 65535, 0, 80]) expect(portIsAllowed(p), String(p)).toBe(false);
  });
});

describe('the lane count', () => {
  it('is the setting when there is one (six on the reserved runner)', () => {
    expect(laneCount('6', 10)).toBe(6);
    expect(laneCount('6', 4)).toBe(6);
  });

  it('is otherwise the smaller of four and the processor count, and at least one', () => {
    expect(laneCount(undefined, 10)).toBe(4);
    expect(laneCount('', 10)).toBe(4);
    expect(laneCount(undefined, 4)).toBe(4);
    expect(laneCount(undefined, 2)).toBe(2);
    expect(laneCount(undefined, 0)).toBe(1);
  });

  it('ignores a setting that is not a whole number of at least one', () => {
    for (const bad of ['0', '-3', 'six', '2.5']) expect(laneCount(bad, 3), bad).toBe(3);
  });
});

/** A tracked file list shaped like the real one: many lane files, the core files, the numbering suite. */
function trackedFixture(extra: string[] = []): string[] {
  const lanes = Array.from({ length: 320 }, (_, i) => `src/__tests__/lane-${String(i).padStart(3, '0')}-db.test.ts`);
  return [
    ...lanes,
    'src/__tests__/rls-isolation.test.ts', 'src/__tests__/login-lockout-rls.test.ts', 'src/__tests__/rls-coverage.test.ts',
    'src/__tests__/seed-organization-db.test.ts', 'src/__tests__/task-categories-seed-db.test.ts', 'src/__tests__/task-category-writes-db.test.ts',
    'src/__tests__/task-category-delete-db.test.ts', 'src/__tests__/walkthrough-removal-race-db.test.ts',
    'src/__tests__/lead-walkthrough-window-scope-db.test.ts', 'src/__tests__/lead-statuses-fixed-db.test.ts',
    'src/__tests__/numbering.integration.test.ts', 'scripts/__tests__/backfill-payouts-db.test.ts',
    'src/__tests__/unit-only.test.ts', 'src/__tests__/customer-create.integration.test.ts',
    ...extra,
  ];
}

describe('the expected file set', () => {
  it('holds every real-database file, the three RLS files and the numbering suite, and nothing else', () => {
    const e = expectedFiles(trackedFixture());
    expect(e.all).toContain('scripts/__tests__/backfill-payouts-db.test.ts');
    expect(e.all).toContain('src/__tests__/numbering.integration.test.ts');
    for (const rls of ['rls-isolation', 'login-lockout-rls', 'rls-coverage']) expect(e.all).toContain(`src/__tests__/${rls}.test.ts`);
    expect(e.all).not.toContain('src/__tests__/unit-only.test.ts');
    // The eight integration suites that never run in CI (#3232) are not part of it, the numbering one apart.
    expect(e.all).not.toContain('src/__tests__/customer-create.integration.test.ts');
    expect(e.all).toHaveLength(320 + 1 + 6 + 3 + 1 + 1);
    expect(new Set(e.all).size).toBe(e.all.length);
  });

  it('runs the core checks in today\'s order, then the six own-step suites, and keeps them out of the lanes', () => {
    const e = expectedFiles(trackedFixture());
    expect(e.core.map((c) => c.phase)).toEqual([
      'rls-isolation', 'login-lockout-rls', 'rls-coverage', 'verify-seed',
      'suite:task-categories-seed', 'suite:task-category-writes', 'suite:task-category-delete',
      'suite:walkthrough-removal-race', 'suite:lead-walkthrough-window-scope', 'suite:lead-statuses-fixed',
    ]);
    for (const c of e.core) expect(e.lanes).not.toContain(c.file);
    expect(e.lanes).toHaveLength(321);
    expect(e.after.map((a) => a.file)).toEqual(['src/__tests__/numbering.integration.test.ts']);
    expect(e.lanes).toEqual([...e.lanes].sort());
  });

  it('is the same for every lane count: the lanes\' files do not depend on how many lanes there are', () => {
    expect(expectedFiles(trackedFixture()).lanes).toEqual(expectedFiles([...trackedFixture()].reverse()).lanes);
  });

  it('fails when the list cannot be produced (too few files, or a core file not tracked)', () => {
    expect(() => expectedFiles([])).toThrow(/could not be produced/);
    expect(() => expectedFiles(trackedFixture().slice(0, 100))).toThrow(/could not be produced/);
    expect(() => expectedFiles(trackedFixture().filter((f) => !f.includes('rls-coverage')))).toThrow(/rls-coverage.*not tracked/);
    expect(() => expectedFiles(trackedFixture().filter((f) => !f.includes('numbering.integration')))).toThrow(/numbering.*not tracked/);
  });

  it('narrows to the files that match a pattern, wherever they are, and refuses a pattern that matches nothing', () => {
    const e = expectedFiles(trackedFixture(), ['lane-001', 'rls-coverage']);
    expect(e.all.sort()).toEqual(['src/__tests__/lane-001-db.test.ts', 'src/__tests__/rls-coverage.test.ts']);
    expect(e.core.map((c) => c.phase)).toEqual(['rls-coverage']);
    expect(e.lanes).toEqual(['src/__tests__/lane-001-db.test.ts']);
    expect(e.after).toEqual([]);
    expect(() => expectedFiles(trackedFixture(), ['no-such-file'])).toThrow(/no real-database test file matches "no-such-file"/);
  });
});

describe('a run that skips the lanes (path-skip rule, #3238)', () => {
  const full = expectedFiles(trackedFixture());
  const skipped = withoutLanes(full);

  it('expects the core files and nothing else, and remembers which files the rule skipped (not the same as "did not run")', () => {
    expect(skipped.core).toEqual(full.core);
    expect(skipped.lanes).toEqual([]);
    expect(skipped.after).toEqual([]);
    expect(skipped.all).toEqual(full.core.map((c) => c.file));
    expect(skipped.skippedByRule).toEqual([...full.lanes, ...full.after.map((a) => a.file)]);
    expect(skipped.skippedByRule).toHaveLength(321 + 1);
    expect(full.skippedByRule).toBeUndefined();
  });

  it('keeps every core check: roles, migrations, status, boot, the three RLS suites, the seed and its verification, the six own-step suites', () => {
    expect(corePhaseOrder(skipped, { filtered: false, boot: true })).toEqual(corePhaseOrder(full, { filtered: false, boot: true }));
  });

  it('runs nothing after the lanes: not the numbering suite, not the permission drift check', () => {
    expect(afterLanePhaseOrder(skipped, { filtered: false, skipped: true })).toEqual([]);
    expect(afterLanePhaseOrder(full, { filtered: false, skipped: false })).toEqual(['numbering', 'permission drift check']);
    expect(afterLanePhaseOrder(full, { filtered: false })).toEqual(['numbering', 'permission drift check']);
  });

  it('on a filtered run skips only the lane files among the selection', () => {
    const e = withoutLanes(expectedFiles(trackedFixture(), ['lane-007', 'rls-coverage']));
    expect(e.all).toEqual(['src/__tests__/rls-coverage.test.ts']);
    expect(e.skippedByRule).toEqual(['src/__tests__/lane-007-db.test.ts']);
  });
});

describe('orphan servers', () => {
  const ps = [
    '  101 /usr/lib/postgresql/16/bin/postgres -D /runner/temp/servwave-db/run-aaa/data -p 24500',
    '  202 /usr/lib/postgresql/16/bin/postgres -D /runner/temp/servwave-db/run-own/data -p 24501',
    '  303 /usr/lib/postgresql/16/bin/postgres -D /other-runner/temp/servwave-db/run-bbb/data -p 24502',
    '  404 /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf',
    '  505 postgres: 16/main: checkpointer ',
    '  606 /usr/bin/vim /runner/temp/servwave-db/notes.txt',
  ].join('\n');

  it('reads the main server processes and their data directories out of ps', () => {
    expect(parsePostgresProcesses(ps)).toEqual([
      { pid: 101, dataDir: '/runner/temp/servwave-db/run-aaa/data' },
      { pid: 202, dataDir: '/runner/temp/servwave-db/run-own/data' },
      { pid: 303, dataDir: '/other-runner/temp/servwave-db/run-bbb/data' },
      { pid: 404, dataDir: '/var/lib/postgresql/16/main' },
    ]);
  });

  it('in a runner\'s own folder every server but this run\'s own is an orphan; other folders and the long-lived servers never are', () => {
    const orphans = findOrphans(parsePostgresProcesses(ps), {
      sweepRoot: '/runner/temp/servwave-db', exclusive: true, ownDataDir: '/runner/temp/servwave-db/run-own/data', ownerAlive: () => true,
    });
    expect(orphans.map((o) => o.pid)).toEqual([101]);
  });

  it('does not take a folder whose name only starts like the runner\'s folder', () => {
    const procs = [{ pid: 9, dataDir: '/runner/temp/servwave-db-extra/run/data' }];
    expect(findOrphans(procs, { sweepRoot: '/runner/temp/servwave-db', exclusive: true, ownerAlive: () => false })).toEqual([]);
  });

  it('in a folder shared by one user\'s runs (a laptop) an orphan is a server whose owner is dead, never a live run', () => {
    const procs = parsePostgresProcesses(ps);
    const orphans = findOrphans(procs, {
      sweepRoot: '/runner/temp/servwave-db', exclusive: false, ownDataDir: '/runner/temp/servwave-db/run-own/data',
      ownerAlive: (dir) => dir.includes('run-aaa') ? false : true,
    });
    expect(orphans.map((o) => o.pid)).toEqual([101]);
    const live = findOrphans(procs, { sweepRoot: '/runner/temp/servwave-db', exclusive: false, ownerAlive: () => true });
    expect(live).toEqual([]);
  });
});

describe('shared-memory segments', () => {
  const linux = [
    '------ Shared Memory Segments --------',
    'key        shmid      owner      perms      bytes      nattch     status      ',
    '0x00032b99 0          postgres   600        56         6                       ',
    '0x00aa0001 7          runner     600        56         0                       ',
    '0x00aa0002 8          runner     600        56         0                       ',
    '0x00aa0003 9          runner     600        56         2                       ',
    '',
  ].join('\n');
  const linuxPids = [
    '------ Shared Memory Creator/Last-op PIDs --------',
    'shmid      owner      cpid       lpid      ',
    '0          postgres   2948       2950      ',
    '7          runner     4001       4001      ',
    '8          runner     4002       4002      ',
    '9          runner     4003       4003      ',
    '',
  ].join('\n');
  const mac = [
    'IPC status from <running system> as of Sat Nov  7 21:00:00 2026',
    'T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP NATTCH     SEGSZ  CPID  LPID',
    'Shared Memory:',
    'm  65536 0x0b1c2d3e --rw------- runner    staff   runner    staff      0        56  4001  4001',
    'm  65537 0x0b1c2d3f --rw------- runner    staff   runner    staff      1        56  4002  4002',
    '',
  ].join('\n');

  it('reads Linux and macOS ipcs output', () => {
    expect(parseIpcs(linux).map((s) => [s.id, s.owner, s.attached])).toEqual([['0', 'postgres', 6], ['7', 'runner', 0], ['8', 'runner', 0], ['9', 'runner', 2]]);
    expect(parseIpcsCreators(linuxPids).get('8')).toBe(4002);
    expect(parseIpcs(mac).map((s) => [s.id, s.owner, s.attached, s.creator])).toEqual([['65536', 'runner', 0, 4001], ['65537', 'runner', 1, 4002]]);
  });

  it('removes only a segment that is ours, attached to nothing, and made by a process that is gone', () => {
    const creators = parseIpcsCreators(linuxPids);
    const segments = parseIpcs(linux).map((s) => ({ ...s, creator: creators.get(s.id) }));
    const alive = (pid: number) => pid === 4002 || pid === 2948;
    // 0: another user's, in use. 7: ours, unattached, creator 4001 dead. 8: creator alive. 9: still attached.
    expect(orphanSegments(segments, 'runner', alive).map((s) => s.id)).toEqual(['7']);
  });

  it('keeps a segment whose creator it cannot tell', () => {
    expect(orphanSegments(parseIpcs(linux), 'runner', () => false)).toEqual([]);
  });
});

describe('finding the Postgres 16 programs', () => {
  it('prefers PATH, then the usual package locations, and answers undefined when there is none', () => {
    const has = (dirs: string[]) => (d: string) => dirs.includes(d);
    expect(findBinDir('/a:/b', has(['/b', '/usr/lib/postgresql/16/bin']))).toBe('/b');
    expect(findBinDir('/a', has(['/opt/homebrew/opt/postgresql@16/bin']))).toBe('/opt/homebrew/opt/postgresql@16/bin');
    expect(findBinDir(undefined, has([]))).toBeUndefined();
  });

  it('reads the major version of the server program', () => {
    expect(majorVersion('postgres (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)')).toBe(16);
    expect(majorVersion('postgres (PostgreSQL) 14.2')).toBe(14);
    expect(majorVersion('nonsense')).toBeUndefined();
  });
});

describe('the order of the core checks', () => {
  it('keeps today\'s order: roles, migrations, status, boot, isolation, lockout, coverage, seed, verify seed, the six suites', () => {
    const e = expectedFiles(trackedFixture());
    expect(corePhaseOrder(e, { filtered: false, boot: true })).toEqual([
      'outside roles', 'migrations apply', 'migrations match the schema', 'boot the built server',
      'rls-isolation', 'login-lockout-rls', 'rls-coverage', 'seed organization', 'verify-seed',
      'suite:task-categories-seed', 'suite:task-category-writes', 'suite:task-category-delete',
      'suite:walkthrough-removal-race', 'suite:lead-walkthrough-window-scope', 'suite:lead-statuses-fixed',
    ]);
    expect(afterLanePhaseOrder(e, { filtered: false })).toEqual(['numbering', 'permission drift check']);
  });

  it('puts the lockout check, which creates a cluster-wide role, before everything the lanes run', () => {
    const order = corePhaseOrder(expectedFiles(trackedFixture()), { filtered: false, boot: false });
    expect(order).toContain('login-lockout-rls');
    expect(order).not.toContain('boot the built server');
    expect(order.indexOf('outside roles')).toBeLessThan(order.indexOf('migrations apply'));
  });

  it('a filtered run keeps the setup and the selected checks; the seed comes before its verification', () => {
    const e = expectedFiles(trackedFixture(), ['seed-organization-db', 'rls-coverage', 'lane-007']);
    expect(corePhaseOrder(e, { filtered: true, boot: true })).toEqual(['outside roles', 'migrations apply', 'rls-coverage', 'seed organization', 'verify-seed']);
    expect(afterLanePhaseOrder(e, { filtered: true })).toEqual([]);
    const lanesOnly = expectedFiles(trackedFixture(), ['lane-007']);
    expect(corePhaseOrder(lanesOnly, { filtered: true, boot: true })).toEqual(['outside roles', 'migrations apply']);
  });
});

describe('running the checks one after the other', () => {
  const plan = (log: string[]) => ['a', 'b', 'c', 'd'].map((name) => ({ name, run: async () => { log.push(name); return name !== 'b'; } }));

  it('runs every check even after one has failed: an early red never hides a later one', async () => {
    const log: string[] = [];
    expect(await runPlan(plan(log), () => false)).toEqual(['a', 'b', 'c', 'd']);
    expect(log).toEqual(['a', 'b', 'c', 'd']);
  });

  it('stops only when the run is halted (cancelled, stalled, past its deadline, server gone)', async () => {
    const log: string[] = [];
    expect(await runPlan(plan(log), () => log.includes('b'))).toEqual(['a', 'b']);
  });
});
