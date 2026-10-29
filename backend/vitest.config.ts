import { defineConfig } from 'vitest/config';

// Vitest defaults to one worker per CPU core. That is right on a dev machine,
// but the five macOS runner entries are separate runner PROCESSES on a single
// Mac mini, so concurrent CI jobs each claim every core and oversubscribe the
// host many times over. Starved tests then blow the testTimeout below - a
// different set each run, which is what the mass timeout failures on PRs
// #1030/#1033/#1034 were. Set VITEST_MAX_WORKERS in CI to keep total demand
// near the host's core count; leave it unset locally so dev runs stay at full
// speed (the whole suite is ~40s on an unloaded 10-core machine).
const maxWorkers = process.env.VITEST_MAX_WORKERS;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    ...(maxWorkers ? { maxWorkers: Number(maxWorkers), minWorkers: 1 } : {}),
    // De-flake load-dependent failures. The suite is controller-integration
    // style (supertest + a fully-mocked prisma), so tests are CPU-bound with no
    // real I/O. When the CI runner is under contention, a normally-sub-second
    // test can blow past Vitest's 5s default and time out — and a DIFFERENT one
    // each run, since it depends purely on which test is executing at the load
    // peak. Worse, an abandoned (timed-out) request handler keeps running and
    // its prisma-mock calls land during later tests in the same file, surfacing
    // as spurious "prisma was touched" / wrong-`calls[0]` assertion failures.
    // A generous ceiling removes the abandonment (and thus both symptoms)
    // without masking genuine hangs. See the flake investigation in the PR.
    testTimeout: 20000,
    hookTimeout: 20000,
    include: [
      'src/__tests__/**/*.test.ts',
      'src/lib/**/__tests__/**/*.test.ts',
      'src/middleware/**/__tests__/**/*.test.ts',
      'src/services/**/__tests__/**/*.test.ts',
      'src/controllers/**/__tests__/**/*.test.ts',
      'scripts/**/__tests__/**/*.test.ts',
    ],
  },
});
