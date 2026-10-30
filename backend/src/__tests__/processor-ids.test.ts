import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { withoutProcessorIdKeys } from '../lib/processor-ids';

// Made-up 24-character mixed-case bodies, never real ids.
const B = '1Q9xYzAbCdEfGhIjKlMnOpQr';
const scrub = { scrubValues: true };

describe('withoutProcessorIdKeys with scrubValues: values shaped like a processor id', () => {
  it('drops metadata.event_id = evt_... (plain key name, id-shaped value)', () => {
    expect(withoutProcessorIdKeys({ payment_id: 'pay-1', event_id: `evt_${B}` }, scrub)).toEqual({ payment_id: 'pay-1' });
  });

  it('drops a colon-joined composite id (the reconciler writes evt_<id>:du_<id>)', () => {
    const out = withoutProcessorIdKeys({
      payment_id: 'pay-1',
      event_id: `evt_${B}:du_${B}`,
      list: [`evt_${B}:du_${B}`],
      note: 'ratio 10:30',
      mixed: `evt_${B}:not-an-id`,
    }, scrub);
    expect(out).toEqual({ payment_id: 'pay-1', list: [], note: 'ratio 10:30', mixed: `evt_${B}:not-an-id` });
  });

  it('drops nested id-shaped values under arbitrary keys and bare strings in arrays', () => {
    const out = withoutProcessorIdKeys({
      a: { whatever: `re_${B}`, keep: 'ok' },
      list: [`pi_${B}`, 'fine', { x: 'cs_test_a1B2c3D4e5F6g7' }],
    }, scrub);
    expect(out).toEqual({ a: { keep: 'ok' }, list: ['fine', {}] });
  });

  it.each([
    'evt', 'pi', 'cs', 'ch', 'py', 'dp', 'du', 'pm', 'src', 'card', 'ba', 'acct', 'cus', 'txn',
    'po', 'tr', 'trr', 'fee', 'fr', 'seti', 'in', 'sub', 'file', 'link', 'mandate', 'pmc', 're',
  ])('drops a %s_ id', (prefix) => {
    expect(withoutProcessorIdKeys({ any_key: `${prefix}_${B}` }, scrub)).toEqual({});
  });

  it('allows the secret-suffix style', () => {
    expect(withoutProcessorIdKeys({ k: `pi_${B}_secret_Zx81Qq9Lm2` }, scrub)).toEqual({});
  });

  it('keeps ordinary values, including typed PO, check and reference numbers', () => {
    const d = new Date('2026-10-11T00:00:00Z');
    const input = {
      uuid: 'f8afb5f7-7927-4ee0-a9fc-7a8f1cbfa344', inv: 'INV-0001', a: 'pending', b: 'in_person', c: 'cs_go',
      d: 'in_progress', e: 're_scheduled1', po: 'po_45000123', chk: 'ch_10023456', ref: 'tr_20261011',
      note: `Customer mentioned evt_${B} in passing`, n: 42, nul: null, date: d, bool: true, short: 'pi_12',
    };
    expect(withoutProcessorIdKeys(input, scrub)).toEqual(input);
  });
});

describe('withoutProcessorIdKeys by default: keys only', () => {
  it('keeps id-shaped values (user data) but removes id keys', () => {
    const out = withoutProcessorIdKeys({ po_number: 'po_45000123', other: `re_${B}`, stripe_refund_id: 're_x' });
    expect(out).toEqual({ po_number: 'po_45000123', other: `re_${B}` });
  });

  it('an invoice detail document keeps typed PO and payment references and loses id keys', () => {
    const doc = {
      po_number: 'po_45000123',
      payments: [{ id: 'p1', reference: 'ch_10023456', stripe_payment_intent_id: `pi_${B}` }],
      refunds: [{ id: 'r1', stripe_refund_id: `re_${B}` }],
    };
    expect(withoutProcessorIdKeys(doc)).toEqual({
      po_number: 'po_45000123',
      payments: [{ id: 'p1', reference: 'ch_10023456' }],
      refunds: [{ id: 'r1' }],
    });
  });

  it('leaves Decimals untouched and still applies the key rule', () => {
    const dec = new Prisma.Decimal('10.50');
    const out = withoutProcessorIdKeys({ amount: dec, stripe_refund_id: null, payment_intent: 'x' }) as Record<string, unknown>;
    expect(out.amount).toBe(dec);
    expect('stripe_refund_id' in out).toBe(false);
    expect('payment_intent' in out).toBe(false);
  });
});
