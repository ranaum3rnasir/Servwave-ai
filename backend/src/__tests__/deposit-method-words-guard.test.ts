import { describe, it, expect } from 'vitest';
import { PaymentMethod } from '@prisma/client';

// #2980 (spec #2978; Ran 2026-11-04: card by phone is "Card by phone" for the office; a deposit
// method pick is an in-app alert, never an email) - no office alert and no History line about a
// customer's deposit pick carries a raw method code, for ANY value of the PaymentMethod enum. The
// table is the enum itself, so a new value fails here until it has words. The alert is rendered by
// the real template, from the data the deposit-method module stores on it (the codes).

import { depositMethodActivityLine } from '../lib/estimates/deposit-method';
import { DEPOSIT_METHOD_LABELS } from '../lib/deposit-method-labels';
import { renderTemplate } from '../services/notifications/templates';

const METHODS = Object.values(PaymentMethod);
/** The code as a word on its own (CARD inside EXTERNAL_CARD's words would not count, nor would "Card"). */
const codeIn = (text: string, code: string) => new RegExp(`(^|[^A-Za-z_])${code}([^A-Za-z_]|$)`).test(text);
const alert = (method: string, previous: string | null) => {
  const t = renderTemplate('estimate.deposit_method_selected', { object_label: 'E-1', method, previous_method: previous });
  return { ...t, all: `${t.title}\n${t.body ?? ''}` };
};

describe('the office reads a deposit method in words, never its code', () => {
  it('the enum has words for every value', () => {
    expect(METHODS.filter((m) => !DEPOSIT_METHOD_LABELS[m])).toEqual([]);
  });

  it.each(METHODS)('%s: the in-app alert, as a first pick, and as the old and as the new method', (method) => {
    const other = method === 'CHECK' ? 'ZELLE' : 'CHECK';
    for (const a of [alert(method, null), alert(other, method), alert(method, other)]) {
      expect(a.all).toContain(DEPOSIT_METHOD_LABELS[method]);
      expect(codeIn(a.all, method)).toBe(false);
    }
  });

  it.each(METHODS)('%s: the activity line, as a first pick and as a change', (method) => {
    const other = method === 'CHECK' ? 'ZELLE' : 'CHECK';
    for (const line of [
      depositMethodActivityLine(null, method, 'E-1'),
      depositMethodActivityLine(other, method, 'E-1'),
      depositMethodActivityLine(method, other, 'E-1'),
    ]) {
      expect(line).toContain(DEPOSIT_METHOD_LABELS[method]);
      expect(codeIn(line, method)).toBe(false);
    }
  });

  it('the alert reads as History does, names no amount, and asks the office to watch only for a method paid by hand', () => {
    expect(alert('CHECK', null)).toMatchObject({
      title: 'Customer chose Check for the deposit on E-1',
      body: 'Watch for incoming payment before marking the deposit as received.',
      category: 'ESTIMATE', object_type: 'ESTIMATE',
    });
    expect(alert('EXTERNAL_CARD', 'CHECK')).toMatchObject({
      title: 'Customer changed the deposit method on E-1 from Check to Card by phone',
      body: 'Watch for incoming payment before marking the deposit as received.',
    });
    // Card and bank are paid online and confirm themselves: no watch line.
    for (const online of ['CARD', 'ACH']) expect(alert(online, 'CHECK').body).toBeUndefined();
    expect(alert('ACH', 'CHECK').title).toBe('Customer changed the deposit method on E-1 from Check to Bank Account');
    // An amount handed in is never shown (M4): the bell strips it before the template, and the template names none.
    for (const m of METHODS) expect(alert(m, null).all).not.toMatch(/\$|\d+\.\d{2}/);
  });
});
