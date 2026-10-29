/* =============================================================================
   Money and quantity fields (mobile slice 37, rubric KB-04).

   1. The parser: a number or nothing, from what a person types or pastes
      (thousands commas, blanks, negatives where allowed, invalid text).
   2. The typing cleaner and the validity rules that replace the number
      input's own min / max / step checks.
   3. The primitives: the kit Input and the legacy Input with a number kind are
      text inputs with the decimal (or numeric) keypad, keep a half-typed
      "1." on screen while their caller holds a number, and hand the caller the
      same value a number input did for the same keystrokes.
   ============================================================================= */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { fieldKindAttributes } from '@/ui-kit/lib/fieldKind';
import { cleanNumberText, localeDecimalSeparator, numberFieldError, parseNumberField } from '@/ui-kit/lib/numberField';
import { Input as KitInput } from '@/ui-kit/components/ui/input';
import { Input as LegacyInput } from '@/components/ui/input';

describe('parseNumberField (mobile slice 37)', () => {
  it('reads plain numbers, decimals and a leading or trailing point', () => {
    expect(parseNumberField('12', 'money')).toBe(12);
    expect(parseNumberField('12.50', 'money')).toBe(12.5);
    expect(parseNumberField('.5', 'quantity')).toBe(0.5);
    expect(parseNumberField('3.', 'quantity')).toBe(3);
    expect(parseNumberField('007', 'count')).toBe(7);
    expect(parseNumberField('  42 ', 'money')).toBe(42);
  });

  it('reads thousands commas, and refuses a comma that is not a thousands separator', () => {
    expect(parseNumberField('1,234', 'money')).toBe(1234);
    expect(parseNumberField('1,234.56', 'money')).toBe(1234.56);
    expect(parseNumberField('12,345,678.9', 'quantity')).toBe(12345678.9);
    // "12,5" is a decimal comma in some locales: never guess it into 125 or 12.5.
    expect(parseNumberField('12,5', 'money')).toBeNull();
    expect(parseNumberField('1,23', 'money')).toBeNull();
    expect(parseNumberField(',5', 'money')).toBeNull();
  });

  it('a blank is nothing, not zero', () => {
    expect(parseNumberField('', 'money')).toBeNull();
    expect(parseNumberField('   ', 'quantity')).toBeNull();
    expect(parseNumberField(null, 'money')).toBeNull();
    expect(parseNumberField(undefined, 'money')).toBeNull();
  });

  it('negatives only where allowed', () => {
    expect(parseNumberField('-5', 'money')).toBeNull();
    expect(parseNumberField('-5', 'money', { allowNegative: true })).toBe(-5);
    expect(parseNumberField('-1,250.75', 'money', { allowNegative: true })).toBe(-1250.75);
    expect(parseNumberField(-2, 'quantity')).toBeNull();
    expect(parseNumberField(-2, 'quantity', { allowNegative: true })).toBe(-2);
    // A lone minus or "-0" is no negative number.
    expect(parseNumberField('-', 'money', { allowNegative: true })).toBeNull();
    expect(Object.is(parseNumberField('-0', 'money', { allowNegative: true }), 0)).toBe(true);
  });

  it('invalid text is nothing', () => {
    for (const bad of ['abc', '12abc', '1.2.3', '.', '1e3', '--5', '5-', '0x10', 'NaN', 'Infinity', '1 2']) {
      expect(parseNumberField(bad, 'money', { allowNegative: true }), bad).toBeNull();
    }
    expect(parseNumberField(Number.NaN, 'money')).toBeNull();
    expect(parseNumberField(Number.POSITIVE_INFINITY, 'money')).toBeNull();
  });

  it('a currency sign on money and a percent sign on percent are read through', () => {
    expect(parseNumberField('$1,200.00', 'money')).toBe(1200);
    expect(parseNumberField('-$5', 'money', { allowNegative: true })).toBe(-5);
    expect(parseNumberField('8.875%', 'percent')).toBe(8.875);
    expect(parseNumberField('$5', 'quantity')).toBeNull();
    expect(parseNumberField('5%', 'money')).toBeNull();
  });

  it('a count is a whole number', () => {
    expect(parseNumberField('12', 'count')).toBe(12);
    expect(parseNumberField('1,500', 'count')).toBe(1500);
    expect(parseNumberField('12.5', 'count')).toBeNull();
    expect(parseNumberField(2.5, 'count')).toBeNull();
  });
});

