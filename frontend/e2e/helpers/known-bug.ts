import { TestInfo } from '@playwright/test';

/**
 * Surface a known, deliberately-unfixed bug (spec §6) in the report + matrix without
 * failing the suite. The row asserts CURRENT behavior; this records the CORRECT behavior.
 * A known-bug row is green-with-a-flag — never a silent pass and never a hard red.
 */
export function flagKnownBug(testInfo: TestInfo, b: { id: string; spec: string; current: string; expected: string }) {
  const msg = `KNOWN-BUG ${b.id} (${b.spec}) — current: ${b.current} | expected: ${b.expected}`;
  testInfo.annotations.push({ type: 'known-bug', description: msg });
  // eslint-disable-next-line no-console
  console.warn(`⚠️  ${msg}`);
}
