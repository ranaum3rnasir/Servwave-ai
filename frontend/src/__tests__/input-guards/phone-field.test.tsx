/* =============================================================================
   The phone field (mobile slice 36, KB-02).

   1. The pure value rules (src/ui-kit/lib/phoneField.ts), driven by the table
      the backend test reads too (src/ui-kit/lib/phoneFieldCases.json):
        * a US number saves exactly what the old mask saved;
        * a +1 number, an international number and a stored number of more
          than ten digits are never truncated and never given a +1.
   2. The phone kind (src/ui-kit/lib/fieldKind.ts): telephone type, telephone
      keypad, phone autofill.
   3. <PhoneInput>: renders those attributes in both appearances and emits the
      table's values from real typing.
   ============================================================================= */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import cases from '@/ui-kit/lib/phoneFieldCases.json';
import { formatPhoneInput } from '@/lib/utils';
import { fieldKindAttributes } from '@/ui-kit/lib/fieldKind';
import { isUsPhoneValue, nextPhoneValue, phoneFieldValue, type PhoneFormat } from '@/ui-kit/lib/phoneField';
import { PhoneInput } from '@/ui-kit/components/form/phoneInput';
import { Input as AppInput } from '@/components/ui/input';

const digits = (s: string) => s.replace(/\D/g, '');

describe('phone value rules (mobile slice 36)', () => {
  it.each(cases.typing)('$case: "$next" -> "$emits"', ({ prev, next, format, emits }) => {
    expect(nextPhoneValue(next, prev, format as PhoneFormat)).toBe(emits);
  });

  it('the table states what the old mask did, and differs from it only where the old mask lost digits', () => {
    for (const c of cases.typing) {
      const old = c.format === 'us' ? formatPhoneInput(c.next) : c.next;
      expect(old, c.case).toBe(c.before);
      if (c.emits !== c.before) {
        // The old value lost the plus or a digit the user typed.
        expect(digits(c.before).length < digits(c.next).length || c.next.trim().startsWith('+'), c.case).toBe(true);
      }
    }
  });

  it.each(cases.stored)('$case: stored "$stored" shows "$shows"', ({ stored, shows }) => {
    expect(phoneFieldValue(stored)).toBe(shows);
  });

  it('a stored international or long number is shown unchanged and never gains a +1', () => {
    for (const stored of ['447700900123', '+44 20 7946 0958', '5125550147214', '+61 2 9374 4000']) {
      expect(isUsPhoneValue(stored), stored).toBe(false);
      expect(phoneFieldValue(stored)).toBe(stored);
      expect(phoneFieldValue(stored)).not.toMatch(/^\+1/);
    }
  });
});

describe('the phone kind (mobile slice 36)', () => {
  it('telephone type, telephone keypad, phone autofill, nothing capitalised or corrected', () => {
    expect(fieldKindAttributes('phone')).toEqual({
      type: 'tel', inputMode: 'tel', autoComplete: 'tel', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, enterKeyHint: undefined,
    });
  });

  it("a third party's number: personal autofill off, type and keypad kept", () => {
    expect(fieldKindAttributes('phone', { personalAutofill: false })).toEqual({ ...fieldKindAttributes('phone'), autoComplete: 'off' });
  });

  it('the extension box: numeric keypad, extension autofill', () => {
    expect(fieldKindAttributes('phone-extension')).toMatchObject({ type: 'text', inputMode: 'numeric', autoComplete: 'tel-extension' });
  });
});

// 'app' is the kit appearance drawn with the app's own Input (the `component` prop).
type Look = 'kit' | 'app' | 'bare';
function Harness({ initial, format, appearance }: { initial: string; format?: PhoneFormat; appearance?: Look }) {
  const [value, setValue] = React.useState(initial);
  return (
    <>
      <PhoneInput
        aria-label="Phone"
        value={value}
        onValueChange={setValue}
        format={format}
        appearance={appearance === 'app' ? 'kit' : appearance}
        component={appearance === 'app' ? AppInput : undefined}
      />
      <output data-testid="saved">{value}</output>
    </>
  );
}

describe('<PhoneInput> (mobile slice 36)', () => {
  it.each(['kit', 'app', 'bare'] as const)('%s: renders the telephone type, keypad and phone autofill', (appearance) => {
    render(<Harness initial="" appearance={appearance} />);
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAttribute('type', 'tel');
    expect(input).toHaveAttribute('inputmode', 'tel');
    expect(input).toHaveAttribute('autocomplete', 'tel');
  });

  it("personalAutofill={false}: a third party's number keeps the telephone type and keypad", () => {
    render(<PhoneInput aria-label="Phone" value="" onValueChange={() => {}} personalAutofill={false} />);
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAttribute('type', 'tel');
    expect(input).toHaveAttribute('inputmode', 'tel');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });

  it('draws no fixed US / +1 prefix (an international number would be misread)', () => {
    const { container } = render(<PhoneInput aria-label="Phone" value="+44 7700 900123" onValueChange={() => {}} />);
    expect(container.textContent).not.toMatch(/\+1|US/);
    expect(container.querySelectorAll('input')).toHaveLength(1);
  });

  it('shows a stored international number exactly as stored', () => {
    render(<Harness initial="447700900123" />);
    expect(screen.getByLabelText('Phone')).toHaveValue('447700900123');
  });

  it.each(cases.typing)('$case: typing emits "$emits"', ({ prev, next, format, emits }) => {
    render(<Harness initial={prev} format={format as PhoneFormat} />);
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: next } });
    expect(screen.getByTestId('saved').textContent).toBe(emits);
  });

  it('passes the rest of an input through (id, placeholder, key handler, ref)', () => {
    const ref = React.createRef<HTMLInputElement>();
    let pressed = '';
    render(<PhoneInput id="p" ref={ref} placeholder="(555) 123-4567" value="" onValueChange={() => {}} onKeyDown={(e) => { pressed = e.key; }} appearance="bare" className="font-mono" />);
    const input = screen.getByPlaceholderText('(555) 123-4567');
    expect(input).toHaveAttribute('id', 'p');
    expect(input).toHaveClass('font-mono');
    expect(ref.current).toBe(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(pressed).toBe('Enter');
  });
});