describe('cleanNumberText: what a keystroke or a paste leaves in the box (mobile slice 37)', () => {
  it('keeps digits and one decimal point, drops everything else', () => {
    expect(cleanNumberText('1,234.50', 'money')).toBe('1234.50');
    expect(cleanNumberText('$ 99.9', 'money')).toBe('99.9');
    expect(cleanNumberText('12a', 'money')).toBe('12');
    expect(cleanNumberText('1.2.', 'quantity')).toBe('1.2');
    expect(cleanNumberText('.', 'quantity')).toBe('.');
    expect(cleanNumberText('', 'money')).toBe('');
  });

  it('a minus only first, and only where negatives are allowed', () => {
    expect(cleanNumberText('-5', 'money')).toBe('5');
    expect(cleanNumberText('-5', 'money', { allowNegative: true })).toBe('-5');
    expect(cleanNumberText('5-', 'money', { allowNegative: true })).toBe('5');
    expect(cleanNumberText('-', 'money', { allowNegative: true })).toBe('-');
  });

  it('in a region that writes 12,50, the decimal key\'s comma is the point (never 1250)', () => {
    expect(cleanNumberText('12,50', 'money', { decimalSeparator: ',' })).toBe('12.50');
    expect(cleanNumberText('12,', 'money', { decimalSeparator: ',' })).toBe('12.');
    // The box already holds "12.50"; typing a 3 must keep that point.
    expect(cleanNumberText('12.503', 'money', { decimalSeparator: ',' })).toBe('12.503');
    // A pasted or programmatic "1.234,56" is read whole by the parser.
    expect(parseNumberField('1.234,56', 'money', { decimalSeparator: ',' })).toBe(1234.56);
    expect(parseNumberField('12,5', 'money', { decimalSeparator: ',' })).toBe(12.5);
    expect(parseNumberField('12.5', 'money', { decimalSeparator: ',' })).toBeNull();
    expect(localeDecimalSeparator('de-DE')).toBe(',');
    expect(localeDecimalSeparator('en-US')).toBe('.');
  });

  it('a count keeps a typed point (dropping it would turn 1.5 into 15); validity refuses it instead', () => {
    expect(cleanNumberText('1.5', 'count')).toBe('1.5');
    expect(cleanNumberText('1,500', 'count')).toBe('1500');
  });
});

describe('numberFieldError: the number input\'s own checks, kept (mobile slice 37)', () => {
  it('nothing typed is valid (required is the form\'s business)', () => {
    expect(numberFieldError('', {})).toBeNull();
  });

  it('a half-typed number is not a number', () => {
    expect(numberFieldError('.', {})).toBe('Enter a number.');
    expect(numberFieldError('-', {})).toBe('Enter a number.');
  });

  it('min and max', () => {
    expect(numberFieldError('0', { min: 0.01 })).toBe('Enter 0.01 or more.');
    expect(numberFieldError('0.01', { min: 0.01 })).toBeNull();
    expect(numberFieldError('101', { max: 100 })).toBe('Enter 100 or less.');
    expect(numberFieldError('100', { min: '0', max: '100' })).toBeNull();
  });

  it('step, counted from min like the number input', () => {
    expect(numberFieldError('1.5', { step: 1 })).toBe('Enter a whole number.');
    expect(numberFieldError('1.234', { step: 0.01 })).toBe('Use steps of 0.01.');
    expect(numberFieldError('1.23', { step: '0.01' })).toBeNull();
    expect(numberFieldError('0.3', { step: 0.1 })).toBeNull();
    expect(numberFieldError('45', { min: 15, step: 15 })).toBeNull();
    expect(numberFieldError('40', { min: 15, step: 15 })).toBe('Use steps of 15.');
    expect(numberFieldError('1.234', { step: 'any' })).toBeNull();
  });
});

describe('number kinds in the field kind table (mobile slice 37)', () => {
  it('money, quantity and percent: a text input with the decimal keypad', () => {
    for (const kind of ['money', 'quantity', 'percent'] as const) {
      expect(fieldKindAttributes(kind), kind).toEqual({
        type: 'text', inputMode: 'decimal', autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, enterKeyHint: undefined,
      });
    }
  });

  it('count: a text input with the numeric keypad', () => {
    expect(fieldKindAttributes('count')).toMatchObject({ type: 'text', inputMode: 'numeric', autoComplete: 'off' });
  });
});

/**
 * A caller that holds a NUMBER (the line items editor's shape), which breaks a
 * naive text input: Number("12.") is 12, so the point would vanish.
 */
function NumberState({ Input, kind = 'money', onSave, ...rest }: { Input: typeof KitInput | typeof LegacyInput; kind?: 'money' | 'quantity' | 'count'; onSave?: (n: number | '') => void } & Record<string, unknown>) {
  const [n, setN] = React.useState<number | ''>('');
  return (
    <>
      <Input aria-label="Amount" kind={kind} value={n} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setN(e.target.value === '' ? '' : Number(e.target.value))} {...rest} />
      <button type="button" onClick={() => onSave?.(n)}>Save</button>
    </>
  );
}

