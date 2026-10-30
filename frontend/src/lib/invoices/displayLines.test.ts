import { describe, it, expect } from 'vitest';
import { invoiceDisplayLines } from './displayLines';

const line = (id: string, sequence: number) => ({ id, sequence });

describe('invoiceDisplayLines (the staff page prints only what the total is made of)', () => {
  it('own lines win over everything', () => {
    expect(invoiceDisplayLines([line('o2', 2), line('o1', 1)], [{ id: 's' }], [line('e1', 1)]).map((l) => l.id)).toEqual(['o1', 'o2']);
  });

  it('an invoice with scope blocks and no own lines prints no lines: the scope blocks carry the total', () => {
    expect(invoiceDisplayLines([], [{ id: 's' }], [line('e1', 1)])).toEqual([]);
  });

  it('a legacy job invoice with neither falls back to the estimate\'s lines, in order', () => {
    expect(invoiceDisplayLines([], [], [line('e2', 2), line('e1', 1)]).map((l) => l.id)).toEqual(['e1', 'e2']);
  });

  it('treats missing scopes like none', () => {
    expect(invoiceDisplayLines([], undefined, [line('e1', 1)]).map((l) => l.id)).toEqual(['e1']);
  });

  it('does not mutate its inputs', () => {
    const own = [line('o2', 2), line('o1', 1)];
    invoiceDisplayLines(own, [], []);
    expect(own.map((l) => l.id)).toEqual(['o2', 'o1']);
  });
});
