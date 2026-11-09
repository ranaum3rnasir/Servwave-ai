// A tiny suite for the end-to-end run of `npm run test:ci` (src/__tests__/test-ci-e2e.test.ts).
// Not the real suite: its own include, its own root. ghost.test.ts is on disk and excluded here,
// so a run that expects it never sees it report.
export default {
  test: {
    root: new URL('.', import.meta.url).pathname,
    include: ['*.test.ts'],
    exclude: ['ghost.test.ts', 'node_modules'],
    environment: 'node',
    testTimeout: 600000,
  },
};
