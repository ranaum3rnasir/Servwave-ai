/*
 * The Database command's vitest reporter: one JSON line per finished test and per finished file, appended to the events file as
 * they happen, so a run that is killed or stalls still leaves everything that finished (the built-in JSON reporter writes only at
 * the end). The command reads these lines, not the log. See results.ts for the shape.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

const events = (): string | undefined => process.env.DB_CHECK_EVENTS_FILE;
const phase = (): string => process.env.DB_CHECK_PHASE ?? 'unknown';
const relative = (absolute: string): string => path.relative(process.cwd(), absolute).split(path.sep).join('/');

function write(event: Record<string, unknown>): void {
  const file = events();
  if (file) appendFileSync(file, `${JSON.stringify({ ...event, t: Date.now() })}\n`);
}

export default class DbCheckReporter implements Reporter {
  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    const diagnostic = testCase.diagnostic();
    const todo = (testCase.options as { todo?: boolean }).todo === true;
    const state = todo ? 'todo' : result.state === 'pending' ? 'pending' : result.state;
    write({
      ev: 'test',
      phase: phase(),
      file: relative(testCase.module.moduleId),
      name: testCase.fullName,
      state,
      retries: diagnostic?.retryCount ?? 0,
      ms: Math.round(diagnostic?.duration ?? 0),
      error: result.state === 'failed' ? result.errors?.[0]?.message : undefined,
    });
  }

  onTestModuleEnd(testModule: TestModule): void {
    write({
      ev: 'module',
      phase: phase(),
      file: relative(testModule.moduleId),
      state: testModule.state(),
      ms: Math.round(testModule.diagnostic().duration ?? 0),
      errors: testModule.errors().map((e) => e.stack || e.message),
    });
  }
}
