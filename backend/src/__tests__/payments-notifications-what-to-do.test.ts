/**
 * Payments go-live slice 32: the account action-needed notice says what to do in ServWave's words
 * (conductor note 2026-10-08: a keyed-identity failure did need the owner, and the copy must say
 * what to do). The processor's own requirement codes never reach the owner.
 */
import { describe, it, expect } from 'vitest';
import { whatToDoAbout } from '../lib/payments-notifications';

describe('whatToDoAbout', () => {
  it('an identity requirement (a keyed-identity failure, a missing ID document) asks the owner to confirm identity details', () => {
    for (const reqs of [['individual.verification.document'], ['individual.id_number'], ['verification_failed_keyed_identity']]) {
      expect(whatToDoAbout(reqs)).toBe('Open Settings > Payments and confirm the identity details ServWave Payments asks for, such as the owner\'s ID document.');
    }
  });

  it('a bank account requirement asks the owner to check the bank details; both ask for both', () => {
    expect(whatToDoAbout(['external_account'])).toBe('Open Settings > Payments and check your bank account details.');
    expect(whatToDoAbout(['external_account', 'individual.verification.document']))
      .toBe('Open Settings > Payments and confirm the identity details ServWave Payments asks for, such as the owner\'s ID document, then check your bank account details.');
  });

  it('anything else still says where to go, and never prints a requirement code', () => {
    const text = whatToDoAbout(['business_profile.url', 'tos_acceptance.date']);
    expect(text).toBe('Open Settings > Payments and finish the missing details.');
    expect(text).not.toMatch(/business_profile|tos_acceptance/);
  });
});
