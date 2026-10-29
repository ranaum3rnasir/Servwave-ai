/**
 * PasswordInput - the eye toggle's contract (password reset spec §6, slice 01).
 *
 * Driven through the rendered field only: type, click, press keys, read what is on screen. The
 * typed value is generated per run, never a literal, so nothing here looks like a credential.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionConfig } from 'framer-motion';

import { PasswordInput } from './passwordInput';

const typedValue = () => `t-${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function Form({ onSubmit = vi.fn(), resetKey }: { onSubmit?: () => void; resetKey?: number }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" autoComplete="current-password" resetKey={resetKey} />
      <button type="submit">Go</button>
    </form>
  );
}

const field = () => screen.getByLabelText('Password') as HTMLInputElement;

describe('PasswordInput', () => {
  it('starts hidden, with a "Show password" button that controls the field', () => {
    render(<Form />);
    expect(field()).toHaveAttribute('type', 'password');
    const eye = screen.getByRole('button', { name: 'Show password' });
    expect(eye).toHaveAttribute('type', 'button');
    expect(eye).toHaveAttribute('aria-pressed', 'false');
    expect(eye).toHaveAttribute('aria-controls', 'pw');
  });

  it('keeps the autocomplete hint the caller gives, so password managers still fill it', () => {
    render(<Form />);
    expect(field()).toHaveAttribute('autocomplete', 'current-password');
  });

  it('clicking the eye shows the characters, relabels to "Hide password" and keeps focus and caret in the field', async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.type(field(), typedValue());
    field().setSelectionRange(3, 3);

    await user.click(screen.getByRole('button', { name: 'Show password' }));

    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(field()).toHaveAttribute('type', 'text');
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    expect(field()).toHaveFocus();
    expect(field().selectionStart).toBe(3);
    expect(field().selectionEnd).toBe(3);
  });

  it('puts the caret back where it was after the type switch (a browser may move it)', async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.type(field(), typedValue());
    field().setSelectionRange(2, 5);
    // jsdom keeps the selection across a type change, so prove the restore by watching the call.
    // (On the element itself: user-event installs its own setSelectionRange there.)
    const restore = vi.spyOn(field(), 'setSelectionRange');
    try {
      await user.click(screen.getByRole('button', { name: 'Show password' }));

      expect(restore).toHaveBeenCalledWith(2, 5);
    } finally {
      restore.mockRestore();
    }
  });

  it('a keyboard toggle leaves focus on the eye and does not touch the caret', async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.click(field());
    await user.tab();
    const restore = vi.spyOn(field(), 'setSelectionRange');
    try {
      await user.keyboard(' ');

      expect(field()).toHaveAttribute('type', 'text');
      expect(screen.getByRole('button', { name: 'Hide password' })).toHaveFocus();
      expect(restore).not.toHaveBeenCalled();
    } finally {
      restore.mockRestore();
    }
  });

  it('clicking again hides the characters', async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a keyboard user can Tab to the eye and toggle it with Space or Enter without submitting the form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    await user.click(field());
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();

    await user.keyboard(' ');
    expect(field()).toHaveAttribute('type', 'text');
    await user.keyboard('{Enter}');
    expect(field()).toHaveAttribute('type', 'password');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('pressing Enter in the field still submits the form (the eye is not the default button)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    await user.type(field(), `${typedValue()}{Enter}`);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(field()).toHaveAttribute('type', 'password');
  });

  it('goes back to hidden when the caller signals a successful submit (resetKey changes)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Form resetKey={0} />);
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field()).toHaveAttribute('type', 'text');

    rerender(<Form resetKey={1} />);

    expect(field()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });

  it('is hidden again when it mounts afresh after being revealed', async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [on, setOn] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOn((v) => !v)}>
            mount
          </button>
          {on && <Form />}
        </>
      );
    }
    render(<Toggle />);
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field()).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'mount' }));
    await user.click(screen.getByRole('button', { name: 'mount' }));

    expect(field()).toHaveAttribute('type', 'password');
  });

  describe('icon swap and reduced motion', () => {
    function Tree({ reduced }: { reduced: boolean }) {
      return (
        <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
          <Form />
        </MotionConfig>
      );
    }
    const icon = (name: string) => document.querySelector(`[data-icon="${name}"]`);

    it('shows the eye while hidden and the eye-off once revealed', async () => {
      const user = userEvent.setup();
      render(<Tree reduced={false} />);
      expect(icon('eye')).not.toBeNull();
      expect(icon('eye-off')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Show password' }));

      expect(icon('eye-off')).not.toBeNull();
      await waitFor(() => expect(icon('eye')).toBeNull(), { timeout: 1500 });
    });

    it('with reduced motion on, the icons swap at once with no animation in flight', async () => {
      const user = userEvent.setup();
      render(<Tree reduced />);
      await user.click(screen.getByRole('button', { name: 'Show password' }));
      // Well inside the ~150 ms the cross-fade would take.
      await waitFor(() => expect(icon('eye')).toBeNull(), { timeout: 60, interval: 5 });
      const off = icon('eye-off') as HTMLElement;
      expect(off.style.opacity === '' || off.style.opacity === '1').toBe(true);
    });

    it('control: with reduced motion off, the old icon is still fading out right after the click', async () => {
      const user = userEvent.setup();
      render(<Tree reduced={false} />);
      await user.click(screen.getByRole('button', { name: 'Show password' }));
      await sleep(40);
      expect(icon('eye')).not.toBeNull();
    });
  });
});
