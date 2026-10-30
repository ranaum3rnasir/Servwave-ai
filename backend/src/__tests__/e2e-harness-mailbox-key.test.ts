import { describe, it, expect } from 'vitest';
import { applyE2eHarnessMailboxKey, E2E_HARNESS_MAILBOX_HASH_KEY } from '../config/e2eHarnessMailboxKey';

/**
 * A door backend (E2E_TEST_DOORS=true) with no mailbox hash key configured supplies a harness-only one, so
 * its teardown of a provisioned company can purge; no other process is ever given a key.
 */
describe('applyE2eHarnessMailboxKey', () => {
  it('is long enough for the register to accept it', () => {
    expect(E2E_HARNESS_MAILBOX_HASH_KEY.length).toBeGreaterThanOrEqual(32);
  });

  it('supplies the key to a door backend with none configured', () => {
    const e: NodeJS.ProcessEnv = { E2E_TEST_DOORS: 'true', NODE_ENV: 'development' };
    expect(applyE2eHarnessMailboxKey(e)).toBe(true);
    expect(e.MAILBOX_ADDRESS_HASH_KEY).toBe(E2E_HARNESS_MAILBOX_HASH_KEY);
  });

  it('treats a blank key (an empty line copied from the example file) as none', () => {
    const e: NodeJS.ProcessEnv = { E2E_TEST_DOORS: 'true', MAILBOX_ADDRESS_HASH_KEY: '  ' };
    expect(applyE2eHarnessMailboxKey(e)).toBe(true);
    expect(e.MAILBOX_ADDRESS_HASH_KEY).toBe(E2E_HARNESS_MAILBOX_HASH_KEY);
  });

  it('never replaces a key the person configured', () => {
    const e: NodeJS.ProcessEnv = { E2E_TEST_DOORS: 'true', MAILBOX_ADDRESS_HASH_KEY: 'my-own-key-0123456789abcdef0123456789' };
    expect(applyE2eHarnessMailboxKey(e)).toBe(false);
    expect(e.MAILBOX_ADDRESS_HASH_KEY).toBe('my-own-key-0123456789abcdef0123456789');
  });

  it('never applies in production, even with the doors flag set', () => {
    const e: NodeJS.ProcessEnv = { E2E_TEST_DOORS: 'true', NODE_ENV: 'production' };
    expect(applyE2eHarnessMailboxKey(e)).toBe(false);
    expect(e.MAILBOX_ADDRESS_HASH_KEY).toBeUndefined();
  });

  it('never applies to a process that is not a door backend', () => {
    for (const flag of [undefined, '', 'false', '1']) {
      const e: NodeJS.ProcessEnv = { NODE_ENV: 'development', ...(flag === undefined ? {} : { E2E_TEST_DOORS: flag }) };
      expect(applyE2eHarnessMailboxKey(e)).toBe(false);
      expect(e.MAILBOX_ADDRESS_HASH_KEY).toBeUndefined();
    }
  });
});
