import { describe, it, expect } from 'vitest';
import type { PaymentMethod } from '@prisma/client';
import {
  acceptedPaymentMethodsSchema,
  resolveAcceptedPaymentMethods,
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
  // CARD is derived from the Stripe connection (the account.updated webhook writes it), and
  // the Settings UI deliberately renders no toggle for it. It therefore must NEVER be taken
  // from a client payload: the page PATCHes the whole array from a snapshot it fetched
  // earlier, so a snapshot taken before charges went live would otherwise read as "disable
  // card" and 400 a save the user never asked for. Resolve instead of validate.
  it('keeps non-CARD methods in submitted order', () => {
    expect(resolveAcceptedPaymentMethods(['EXTERNAL_CARD', 'CHECK', 'ZELLE'], false))
      .toEqual(['EXTERNAL_CARD', 'CHECK', 'ZELLE']);
  });

  it('appends CARD when charges are enabled and the client omitted it', () => {
    expect(resolveAcceptedPaymentMethods(['EXTERNAL_CARD', 'CHECK'], true))
      .toEqual(['EXTERNAL_CARD', 'CHECK', 'CARD']);
  });

  it('keeps CARD exactly once when the client also sent it', () => {
    expect(resolveAcceptedPaymentMethods(['CARD', 'CHECK'], true)).toEqual(['CHECK', 'CARD']);
  });

  it('strips CARD when charges are not enabled', () => {
    expect(resolveAcceptedPaymentMethods(['CARD', 'CHECK'], false)).toEqual(['CHECK']);
  });

  it('adds CARD to an otherwise empty submission when charges are enabled', () => {
    expect(resolveAcceptedPaymentMethods([], true)).toEqual(['CARD']);
  });

  it('leaves an empty submission empty when charges are not enabled', () => {
    expect(resolveAcceptedPaymentMethods([], false)).toEqual([]);
  });

  it('never throws for any submitted/charges combination', () => {
    const combos: Array<[PaymentMethod[], boolean]> = [
      [['CARD'], true], [['CARD'], false], [[], true], [[], false],
      [['CHECK'], true], [['EXTERNAL_CARD', 'CARD'], false],
    ];
    for (const [submitted, charges] of combos) {
      expect(() => resolveAcceptedPaymentMethods(submitted, charges)).not.toThrow();
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
