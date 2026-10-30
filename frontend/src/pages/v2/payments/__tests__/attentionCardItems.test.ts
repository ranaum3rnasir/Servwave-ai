import { describe, expect, it } from 'vitest';

import type { AttentionType } from '@/lib/api/paymentsPage';

import { arrangeCardItems, ATTENTION_FETCH_LIMIT, CARD_ROWS } from '../attentionCardItems';
import { makeItem } from './attentionFixtures';

const ORDER: AttentionType[] = ['dispute', 'failed_payment', 'failed_refund', 'failed_payout', 'unmatched_payment', 'unmatched_refund'];
const keys = (items: { key: string }[]) => items.map((i) => i.key);

describe('arrangeCardItems', () => {
  it('asks for 50 and shows 6', () => {
    expect(ATTENTION_FETCH_LIMIT).toBe(50);
    expect(CARD_ROWS).toBe(6);
  });

  it('puts the most urgent item of each kind first, in kind order, then the rest in kind order, cut at 6', () => {
    const items = [
      ...ORDER.map((type, i) => makeItem(i + 1, type)),
      makeItem(10, 'failed_payment'),
      makeItem(11, 'dispute', { respond_by: '2026-10-25T00:00:00.000Z' }),
    ];
    const out = arrangeCardItems(items);
    expect(out).toHaveLength(6);
    expect(out.map((i) => i.type)).toEqual(ORDER);
  });

  it('fills the rest after the firsts in kind order when fewer kinds are open', () => {
    const items = [
      makeItem(1, 'failed_refund'),
      makeItem(2, 'failed_payment'),
      makeItem(3, 'failed_payment'),
      makeItem(4, 'dispute'),
      makeItem(5, 'dispute', { respond_by: '2026-10-21T00:00:00.000Z' }),
    ];
    const out = arrangeCardItems(items);
    expect(out.map((i) => i.type)).toEqual(['dispute', 'failed_payment', 'failed_refund', 'dispute', 'failed_payment']);
  });

  it('orders disputes by soonest respond_by and the others newest first', () => {
    const late = makeItem(1, 'dispute', { respond_by: '2026-10-30T00:00:00.000Z' });
    const soon = makeItem(2, 'dispute', { respond_by: '2026-10-18T00:00:00.000Z' });
    const older = makeItem(3, 'failed_payment', { date: '2026-10-01T00:00:00.000Z' });
    const newer = makeItem(4, 'failed_payment', { date: '2026-10-10T00:00:00.000Z' });
    expect(keys(arrangeCardItems([late, soon]))).toEqual([soon.key, late.key]);
    expect(keys(arrangeCardItems([older, newer]))).toEqual([newer.key, older.key]);
  });

  it('does not change the list it was given', () => {
    const items = [makeItem(1, 'failed_payout'), makeItem(2, 'dispute')];
    const copy = [...items];
    arrangeCardItems(items);
    expect(items).toEqual(copy);
  });
});
