/* =============================================================================
   #2991: the server's stop signal (lib/graceful-stop.ts) and where it is wired.

   1. A real process (a stand-in server started with tsx): on SIGTERM or SIGINT it lets the work in progress finish,
      then ends by that same signal, exactly as an unhandled signal always ended it; work that never finishes is cut
      off after the bounded wait; with nothing running it ends at once; a second signal ends it at once.
   2. Wiring (source guard): the server installs the handler where it starts (index.ts) and waits on the Spider sweep;
      the sweep starts no run once stopping, and treats stopping like a lost lease, which it checks before every
      company, per-lead alert and starting summary (spider-sweep-lease-guard.test.ts pins those checks).
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { STOP_WAIT_MS, _resetStopRequest, installStopSignals, onStopTimeLeft, requestStop, stopRequested, stopTimeLeftMs, type StopProcess } from '../lib/graceful-stop';

const BACKEND = join(__dirname, '..', '..');
const CHILD = join(__dirname, 'fixtures', 'graceful-stop-child.ts');

interface Ended {
  signal: NodeJS.Signals | null;
  code: number | null;
  out: string;
  /** From the first signal to the exit. */
  afterSignalMs: number;
}

/** Starts the stand-in server, sends `signals` once it is ready (`gapMs` apart), and reports how it ended. */
function stopChild(mode: 'finishes' | 'hangs' | 'idle', maxWaitMs: number, signals: NodeJS.Signals[], gapMs = 200): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, mode, String(maxWaitMs)], {
      cwd: BACKEND,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let sentAt = 0;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (!sentAt && out.includes('READY')) {
        sentAt = Date.now();
        signals.forEach((s, i) => setTimeout(() => child.kill(s), i * gapMs));
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, out, afterSignalMs: Date.now() - sentAt }));
  });
}

describe('the server stop signal (real process)', () => {
  it('waits at most 25 s: inside the ~30 s the platform gives after SIGTERM', () => {
    expect(STOP_WAIT_MS).toBe(25_000);
  });

  it('SIGTERM: the work in progress finishes, then the process ends by SIGTERM', { timeout: 30_000 }, async () => {
    const r = await stopChild('finishes', 5000, ['SIGTERM']);
    expect(r.out).toContain('FINISHED stopRequested=true');
    expect(r.signal).toBe('SIGTERM');
    expect(r.afterSignalMs).toBeGreaterThanOrEqual(400);
  });

  it('SIGINT: the same', { timeout: 30_000 }, async () => {
    const r = await stopChild('finishes', 5000, ['SIGINT']);
    expect(r.out).toContain('FINISHED stopRequested=true');
    expect(r.signal).toBe('SIGINT');
  });

  it('work that never finishes is cut off after the bounded wait', { timeout: 30_000 }, async () => {
    const r = await stopChild('hangs', 600, ['SIGTERM']);
    expect(r.out).not.toContain('FINISHED');
    expect(r.out).toContain('did not finish within');
    expect(r.signal).toBe('SIGTERM');
    expect(r.afterSignalMs).toBeGreaterThanOrEqual(550);
    expect(r.afterSignalMs).toBeLessThan(5000);
  });

  it('with nothing running, the process ends at once', { timeout: 30_000 }, async () => {
    const r = await stopChild('idle', 20_000, ['SIGTERM']);
    expect(r.signal).toBe('SIGTERM');
    expect(r.afterSignalMs).toBeLessThan(2000);
  });

  it('a second signal while waiting ends the process at once', { timeout: 30_000 }, async () => {
    const r = await stopChild('hangs', 20_000, ['SIGTERM', 'SIGTERM'], 300);
    expect(r.signal).toBe('SIGTERM');
    expect(r.afterSignalMs).toBeLessThan(3000);
  });
});

