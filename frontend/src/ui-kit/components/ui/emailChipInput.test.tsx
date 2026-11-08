/**
 * EmailChipInput - the CC field's own contract.
 *
 * Driven entirely through the rendered field: type, press keys, read what is on screen. Nothing
 * here reaches for state or internals, so the component can be rewritten as long as a person can
 * still add, refuse, cap and take back an address.
 *
 * It is tested because it is load-bearing on the wire, not because it is new: the cap mirrors the
 * server's `.max(5)` on notify_cc_emails, and a committed chip is a person who receives customer
 * mail. An uncapped or de-validated field turns a visit write into a 400 the user cannot read.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EmailChipInput } from './emailChipInput';

function setup(props: Partial<React.ComponentProps<typeof EmailChipInput>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <EmailChipInput id="cc" label="CC" emails={[]} onChange={onChange} {...props} />,
  );
  return { onChange, field: screen.getByLabelText('CC') as HTMLInputElement, ...utils };
}

describe('EmailChipInput', () => {
  it('commits a typed address on Enter', () => {
    const { onChange, field } = setup();

    fireEvent.change(field, { target: { value: 'ops@acme.test' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith(['ops@acme.test']);
  });

  it('commits on a trailing comma, the way a pasted address list arrives', () => {
    const { onChange, field } = setup();

    fireEvent.change(field, { target: { value: 'ops@acme.test,' } });

    expect(onChange).toHaveBeenCalledWith(['ops@acme.test']);
  });

  it('commits on blur, so an address typed just before Send is not lost', () => {
    const { onChange, field } = setup();

    fireEvent.change(field, { target: { value: 'ops@acme.test' } });
    fireEvent.blur(field);

    expect(onChange).toHaveBeenCalledWith(['ops@acme.test']);
  });

  it('refuses a malformed address with a reason, and adds nothing', () => {
    const { onChange, field } = setup();

    fireEvent.change(field, { target: { value: 'not-an-address' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses an address already in the To field rather than mailing them twice', () => {
    const { onChange, field } = setup({ reserved: ['Ada@Acme.test'] });

    fireEvent.change(field, { target: { value: 'ada@acme.test' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(screen.getByText('That address is already on this email')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a duplicate of a chip already committed', () => {
    const { onChange, field } = setup({ emails: ['ops@acme.test'] });

    fireEvent.change(field, { target: { value: 'ops@acme.test' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(screen.getByText('That address is already on this email')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops at the cap the server enforces, instead of letting the request 400 later', () => {
    const five = ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test', 'e@x.test'];
    const { onChange, field } = setup({ emails: five });

    fireEvent.change(field, { target: { value: 'f@x.test' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(screen.getByText('Up to 5 CC addresses')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes the last chip back into the box on Backspace, so a typo is fixable', () => {
    const { onChange, field } = setup({ emails: ['ops@acme.test'] });

    fireEvent.keyDown(field, { key: 'Backspace' });

    expect(onChange).toHaveBeenCalledWith([]);
    expect(field).toHaveValue('ops@acme.test');
  });

  it('removes a chip through its own labelled control', () => {
    const { onChange } = setup({ emails: ['ops@acme.test', 'ops2@acme.test'] });

    fireEvent.click(screen.getByRole('button', { name: 'Remove ops@acme.test' }));

    expect(onChange).toHaveBeenCalledWith(['ops2@acme.test']);
  });
});
