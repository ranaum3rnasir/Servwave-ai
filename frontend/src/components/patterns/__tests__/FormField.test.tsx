/**
 * FormField - phase 10 rendered contract.
 *
 * Three things are asserted here.
 *
 * 1. THE REAL DEFECT THIS CLOSES: the control receives the SAME id the
 *    label's `htmlFor` points at, generated once, not typed twice by the
 *    call site.
 * 2. `error` WINS OVER `hint`, never both.
 * 3. THE LAYERING RULE. `components/patterns` is ratcheted to a directory-
 *    wide appearance ceiling of 0 - every element this file itself creates
 *    is a primitive invoked with props, never a raw className.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField } from '@/components/patterns/FormField';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

describe('FormField - id wiring', () => {
  it('generates one id and wires it to both the label and the control, via useId when htmlFor is omitted', () => {
    render(
      <FormField label="First Name">
        <Input placeholder="Jane" />
      </FormField>
    );
    const input = screen.getByPlaceholderText('Jane');
    const label = screen.getByText('First Name');
    expect(label.getAttribute('for')).toBe(input.id);
    expect(input.id).toBeTruthy();
  });

  it('uses an explicit htmlFor when given, e.g. to match an existing form.register field name', () => {
    render(
      <FormField label="Company" htmlFor="company_name">
        <Input placeholder="Acme" />
      </FormField>
    );
    expect(screen.getByPlaceholderText('Acme')).toHaveAttribute('id', 'company_name');
    expect(screen.getByText('Company').getAttribute('for')).toBe('company_name');
  });

  it('wires a Textarea the same way it wires an Input', () => {
    render(
      <FormField label="Notes" htmlFor="notes">
        <Textarea placeholder="Internal notes..." />
      </FormField>
    );
    expect(screen.getByPlaceholderText('Internal notes...')).toHaveAttribute('id', 'notes');
  });

  it('supports a render-prop child for a compound control cloneElement cannot shape-fit', () => {
    render(
      <FormField label="Phone" htmlFor="phone">
        {(fieldProps) => (
          <div>
            <input {...fieldProps} data-testid="phone-input" />
          </div>
        )}
      </FormField>
    );
    expect(screen.getByTestId('phone-input')).toHaveAttribute('id', 'phone');
  });
});

describe('FormField - required / optional', () => {
  it('renders a required asterisk', () => {
    render(
      <FormField label="First Name" required>
        <Input />
      </FormField>
    );
    expect(screen.getByText('First Name').textContent).toContain('*');
  });

  it('renders an optional suffix', () => {
    render(
      <FormField label="Last Name" optional>
        <Input />
      </FormField>
    );
    expect(screen.getByText('Last Name').textContent).toContain('(optional)');
  });
});

describe('FormField - hint and error', () => {
  it('renders hint text, wired via aria-describedby', () => {
    render(
      <FormField label="Email" hint="We will never share this.">
        <Input />
      </FormField>
    );
    const input = screen.getByLabelText('Email');
    expect(screen.getByText('We will never share this.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('hint'));
  });

  it('renders error text and sets aria-invalid, winning over hint when both are given', () => {
    render(
      <FormField label="Email" hint="We will never share this." error="Invalid email address">
        <Input />
      </FormField>
    );
    expect(screen.getByText('Invalid email address')).toBeInTheDocument();
    expect(screen.queryByText('We will never share this.')).toBeNull();
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('error'));
  });

  it('renders neither hint nor error, and no aria-describedby, when neither is given', () => {
    render(
      <FormField label="Company">
        <Input />
      </FormField>
    );
    expect(screen.getByLabelText('Company')).not.toHaveAttribute('aria-describedby');
  });
});

/*
 * `cloneElement` MERGES a props object, and a key present with the value
 * `undefined` OVERWRITES rather than being skipped - it only falls back to the
 * element type's `defaultProps`, which modern function components do not have.
 * So building `fieldProps` with `'aria-describedby': undefined` unconditionally
 * and handing it to `cloneElement` DELETES whatever the caller authored on the
 * control. Verified against this project's own React before the fix: a child
 * authored as `aria-describedby="my-help" aria-invalid` came back with both
 * attributes gone.
 *
 * This matters because FormField's whole contract is "adoption is a wrapping
 * move, not a re-authoring of the control's own props" - a wrapper that
 * silently strips a11y attributes off the thing it wraps breaks that promise
 * in the one direction nobody looks at.
 */
describe('FormField - preserves aria the caller authored on the control', () => {
  it('keeps the child aria-describedby when FormField contributes no hint or error', () => {
    render(
      <FormField label="Email">
        <Input aria-describedby="external-help" />
      </FormField>
    );
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby', 'external-help');
  });

  it('keeps the child aria-invalid when FormField has no error of its own', () => {
    render(
      <FormField label="Email">
        <Input aria-invalid />
      </FormField>
    );
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('merges the child aria-describedby with its own hint id rather than replacing it', () => {
    render(
      <FormField label="Email" hint="We will never share this.">
        <Input aria-describedby="external-help" />
      </FormField>
    );
    const describedBy = screen.getByLabelText('Email').getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toContain('external-help');
    expect(describedBy).toEqual(expect.stringContaining('hint'));
  });

  it('merges the child aria-describedby with its own error id rather than replacing it', () => {
    render(
      <FormField label="Email" error="Invalid email address">
        <Input aria-describedby="external-help" />
      </FormField>
    );
    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toContain('external-help');
    expect(describedBy).toEqual(expect.stringContaining('error'));
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('FormField - layering rule', () => {
  it('authors no raw className: the root Stack renders exactly its gap class, nothing else', () => {
    const { container } = render(
      <FormField label="First Name" gap={1.5}>
        <Input />
      </FormField>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('class')).toBe('flex flex-col gap-1.5');
  });
});