describe('the stop budget (what work that may finish inside the bounded wait asks)', () => {
  it('no stop: unlimited; the handler starts the budget with its own bounded wait, a later request changes nothing', () => {
    _resetStopRequest();
    try {
      expect(stopTimeLeftMs()).toBe(Infinity);
      const handlers = new Map<string, Parameters<StopProcess['on']>[1]>();
      const proc: StopProcess = {
        pid: 4242,
        on: (signal, fn) => handlers.set(signal, fn),
        removeListener: (signal) => handlers.delete(signal),
        kill: () => undefined,
      };
      installStopSignals({ finishing: async () => undefined, maxWaitMs: 3_000, proc });
      handlers.get('SIGTERM')!('SIGTERM');
      expect(stopRequested()).toBe(true);
      const left = stopTimeLeftMs();
      expect(left).toBeGreaterThan(2_500);
      expect(left).toBeLessThanOrEqual(3_000);
      requestStop(60_000);
      expect(stopTimeLeftMs()).toBeLessThanOrEqual(3_000);
    } finally {
      _resetStopRequest();
    }
    expect(stopTimeLeftMs()).toBe(Infinity);
  });

  it('a watcher is called once when the given time is left of the bounded wait, never without a stop, never once cancelled', async () => {
    _resetStopRequest();
    try {
      const calls: string[] = [];
      const leftWhen: number[] = [];
      onStopTimeLeft(400, () => {
        calls.push('before the stop');
        leftWhen.push(stopTimeLeftMs());
      });
      const cancel = onStopTimeLeft(400, () => calls.push('cancelled'));
      cancel();
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toEqual([]);

      requestStop(1_000);
      onStopTimeLeft(2_000, () => calls.push('already that close'));
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toEqual(['already that close']);
      await new Promise((r) => setTimeout(r, 900));
      expect(calls).toEqual(['already that close', 'before the stop']);
      expect(leftWhen[0]).toBeGreaterThan(200);
      expect(leftWhen[0]).toBeLessThanOrEqual(400);
    } finally {
      _resetStopRequest();
    }
  });
});

/** The source with comments blanked out. */
const code = (rel: string) => readFileSync(join(BACKEND, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the stop signal is wired (source guard)', () => {
  it('the server installs the handler once, waiting on the Spider sweep and the Spider check (and ending every live line first, #3472)', () => {
    const index = code('src/index.ts');
    expect(index.match(/\binstallStopSignals\s*\(/g) ?? []).toHaveLength(1);
    const finishing = /installStopSignals\(\{\s*finishing:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},?\s*\}\)/.exec(index)?.[1];
    expect(finishing).toBeDefined();
    expect(finishing).toMatch(/\bendAllLiveLines\(\)/);
    // The wait ends only once both the sweep (#2993) and the check (#3469) have finished their current step.
    expect(finishing).toMatch(/return\s+Promise\.all\(\[\s*whenSpiderSweepIdle\(\),\s*whenSpiderTickIdle\(\)\s*\]\)[^;]*;\s*$/);
  });

  it('no other code handles SIGTERM or SIGINT', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(BACKEND, dir)).flatMap((name) => {
        const rel = `${dir}/${name}`;
        if (statSync(join(BACKEND, rel)).isDirectory()) return name === '__tests__' ? [] : walk(rel);
        return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [rel] : [];
      });
    const hits = walk('src').filter((f) => /['"]SIG(TERM|INT)['"]/.test(code(f)));
    expect(hits).toEqual(['src/lib/graceful-stop.ts']);
  });

  it('the sweep starts no run once stopping, and stops like a lost lease', () => {
    const sweep = code('src/services/spider/sweep.ts');
    const runFn = sweep.slice(sweep.indexOf('export async function runSpiderSweep'), sweep.indexOf('export function _spiderSweepInFlight'));
    expect(runFn).toMatch(/if \(stopRequested\(\)\)[\s\S]*return NOT_RUN/);
    expect(sweep).toMatch(/sweepAllCompanies\(now, \(\) => lease\.held\(\) && !stopRequested\(\)\)/);
  });
});
