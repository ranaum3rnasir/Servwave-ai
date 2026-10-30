import { describe, expect, it } from 'vitest';

import type { AttentionItem } from '@/lib/api/paymentsPage';

import { MAX_DEPTH, parseStack, pushOnto, serializeStack, stackForItem, viewLabel, withoutRespond } from '../drawerStack';
import { makeItem } from './attentionFixtures';

const parse = (query: string) => parseStack(new URLSearchParams(query));

describe('parseStack', () => {
  it('reads a comma list, bottom first, splitting each entry on its first colon', () => {
    expect(parse('d=payment:p1,dispute:d1,respond:d1').stack).toEqual([
      { kind: 'payment', id: 'p1' }, { kind: 'dispute', id: 'd1' }, { kind: 'respond', id: 'd1' },
    ]);
  });

  it('keeps the colon inside an item key', () => {
    expect(parse('d=item:failed_payment:3f2a-11').stack).toEqual([{ kind: 'item', id: 'failed_payment:3f2a-11' }]);
  });

  it('caps the depth at 4 and skips malformed or unknown entries', () => {
    const five = parse('d=payment:a,payout:b,dispute:c,respond:c,payment:e');
    expect(five.stack).toHaveLength(MAX_DEPTH);
    expect(parse('d=nonsense,payment:,:x,wat:1,payment:ok,payment:bad id!').stack).toEqual([{ kind: 'payment', id: 'ok' }]);
  });

  it('drops a repeated view', () => {
    expect(parse('d=payment:a,payment:a').stack).toEqual([{ kind: 'payment', id: 'a' }]);
  });

  it('converts the old payment, payout and dispute params and says it was legacy', () => {
    expect(parse('payment=p1')).toMatchObject({ legacy: true, stack: [{ kind: 'payment', id: 'p1' }] });
    expect(parse('payout=o1&payment=p1').stack).toEqual([{ kind: 'payout', id: 'o1' }, { kind: 'payment', id: 'p1' }]);
    expect(parse('dispute=d1').stack).toEqual([{ kind: 'dispute', id: 'd1' }]);
  });

  it('prefers d over the old params', () => {
    expect(parse('d=payout:o1&payment=p1')).toMatchObject({ legacy: false, stack: [{ kind: 'payout', id: 'o1' }] });
  });

  it('is empty with nothing to read', () => {
    expect(parse('tab=payments').stack).toEqual([]);
  });
});

describe('serializeStack / pushOnto', () => {
  it('round-trips', () => {
    const stack = [{ kind: 'payment', id: 'p1' }, { kind: 'item', id: 'failed_refund:x1' }] as const;
    expect(parse(`d=${serializeStack([...stack])}`).stack).toEqual(stack);
  });

  it('pushing a view already in the stack cuts back to it', () => {
    const s = [{ kind: 'payment', id: 'p1' }, { kind: 'dispute', id: 'd1' }] as const;
    expect(pushOnto([...s], [{ kind: 'payment', id: 'p1' }])).toEqual([{ kind: 'payment', id: 'p1' }]);
  });

  it('a push past the cap is ignored', () => {
    const s = parse('d=payment:a,payout:b,dispute:c,respond:c').stack;
    expect(pushOnto(s, [{ kind: 'payment', id: 'z' }])).toEqual(s);
  });
});

describe('stackForItem (what opens on top of what)', () => {
  const stackOf = (item: AttentionItem) => stackForItem(item);

  it('a failed payment or refund opens its Payment, then the Item', () => {
    const item = makeItem(1, 'failed_payment', { payment_id: 'p1' });
    expect(stackOf(item)).toEqual([{ kind: 'payment', id: 'p1' }, { kind: 'item', id: item.key }]);
    const refund = makeItem(2, 'failed_refund', { payment_id: 'p2' });
    expect(stackOf(refund)).toEqual([{ kind: 'payment', id: 'p2' }, { kind: 'item', id: refund.key }]);
  });

  it('a failed payout opens its Payout, then the Item', () => {
    const item = makeItem(3, 'failed_payout', { payment_id: null, payout_id: 'o1' });
    expect(stackOf(item)).toEqual([{ kind: 'payout', id: 'o1' }, { kind: 'item', id: item.key }]);
  });

  it('a dispute opens its Payment then the Dispute, and Respond adds the Respond view', () => {
    const item = makeItem(4, 'dispute', { payment_id: 'p1', dispute_id: 'd1' });
    expect(stackOf(item)).toEqual([{ kind: 'payment', id: 'p1' }, { kind: 'dispute', id: 'd1' }]);
    expect(stackForItem(item, { respond: true })).toEqual([
      { kind: 'payment', id: 'p1' }, { kind: 'dispute', id: 'd1' }, { kind: 'respond', id: 'd1' },
    ]);
  });

  it('unapplied money opens its Item alone: there is no payment underneath', () => {
    const payment = makeItem(6, 'unmatched_payment');
    expect(stackOf(payment)).toEqual([{ kind: 'item', id: payment.key }]);
    const refund = makeItem(7, 'unmatched_refund');
    expect(stackOf(refund)).toEqual([{ kind: 'item', id: refund.key }]);
    expect(stackOf(makeItem(8, 'unmatched_payment', { restricted: true }))).toBeNull();
  });

  it('a restricted item opens nothing', () => {
    expect(stackOf(makeItem(5, 'failed_payment', { payment_id: 'p1', restricted: true }))).toBeNull();
  });
});

describe('viewLabel', () => {
  it('names an unapplied item for the Back button', () => {
    expect(viewLabel({ kind: 'item', id: 'unmatched_payment:u1' })).toBe('Unapplied payment');
    expect(viewLabel({ kind: 'item', id: 'unmatched_refund:u1' })).toBe('Unapplied refund');
  });

  it('names the view for the Back button', () => {
    expect(viewLabel({ kind: 'payment', id: 'p' })).toBe('Payment');
    expect(viewLabel({ kind: 'respond', id: 'd' })).toBe('Respond');
    expect(viewLabel({ kind: 'item', id: 'failed_payment:x' })).toBe('Failed payment');
    expect(viewLabel({ kind: 'item', id: 'failed_refund:x' })).toBe('Failed refund');
    expect(viewLabel({ kind: 'item', id: 'failed_payout:x' })).toBe('Failed payout');
  });
});

describe('withoutRespond', () => {
  const pay = { kind: 'payment', id: 'p1' } as const;
  const dis = { kind: 'dispute', id: 'd1' } as const;
  const res = { kind: 'respond', id: 'd1' } as const;

  it('takes the Respond view off and leaves the Dispute it answers on top', () => {
    expect(withoutRespond([pay, dis, res], 'd1')).toEqual([pay, dis]);
  });

  it('puts the Dispute there when the address held Respond alone, or under something else', () => {
    expect(withoutRespond([res], 'd1')).toEqual([dis]);
    expect(withoutRespond([pay, res], 'd1')).toEqual([pay, dis]);
  });

  it('leaves a stack with no Respond view for that dispute as it is, with the Dispute on top', () => {
    expect(withoutRespond([pay, dis], 'd1')).toEqual([pay, dis]);
  });
});
