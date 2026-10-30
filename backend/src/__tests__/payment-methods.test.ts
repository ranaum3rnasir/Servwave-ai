import { describe, it, expect } from 'vitest';
import type { PaymentMethod } from '@prisma/client';
import {
  acceptedPaymentMethodsSchema,
  resolveAcceptedPaymentMethods,
  syncedAcceptedMethods,
  publicCardRoute,
} from '../lib/payment-methods';

describe('acceptedPaymentMethodsSchema (Zod layer)', () => {
  it('parses an empty array', () => {
    const result = acceptedPaymentMethodsSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it('parses a valid subset', () => {
    const result = acceptedPaymentMethodsSchema.safeParse([
      'CARD', 'CHECK', 'BANK_TRANSFER',
    ]);
    expect(result.success).toBe(true);
  });

  it('accepts EXTERNAL_CARD', () => {
    const result = acceptedPaymentMethodsSchema.safeParse(['EXTERNAL_CARD', 'CHECK']);
    expect(result.success).toBe(true);
  });

  it('rejects unknown values', () => {
    const result = acceptedPaymentMethodsSchema.safeParse(['CARD', 'WIRE']);
    expect(result.success).toBe(false);
  });

  it('rejects duplicate entries', () => {
    const result = acceptedPaymentMethodsSchema.safeParse(['CARD', 'CARD']);
    expect(result.success).toBe(false);
  });

  it('rejects a non-array input', () => {
    const result = acceptedPaymentMethodsSchema.safeParse('CARD' as any);
    expect(result.success).toBe(false);
  });
});

describe('resolveAcceptedPaymentMethods (CARD is server-owned)', () => {
  // CARD means "the account can take cards". Only the account-status sync learns that from the
  // processor and records it in the stored list, and the Settings UI renders no toggle for it. So
  // it must NEVER be taken from a client payload: the page PATCHes the whole array from a snapshot
  // it fetched earlier, and a stale snapshot would otherwise read as "disable card" (or "enable
  // card"). A save keeps the stored CARD while charges are enabled, under the sync's own rule.
  it('keeps non-CARD methods in submitted order', () => {
    expect(resolveAcceptedPaymentMethods(['EXTERNAL_CARD', 'CHECK', 'ZELLE'], false, []))
      .toEqual(['EXTERNAL_CARD', 'CHECK', 'ZELLE']);
  });

  it('re-adds a stored CARD when the client omitted it (charges enabled)', () => {
    expect(resolveAcceptedPaymentMethods(['EXTERNAL_CARD', 'CHECK'], true, ['CHECK', 'CARD']))
      .toEqual(['EXTERNAL_CARD', 'CHECK', 'CARD']);
  });

  it('keeps CARD exactly once when the client also sent it', () => {
    expect(resolveAcceptedPaymentMethods(['CARD', 'CHECK'], true, ['CARD'])).toEqual(['CHECK', 'CARD']);
  });

  it('does not add a CARD the sync has not written, even with charges enabled', () => {
    expect(resolveAcceptedPaymentMethods(['CARD', 'CHECK'], true, [])).toEqual(['CHECK']);
    expect(resolveAcceptedPaymentMethods([], true, [])).toEqual([]);
  });

  it('strips a client-sent CARD when charges are not enabled and CARD is not stored', () => {
    expect(resolveAcceptedPaymentMethods(['CARD', 'CHECK'], false, [])).toEqual(['CHECK']);
  });

  // The sync drops CARD whenever charges are off; a save under the same rule does too. (The old
  // reason to keep it, the webhook's accepted-methods gate, is gone: slice 16 pins that refunds and
  // disputes are recorded without CARD.)
  it('drops a stored CARD while charges are not enabled, as the sync does', () => {
    expect(resolveAcceptedPaymentMethods(['CHECK', 'VENMO'], false, ['CARD', 'CHECK'])).toEqual(['CHECK', 'VENMO']);
  });

  it('leaves an empty submission empty when charges are not enabled', () => {
    expect(resolveAcceptedPaymentMethods([], false, [])).toEqual([]);
  });

  it('never throws for any submitted/charges combination', () => {
    const combos: Array<[PaymentMethod[], boolean]> = [
      [['CARD'], true], [['CARD'], false], [[], true], [[], false],
      [['CHECK'], true], [['EXTERNAL_CARD', 'CARD'], false],
    ];
    for (const [submitted, charges] of combos) {
      expect(() => resolveAcceptedPaymentMethods(submitted, charges, [])).not.toThrow();
    }
  });
});

describe('resolveAcceptedPaymentMethods (ACH is server-owned in both directions)', () => {
  // Payments go-live slice 19, conductor decision 2026-10-06: ACH in the list means "the account
  // can take bank payments". Only the account-status sync writes it; the owner's default offer
  // is bank_offered_by_default. So a payload neither adds nor removes it.
  it('keeps ACH when the client left it out and it is listed today', () => {
    expect(resolveAcceptedPaymentMethods(['CHECK'], true, ['ACH'])).toEqual(['CHECK', 'ACH']);
  });

  it('does not add ACH a client sent while it is not listed today', () => {
    expect(resolveAcceptedPaymentMethods(['ACH', 'CHECK'], true, [])).toEqual(['CHECK']);
  });

  it('keeps ACH exactly once, after CARD, when the client also sent it', () => {
    expect(resolveAcceptedPaymentMethods(['ACH', 'CHECK', 'CARD'], true, ['ACH', 'CARD'])).toEqual(['CHECK', 'CARD', 'ACH']);
  });
});

// Payments go-live slice 16 (from the slice 10 review): a settings save used to put CARD back after
// the account sync had removed it, because the save added CARD whenever charges were enabled while
// the sync keeps it only while charges are enabled AND the card capability is active. Both now ask
// one rule, and only the sync learns the capability, so a save keeps exactly what the sync wrote.
describe('a settings save after an account sync (one rule for CARD and ACH)', () => {
  it('does not put CARD back when the sync removed it while charges stayed on', () => {
    // The card capability lapsed: the sync wrote CHECK alone, charges still enabled.
    expect(resolveAcceptedPaymentMethods(['CHECK', 'VENMO'], true, ['CHECK'])).toEqual(['CHECK', 'VENMO']);
  });

  it('keeps exactly the CARD and ACH the sync wrote, for every account state', () => {
    for (const chargesEnabled of [true, false]) {
      for (const cardCapabilityActive of [true, false]) {
        for (const achCapabilityActive of [true, false]) {
          const before: PaymentMethod[] = ['CHECK', 'CARD', 'ACH'];
          const written = syncedAcceptedMethods(before, { chargesEnabled, cardCapabilityActive, achCapabilityActive }) ?? before;
          const saved = resolveAcceptedPaymentMethods(['CHECK', 'CASH'], chargesEnabled, written);
          const facts = (list: PaymentMethod[]) => list.filter((m) => m === 'CARD' || m === 'ACH');
          expect(facts(saved)).toEqual(facts(written));
        }
      }
    }
  });
});

describe('publicCardRoute (customer-page button routing)', () => {
  it('routes to STRIPE when CARD is in the list', () => {
    expect(publicCardRoute(['CARD', 'CHECK'])).toBe('STRIPE');
  });

  it('routes to STRIPE when both CARD and EXTERNAL_CARD are present (Stripe wins)', () => {
    expect(publicCardRoute(['CARD', 'EXTERNAL_CARD', 'CHECK'])).toBe('STRIPE');
  });

  it('routes to CALL_US when only EXTERNAL_CARD is present', () => {
    expect(publicCardRoute(['EXTERNAL_CARD', 'CHECK'])).toBe('CALL_US');
  });

  it('returns NONE when neither card flavor is present', () => {
    expect(publicCardRoute(['CHECK', 'BANK_TRANSFER'])).toBe('NONE');
  });

  it('returns NONE for an empty list', () => {
    expect(publicCardRoute([])).toBe('NONE');
  });
});
