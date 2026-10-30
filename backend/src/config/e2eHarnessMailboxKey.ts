/**
 * The mailbox address hash key an end-to-end door backend falls back to (PRD 10).
 *
 * A company purge refuses to run without MAILBOX_ADDRESS_HASH_KEY, and every company the test doors
 * provision has a main mailbox, so the doors' own teardown would fail on any backend started without
 * the key. A backend started as a door backend (E2E_TEST_DOORS=true: the Playwright webServers,
 * src/scripts/e2e-api-server.ts, a hand-started `npm run dev:backend`) therefore supplies this key
 * when the person has not set one.
 *
 * It is not a secret: it only ever hashes the addresses of throwaway test companies, and those hashes
 * are not expected to match under an environment's real key. It never applies in production, and a
 * key the person has set always wins.
 */
export const E2E_HARNESS_MAILBOX_HASH_KEY = 'e2e-harness-mailbox-hash-key-throwaway-test-companies-only';

/** Puts the harness key into `processEnv` when this is a door backend with no key configured; true when it did. */
export function applyE2eHarnessMailboxKey(processEnv: NodeJS.ProcessEnv): boolean {
  if (processEnv.E2E_TEST_DOORS?.trim() !== 'true') return false;
  if (processEnv.NODE_ENV === 'production') return false;
  if (processEnv.MAILBOX_ADDRESS_HASH_KEY?.trim()) return false;
  processEnv.MAILBOX_ADDRESS_HASH_KEY = E2E_HARNESS_MAILBOX_HASH_KEY;
  return true;
}
