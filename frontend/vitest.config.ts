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
