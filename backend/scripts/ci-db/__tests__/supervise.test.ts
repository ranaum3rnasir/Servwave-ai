/**
 * The runner's behaviour with the test tool replaced by a stub (spec #3234, "Testing Decisions"): a stub that writes events like the
 * real reporter, then exits, dies, hangs or is cut off. Real processes, real kills; no database.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supervise, signalGroup } from '../supervise';
import { reconcile, classify, type Policy } from '../results';

const dirs: string[] = [];
/** Every stub's process group (supervise() starts each stub detached, so it is its own group leader). */
const stubs: number[] = [];
// A stub that hangs on purpose must never outlive the test: a failing assertion, or an interrupted run, skips supervise()'s own kill.
// Two guards: every stub exits by itself after STUB_LIFETIME_MS (this covers a SIGINT or SIGKILL of the whole run, when no hook
// runs), and afterEach ends the group of every stub, workers included.
const STUB_LIFETIME_MS = 20_000;
afterEach(() => {
  while (stubs.length) signalGroup(stubs.pop()!, 'SIGKILL');
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const POLICY: Policy = { floor: 0, maxRetried: 10, allowedSkips: [], totalTestSecondsBudget: 100 };

/** A stub "vitest": a node script that appends the given events, then does `then`. */
function stub(files: string[], then: string, hangOn?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-db-supervise-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.jsonl');
  writeFileSync(eventsFile, '');
  const script = path.join(dir, 'stub.js');
  writeFileSync(script, `
    setTimeout(() => process.exit(0), ${STUB_LIFETIME_MS}).unref();
    const fs = require('fs');
    const add = (e) => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ ...e, t: Date.now() }) + '\\n');
    const files = ${JSON.stringify(files)};
    files.forEach((file, i) => {
      add({ ev: 'lane-start', lane: 1 + (i % 2), file });
      if (file === ${JSON.stringify(hangOn ?? '')}) return;
      add({ ev: 'test', phase: 'lanes', file, name: 't', state: 'passed', retries: 0, ms: 1 });
      add({ ev: 'module', phase: 'lanes', file, state: 'passed', ms: 1 });
      add({ ev: 'lane-end', lane: 1 + (i % 2), file });
    });
    ${then}
  `);
  return { dir, eventsFile, script };
}

const base = (s: ReturnType<typeof stub>, extra = {}) => ({ cmd: process.execPath, args: [s.script], env: process.env, cwd: s.dir, eventsFile: s.eventsFile, pollMs: 50, graceMs: 500, onChild: (pid?: number) => { if (pid) stubs.push(pid); }, ...extra });
const FILES = ['a-db.test.ts', 'b-db.test.ts', 'c-db.test.ts'];

describe('supervising a test run', () => {
  it('a run that exits non-zero still hands back everything that finished, so the report can be written', async () => {
    const s = stub(FILES, 'process.exit(1);');
    const r = await supervise(base(s));
    expect(r).toMatchObject({ code: 1, ended: 'exit' });
    expect(r.events.filter((e) => e.ev === 'module')).toHaveLength(3);
  });

  it('a run killed by a signal is red: no exit code, the signal named', async () => {
    const s = stub(FILES, "process.kill(process.pid, 'SIGKILL');");
    const r = await supervise(base(s));
    expect(r.signal).toBe('SIGKILL');
    expect(r.code).toBeNull();
  });

  it('a run that exits clean with no result is not green: the files it never reported are missing', async () => {
    const s = stub([], 'process.exit(0);');
    const r = await supervise(base(s));
    expect(r).toMatchObject({ code: 0, events: [] });
    const rec = reconcile(r.events, FILES, POLICY, 2, { full: false });
    expect(classify({ phaseFailures: [], reconciliation: rec })).toMatchObject({ result: 'incomplete', code: 11 });
  });

  it('a run past its deadline is stopped and marked, and what finished before is still reported', async () => {
    const s = stub(FILES, 'setInterval(() => {}, 1000);');
    const r = await supervise(base(s, { deadlineMs: 400 }));
    expect(r.ended).toBe('deadline');
    expect(r.events.filter((e) => e.ev === 'module')).toHaveLength(3);
  });

  it('a run with no file finishing for the stall window is stopped, and the stall names the file in flight', async () => {
    const s = stub(FILES, 'setInterval(() => {}, 1000);', 'c-db.test.ts');
    const r = await supervise(base(s, { stallMs: 400 }));
    expect(r.ended).toBe('stall');
    expect(r.stall?.inFlight.map((f) => [f.lane, f.file])).toEqual([[1, 'c-db.test.ts']]);
    expect(r.events.filter((e) => e.ev === 'module')).toHaveLength(2);
  });

  it('stops the whole process group, workers included', async () => {
    const s = stub([], `
      const { spawn } = require('child_process');
      const w = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${STUB_LIFETIME_MS})'], { stdio: 'inherit' });
      require('fs').writeFileSync(${JSON.stringify('PIDFILE')}, String(w.pid));
      setInterval(() => {}, 1000);
    `.replace('PIDFILE', 'pid.txt'));
    const r = await supervise(base(s, { deadlineMs: 600, cwd: s.dir }));
    expect(r.ended).toBe('deadline');
    const pid = Number((await import('node:fs')).readFileSync(path.join(s.dir, 'pid.txt'), 'utf8'));
    await new Promise((res) => setTimeout(res, 200));
    // Gone, or a zombie nobody has collected yet.
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    expect(state === '' || state.startsWith('Z'), `worker ${pid} is still running (${state})`).toBe(true);
  });

  it('a server that dies mid-run stops the run, marked as the server dying', async () => {
    const s = stub(FILES, 'setInterval(() => {}, 1000);');
    let calls = 0;
    const r = await supervise(base(s, { serverAlive: () => ++calls < 4 }));
    expect(r.ended).toBe('server-died');
  });

  it('a cancelled run is stopped and marked cancelled', async () => {
    const s = stub(FILES, 'setInterval(() => {}, 1000);');
    let calls = 0;
    const r = await supervise(base(s, { cancelled: () => ++calls > 3 }));
    expect(r.ended).toBe('cancelled');
  });
});
