import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import { AUTHORIZATION_SUITE_FILES } from './src/__tests__/authorization-suite';

/**
 * The authorization suite (P20): the proving tests of who may do what, run as a release gate by `npm run test:authorization`.
 * The same setup as the whole suite; only the files differ: the ones src/__tests__/authorization-suite.ts names, plus every
 * `permission-*` test, so a new permission test is in the gate the day it lands.
 */
// Not mergeConfig: it joins the two `include` lists, and this gate must run only its own files.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/__tests__/permission-*.test.ts',
      ...AUTHORIZATION_SUITE_FILES.map((f) => `src/__tests__/${f}`),
    ],
  },
});
