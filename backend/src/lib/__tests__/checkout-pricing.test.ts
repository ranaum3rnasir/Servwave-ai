/**
 * Payments go-live slice 02 - the checkout pricing module (PRD Module 2, D9/D4/D15).
 *
 * One pure function turns (amount due, payable now, requested amount, tip, method) into the
 * checkout's line items and ServWave's platform fee. At launch there is no card fee, no bank
 * surcharge and no platform fee, for every method. Expected figures are worked by hand from the
 * slice, never recomputed the way the module computes them.
 */
import { describe, it, expect } from 'vitest';
import { payableNowCents, priceCheckout, type CheckoutMethod } from '../checkout-pricing';

const DESCRIPTION = 'Payment for Invoice I00042';

describe('priceCheckout - full amount', () => {
  it('charges a $100.00 invoice exactly $100.00 on one line, with no fee line and no platform fee', () => {
    const priced = priceCheckout({ invoiceTotalCents: 10000, amountDueCents: 10000, method: 'card', description: DESCRIPTION });

    expect(priced).toEqual({
      ok: true,
      lineItems: [{ name: DESCRIPTION, amountCents: 10000 }],
      amountCents: 10000,
      tipCents: 0,
      totalCents: 10000,
      payableNowCents: 10000,
      platformFeeCents: 0,
    });
  });
});

describe('payable now (slice 12): the amount due less the payments still processing', () => {
  it('is $60.00 on $100.00 due with a $40.00 bank payment processing', () => {
    expect(payableNowCents(10000, 4000)).toBe(6000);
  });

  it('is the whole amount due when nothing is processing', () => {
    expect(payableNowCents(10000, 0)).toBe(10000);
  });

  it('is never below zero, even if more is processing than is due', () => {
    expect(payableNowCents(10000, 12000)).toBe(0);
  });

  it('a checkout with no requested amount charges payable-now, and says what it was built against', () => {
    const priced = priceCheckout({ invoiceTotalCents: 10000, amountDueCents: 10000, payableNowCents: 6000, method: 'bank', description: DESCRIPTION });

    expect(priced).toMatchObject({ ok: true, amountCents: 6000, totalCents: 6000, payableNowCents: 6000 });
  });

  it('refuses a checkout when nothing is payable now', () => {
    const priced = priceCheckout({ invoiceTotalCents: 10000, amountDueCents: 10000, payableNowCents: 0, method: 'card', description: DESCRIPTION });

    expect(priced).toEqual({ ok: false, error: 'NOTHING_PAYABLE_NOW' });
  });
});

describe('priceCheckout - partial amount', () => {
  // A $250.00 invoice with $180.00 payable now (slice 12 will subtract PROCESSING payments; the
  // caller supplies the figure).
  const base = { invoiceTotalCents: 25000, amountDueCents: 25000, payableNowCents: 18000, method: 'card' as const, description: DESCRIPTION };

  it('accepts the $1.00 minimum and charges exactly that', () => {
    const priced = priceCheckout({ ...base, requestedCents: 100 });

    expect(priced).toMatchObject({
      ok: true,
      lineItems: [{ name: DESCRIPTION, amountCents: 100 }],
      amountCents: 100,
      totalCents: 100,
      platformFeeCents: 0,
    });
  });

  it('accepts exactly the payable-now amount', () => {
    const priced = priceCheckout({ ...base, requestedCents: 18000 });

    expect(priced).toMatchObject({ ok: true, amountCents: 18000, totalCents: 18000 });
  });

  it('refuses $0.99, one cent under the $1.00 minimum', () => {
    expect(priceCheckout({ ...base, requestedCents: 99 })).toEqual({ ok: false, error: 'AMOUNT_BELOW_MINIMUM' });
  });

  it('refuses one cent over the payable-now amount, even though it is under the amount due', () => {
    expect(priceCheckout({ ...base, requestedCents: 18001 })).toEqual({ ok: false, error: 'AMOUNT_ABOVE_PAYABLE_NOW' });
  });

  it('charges payable-now, not the amount due, when no partial amount is requested', () => {
    expect(priceCheckout(base)).toMatchObject({ ok: true, amountCents: 18000, totalCents: 18000 });
  });
});

