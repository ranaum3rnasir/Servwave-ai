/**
 * Setup file injected ONLY by `npm run test:ci` (see test-ci-config.mjs): times every attempt of every
 * test in the worker and appends { id, attempt, ms, status } to `<TEST_CI_EVENT_FILE>.attempts`, which
 * the reporter merges into the retried tests' event lines. The tool's own diagnostics span all attempts
 * together, so this is the only way to get each attempt's duration through public hooks.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, onTestFailed } from 'vitest';

const out = process.env.TEST_CI_EVENT_FILE ? `${process.env.TEST_CI_EVENT_FILE}.attempts` : null;
const live = new WeakMap();

beforeEach((ctx) => {
  const rec = { start: performance.now(), failed: false };
  live.set(ctx.task, rec);
  onTestFailed(() => { rec.failed = true; });
});

afterEach((ctx) => {
  const rec = live.get(ctx.task);
  if (!out || !rec) return;
  const failed = rec.failed || ctx.task.result?.state === 'fail';
  const line = { id: ctx.task.id, attempt: (ctx.task.result?.retryCount ?? 0) + 1, ms: performance.now() - rec.start, status: failed ? 'failed' : 'passed' };
  appendFileSync(out, `${JSON.stringify(line)}\n`);
});

// CPU of the worker process up to the end of this file (user + system, microseconds), for the budget of a full run
// (#3254). The whole process counts, startup and environment setup included; `process.__testCiCpuLast` keeps a
// worker that runs several files from being counted twice (each file adds what the process used since the last one).
const cpuOut = process.env.TEST_CI_EVENT_FILE ? `${process.env.TEST_CI_EVENT_FILE}.cpu` : null;
afterAll(() => {
  if (!cpuOut) return;
  const now = process.cpuUsage();
  const total = now.user + now.system;
  const was = process.__testCiCpuLast ?? 0;
  process.__testCiCpuLast = total;
  appendFileSync(cpuOut, `${JSON.stringify({ us: total - was })}\n`);
});
