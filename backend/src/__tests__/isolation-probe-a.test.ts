import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Behavioural pin for file isolation (see test-setup-guards.test.ts): this file and its twin each load the same plain
// Node module and each must be the first to load it in its worker. With isolation off and both files run in one worker
// (a run with --no-file-parallelism, or two files landing on one worker), the second sees 2.
describe('file isolation, observed', () => {
  it('this test file has its own worker state (it is the only user of the shared probe module)', () => {
    const probe = createRequire(__filename)('./support/isolation-probe-counter.cjs') as { users: number };
    probe.users += 1;
    expect(probe.users).toBe(1);
  });
});
