/**
 * Our own reporter for `npm run test:ci` (#3253): appends one JSON line per event to the file named
 * by TEST_CI_EVENT_FILE, synchronously, as the event happens. The test tool's own report is written
 * only at the end and has no retry count, no real file timings and no "zero tests" status.
 *
 * Uses the tool's public reporter API (vitest 4: onTestModule*, onTestCaseResult, onTestRunEnd).
 * The tool's own `diagnostic().duration` spans ALL attempts of a retried test, so per-attempt times
 * come from test-ci-attempts-setup.mjs (a setup file only this command injects), which times each
 * attempt in the worker and appends to `<event file>.attempts`; this reporter merges them by test id.
 * The tool reports unhandled errors only when the run ends, so those lines appear then.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

export default class TestCiReporter {
  constructor() {
    this.file = process.env.TEST_CI_EVENT_FILE;
    this.root = process.cwd();
    this.reported = new Set();
    // If the command is killed so hard it cannot clean up (SIGKILL), the tool would be left running on a
    // persistent runner: it watches its parent and takes its own process group down with it.
    const parent = Number(process.env.TEST_CI_PARENT_PID);
    if (parent) {
      setInterval(() => {
        try { process.kill(parent, 0); } catch { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }
      }, 2000).unref();
    }
    if (!this.file) throw new Error('TEST_CI_EVENT_FILE is not set: run this through `npm run test:ci`');
  }

  onInit(vitest) {
    this.root = vitest.config.root;
  }

  write(obj) {
    appendFileSync(this.file, `${JSON.stringify({ ...obj, t: Date.now() })}\n`);
  }

  rel(moduleId) {
    return relative(this.root, moduleId).split('\\').join('/');
  }

  onTestModuleStart(m) {
    this.write({ ev: 'file-start', file: this.rel(m.moduleId) });
  }

  onTestModuleCollected(m) {
    let tests = 0;
    for (const _ of m.children.allTests()) tests += 1;
    this.write({ ev: 'file-collected', file: this.rel(m.moduleId), tests });
  }

  /** Real per-attempt times, written by test-ci-attempts-setup.mjs inside the workers (keyed by test id). */
  attemptsOf(id) {
    const path = `${this.file}.attempts`;
    if (!existsSync(path)) return undefined;
    const rows = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      try {
        const o = JSON.parse(line);
        if (o.id === id) rows.push({ attempt: o.attempt, ms: o.ms, status: o.status });
      } catch { /* a partial line is not ours to judge */ }
    }
    rows.sort((a, b) => a.attempt - b.attempt);
    return rows.length ? rows : undefined;
  }

  testEvent(t, result) {
    const diag = t.diagnostic();
    const mode = t.options?.mode;
    const status = mode === 'todo' ? 'todo' : result.state;
    this.write({
      ev: 'test',
      file: this.rel(t.module.moduleId),
      name: t.fullName,
      status,
      duration: diag?.duration ?? 0,
      retries: diag?.retryCount ?? 0,
      attempts: (diag?.retryCount ?? 0) > 0 ? this.attemptsOf(t.id) : undefined,
      errors: (result.errors ?? []).map((e) => String(e.message ?? e)),
    });
  }

  onTestCaseResult(t) {
    this.reported.add(t.id);
    this.testEvent(t, t.result());
  }

  onTestModuleEnd(m) {
    // Failures at collection never reach onTestCaseResult: `.only` under --allowOnly=false marks the
    // test failed, a throwing beforeAll fails its suite and skips the tests under it. Walk the module so
    // every test the tool knows about, and every failed suite's errors, reach the event file.
    const suiteErrors = [];
    const walk = (children) => {
      for (const c of children) {
        if (c.type === 'suite') {
          if (c.state() === 'failed') suiteErrors.push(...c.errors().map((e) => String(e.message ?? e)));
          walk(c.children);
        } else if (!this.reported.has(c.id)) {
          this.reported.add(c.id);
          this.testEvent(c, c.result());
        }
      }
    };
    walk(m.children);
    this.write({
      ev: 'file-end',
      file: this.rel(m.moduleId),
      state: m.state(),
      errors: m.errors().map((e) => String(e.message ?? e)),
      suiteErrors,
    });
  }

  /** CPU-seconds of the run: every file's share in its worker (test-ci-attempts-setup.mjs) plus this process (#3254). */
  cpuSeconds() {
    let us = 0;
    const path = `${this.file}.cpu`;
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        try { us += JSON.parse(line).us || 0; } catch { /* a partial line is not ours to sum */ }
      }
    }
    const main = process.cpuUsage();
    return (us + main.user + main.system) / 1e6;
  }

  onTestRunEnd(_modules, unhandledErrors, reason) {
    this.write({ ev: 'cpu', seconds: this.cpuSeconds() });
    for (const e of unhandledErrors) this.write({ ev: 'unhandled', message: String(e.message ?? e) });
    this.write({ ev: 'run-end', reason });
  }
}