/** A caller that holds the TEXT and parses it on save (most money dialogs). */
function TextState({ Input, onSave, ...rest }: { Input: typeof KitInput | typeof LegacyInput; onSave?: (s: string) => void } & Record<string, unknown>) {
  const [s, setS] = React.useState('');
  return (
    <>
      <Input aria-label="Amount" kind="money" value={s} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setS(e.target.value)} {...rest} />
      <button type="button" onClick={() => onSave?.(s)}>Save</button>
    </>
  );
}

describe.each([
  ['kit Input', KitInput],
  ['legacy Input', LegacyInput],
] as const)('%s with a number kind (mobile slice 37)', (_name, Input) => {
  it('is a text input with the decimal keypad and no number-input attributes', () => {
    render(<Input aria-label="Amount" kind="money" min={0} max={10} step={0.01} defaultValue="" />);
    const el = screen.getByRole('textbox', { name: 'Amount' });
    expect(el).toHaveAttribute('type', 'text');
    expect(el).toHaveAttribute('inputmode', 'decimal');
    for (const a of ['min', 'max', 'step']) expect(el.hasAttribute(a), a).toBe(false);
  });

  it('a count field gets the numeric keypad', () => {
    render(<Input aria-label="Days" kind="count" defaultValue="" />);
    expect(screen.getByRole('textbox', { name: 'Days' })).toHaveAttribute('inputmode', 'numeric');
  });

  it('keeps "12." and "12.0" on screen while the caller holds the number 12, and saves 12.05', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NumberState Input={Input} onSave={onSave} />);
    const el = screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;
    await user.type(el, '12.');
    expect(el.value).toBe('12.');
    await user.type(el, '0');
    expect(el.value).toBe('12.0');
    await user.type(el, '5');
    expect(el.value).toBe('12.05');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(12.05);
  });

  it('typed thousands commas and stray letters never reach the caller', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<TextState Input={Input} onSave={onSave} />);
    const el = screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;
    await user.type(el, '1,250.5x0');
    expect(el.value).toBe('1250.50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('1250.50');
  });

  it('a lone point reaches the caller as blank (as a number input reported it) and stays on screen', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<TextState Input={Input} onSave={onSave} />);
    const el = screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;
    await user.type(el, '.');
    expect(el.value).toBe('.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('a typed minus is never silently dropped: where min is 0 it reaches the caller and is invalid', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<TextState Input={Input} min={0} onSave={onSave} />);
    const el = screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;
    await user.type(el, '-5');
    expect(el.value).toBe('-5');
    expect(el.validationMessage).toBe('Enter 0 or more.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('-5');
  });

  it('onValueChange hands over the parsed number, or null (a negative only where min allows it)', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { unmount } = render(<Input aria-label="Amount" kind="money" defaultValue="" onValueChange={onValueChange} />);
    const el = screen.getByRole('textbox', { name: 'Amount' });
    await user.type(el, '7.');
    expect(onValueChange).toHaveBeenLastCalledWith(7);
    await user.clear(el);
    expect(onValueChange).toHaveBeenLastCalledWith(null);
    await user.type(el, '-2');
    expect(onValueChange).toHaveBeenLastCalledWith(-2);
    unmount();
    render(<Input aria-label="Price" kind="money" min={0} defaultValue="" onValueChange={onValueChange} />);
    await user.type(screen.getByRole('textbox', { name: 'Price' }), '-2');
    expect(onValueChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps min, max and step as the field\'s validity, like the number input did', async () => {
    const user = userEvent.setup();
    render(<TextState Input={Input} min={0.01} max={100} step={0.01} />);
    const el = screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;
    await user.type(el, '0');
    expect(el.validationMessage).toBe('Enter 0.01 or more.');
    await user.type(el, '.5');
    expect(el.validity.valid).toBe(true);
    await user.clear(el);
    await user.type(el, '150');
    expect(el.validationMessage).toBe('Enter 100 or less.');
  });

  it('a count keeps a typed "1.5" (never 15) and calls it invalid', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Days" kind="count" defaultValue="" />);
    const el = screen.getByRole('textbox', { name: 'Days' }) as HTMLInputElement;
    await user.type(el, '1.5');
    expect(el.value).toBe('1.5');
    expect(el.validationMessage).toBe('Enter a whole number.');
  });

  // The mouse wheel is not tested here: jsdom never steps a number input, so a
  // wheel test would pass on the old code too. The mobile gate's
  // money-fields.spec.ts proves it in a real browser on the desktop control.

  it('a register()-style uncontrolled field still forwards the ref and reads clean text', async () => {
    const user = userEvent.setup();
    const ref = React.createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<Input aria-label="Amount" kind="count" ref={ref} onChange={onChange} />);
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '1,5x0');
    expect(ref.current?.value).toBe('150');
    expect(onChange).toHaveBeenCalled();
  });
});
