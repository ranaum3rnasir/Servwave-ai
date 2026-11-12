/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';

// See backend/vitest.config.ts for the full rationale: several self-hosted
// runner processes share one Mac mini, so an uncapped worker-per-core default
// oversubscribes the host and starves tests into the timeout below. Capped in
// CI via VITEST_MAX_WORKERS, unset locally.
const maxWorkers = process.env.VITEST_MAX_WORKERS;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Pre-bundle the date packages for the tests. `date-fns-tz` and `react-day-picker` import the whole
    // `date-fns` entry file to use a few functions, and so do about 50 of our own modules. The app build
    // drops the unused functions; a test file instead loaded all ~300 function files from disk, once per
    // file, because every test file starts with nothing loaded. That was about half of all the time the
    // suite spent loading modules (measured: 694 of 1,451 s on a full run; on a 1-in-5 sample this list
    // cut module loading from 314 s to 174 s with every test passing). The bundle is built once per run in
    // node_modules/.vite. Add a package here only with a before/after measurement: a package that is
    // already one file gains nothing. Pinned by src/__tests__/vitest-config.test.ts.
    deps: {
      optimizer: {
        client: { enabled: true, include: ['date-fns', 'date-fns/locale', 'date-fns-tz', 'react-day-picker'] },
      },
    },
    ...(maxWorkers ? { maxWorkers: Number(maxWorkers), minWorkers: 1 } : {}),
    // Default 5s is too tight when several CI jobs share one self-hosted Mac
    // mini and starve each other's CPU — userEvent-driven tests that run in
    // ~150ms locally intermittently blow the timeout. Give them headroom
    // (paired with --retry=2 in CI). Real hangs still fail, just later.
    // 30s, raised from 15s: a lazy() report route transforms its whole module
    // graph on first import, and DatePicker pulls react-day-picker into those
    // chunks. Alone that suite runs in ~11s; under full-suite worker
    // contention it exceeded the old ceiling. A bundler cost, not an app one.
    testTimeout: 30000,
    // Hooks get the same 30s as tests, for the same recorded reason: a loaded machine, not slow
    // code, is what crosses the limit (the 5s default failed beforeAll/afterEach hooks that a
    // test of the same file passed). Pinned equal by src/__tests__/vitest-config.test.ts.
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
      ],
    },
  },
});
