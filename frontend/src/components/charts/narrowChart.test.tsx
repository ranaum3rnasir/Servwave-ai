import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { fitCategoryAxis, fitLabel, fittedCategoryTick, narrowLabelWidth, narrowValueRoom } from './narrowChart';

/** One unit per character: easy to reason about widths. */
const perChar = (s: string) => s.length;

describe('fitCategoryAxis (mobile slice 30)', () => {
  it('keeps the call site widths on wide screens', () => {
    expect(fitCategoryAxis(false, { labelWidth: 150, valueRoom: 96 })).toEqual({ labelWidth: 150, valueRoom: 96 });
  });

  it('caps a wide label column and value margin on a phone, so the bars keep their room', () => {
    expect(fitCategoryAxis(true, { labelWidth: 150, valueRoom: 96 })).toEqual({ labelWidth: narrowLabelWidth, valueRoom: narrowValueRoom });
  });

  it('never widens a column that is already narrow', () => {
    expect(fitCategoryAxis(true, { labelWidth: 72, valueRoom: 8 })).toEqual({ labelWidth: 72, valueRoom: 8 });
  });
});

describe('fitLabel', () => {
  it('returns a label that fits unchanged', () => {
    expect(fitLabel('Drain snake', 20, perChar)).toBe('Drain snake');
  });

  it('cuts a long label to the widest prefix that fits with an ellipsis', () => {
    const out = fitLabel('Water heater install', 10, perChar);
    expect(out).toBe('Water hea…');
    expect(perChar(out)).toBeLessThanOrEqual(10);
  });

  it('drops trailing spaces before the ellipsis', () => {
    expect(fitLabel('Water heater install', 7, perChar)).toBe('Water…');
  });

  it('keeps at least one character', () => {
    expect(fitLabel('Condenser coil clean', 1, perChar)).toBe('C…');
  });
});

describe('fittedCategoryTick', () => {
  it('ellipsizes a long name and keeps the full name as the title', () => {
    const tick = fittedCategoryTick({ axisWidth: 48, fontSize: 10 });
    const { container } = render(<svg>{tick({ x: 40, y: 12, payload: { value: 'Blower motor replace' } })}</svg>);
    const text = container.querySelector('text')!;
    expect(text.querySelector('title')?.textContent).toBe('Blower motor replace');
    expect(text.textContent).toMatch(/…$/);
  });

  it('leaves a short name alone, with no title', () => {
    const tick = fittedCategoryTick({ axisWidth: 120, fontSize: 10 });
    const { container } = render(<svg>{tick({ x: 40, y: 12, payload: { value: 'AC tune-up' } })}</svg>);
    expect(container.querySelector('text')!.textContent).toBe('AC tune-up');
    expect(container.querySelector('title')).toBeNull();
  });
});
