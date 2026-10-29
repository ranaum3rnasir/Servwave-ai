/**
 * A small Playwright reporter for the full sweep (mobile slice 62): one row per test, no
 * attachments. The built-in JSON reporter inlines every attachment as base64, and the gate attaches
 * a measurement record to each of its tests, so a sweep of about 2,900 tests would try to build one
 * string of hundreds of megabytes, which crashes the reporter after the last test and loses the
 * run's summary and exit code. This writes the same shape the report builder reads
 * (`suites[].specs[].tests[]`, see scripts/mobile-sweep-lib.mjs `flattenPlaywright`), a few hundred
 * kilobytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase } from '@playwright/test/reporter';

interface Options { outputFile: string }

export default class SweepReporter implements Reporter {
  private root: Suite | undefined;

  constructor(private readonly opts: Options) {}

  onBegin(_config: FullConfig, suite: Suite) {
    this.root = suite;
  }

  onEnd(_result: FullResult) {
    const specs = (this.root?.allTests() ?? []).map((t: TestCase) => {
      const last = t.results[t.results.length - 1];
      const message = (last?.error ?? t.results.find((r) => r.error)?.error)?.message;
      return {
        file: path.basename(t.location.file),
        title: t.title,
        tests: [
          {
            projectName: t.parent.project()?.name ?? '',
            status: t.outcome(),
            annotations: t.annotations.map((a) => ({ type: a.type })),
            results: t.results.map((r, i) => ({ status: r.status, ...(i === t.results.length - 1 && message ? { error: { message: message.slice(0, 2000) } } : {}) })),
          },
        ],
      };
    });
    fs.mkdirSync(path.dirname(this.opts.outputFile), { recursive: true });
    fs.writeFileSync(this.opts.outputFile, JSON.stringify({ suites: [{ file: '', specs }] }));
  }

  printsToStdio() {
    return false;
  }
}