describe('priceCheckout - tip', () => {
  const base = { invoiceTotalCents: 10000, amountDueCents: 10000, method: 'card' as const, description: DESCRIPTION };

  it('adds no Tip line for a tip of 0', () => {
    expect(priceCheckout({ ...base, tipCents: 0 })).toMatchObject({
      ok: true,
      lineItems: [{ name: DESCRIPTION, amountCents: 10000 }],
      tipCents: 0,
      totalCents: 10000,
    });
  });

  it('adds a separate "Tip" line and charges amount + tip', () => {
    expect(priceCheckout({ ...base, tipCents: 1500 })).toMatchObject({
      ok: true,
      lineItems: [
        { name: DESCRIPTION, amountCents: 10000 },
        { name: 'Tip', amountCents: 1500 },
      ],
      amountCents: 10000,
      tipCents: 1500,
      totalCents: 11500,
      platformFeeCents: 0,
    });
  });

  it('accepts a tip exactly at the cap, the invoice amount', () => {
    expect(priceCheckout({ ...base, tipCents: 10000 })).toMatchObject({ ok: true, tipCents: 10000, totalCents: 20000 });
  });

  it('refuses a tip one cent over the invoice amount', () => {
    expect(priceCheckout({ ...base, tipCents: 10001 })).toEqual({ ok: false, error: 'TIP_ABOVE_CAP' });
  });

  it('refuses a negative tip', () => {
    expect(priceCheckout({ ...base, tipCents: -1 })).toEqual({ ok: false, error: 'TIP_NEGATIVE' });
  });

  it('caps the tip at the invoice amount, not at the smaller partial amount being paid', () => {
    expect(priceCheckout({ ...base, requestedCents: 4000, tipCents: 6000 })).toMatchObject({
      ok: true,
      amountCents: 4000,
      tipCents: 6000,
      totalCents: 10000,
    });
  });
});

describe('priceCheckout - tip cap on a partly paid invoice', () => {
  // A $1,000.00 invoice with $900.00 already paid: $100.00 is due, but the tip cap is the
  // invoice amount ($1,000.00), not what is still due.
  const base = { invoiceTotalCents: 100000, amountDueCents: 10000, method: 'card' as const, description: DESCRIPTION };

  it('accepts a $150.00 tip that exceeds the $100.00 due but not the $1,000.00 invoice', () => {
    expect(priceCheckout({ ...base, tipCents: 15000 })).toMatchObject({
      ok: true,
      amountCents: 10000,
      tipCents: 15000,
      totalCents: 25000,
    });
  });

  it('accepts a tip of exactly the $1,000.00 invoice amount', () => {
    expect(priceCheckout({ ...base, tipCents: 100000 })).toMatchObject({ ok: true, tipCents: 100000 });
  });

  it('refuses a tip one cent over the $1,000.00 invoice amount', () => {
    expect(priceCheckout({ ...base, tipCents: 100001 })).toEqual({ ok: false, error: 'TIP_ABOVE_CAP' });
  });
});

describe('priceCheckout - no fees for any method (D9, D4)', () => {
  const METHODS: CheckoutMethod[] = ['card', 'bank'];

  it.each(METHODS)('%s: only the amount and the tip are charged, and ServWave takes no platform fee', (method) => {
    const priced = priceCheckout({ invoiceTotalCents: 10000, amountDueCents: 10000, tipCents: 1000, method, description: DESCRIPTION });

    expect(priced).toEqual({
      ok: true,
      lineItems: [
        { name: DESCRIPTION, amountCents: 10000 },
        { name: 'Tip', amountCents: 1000 },
      ],
      amountCents: 10000,
      tipCents: 1000,
      totalCents: 11000,
      payableNowCents: 10000,
      platformFeeCents: 0,
    });
  });
});
