/* =============================================================================
   Form flow (mobile slice 38, KB-05 and A11Y-07): the form-level helper.

   1. Action keys: fields get Next in order and Done on the last; a field that
      names its own action key keeps it; a field added later is numbered in.
   2. On a touch pointer, Enter on a Next field moves to the next field and does
      not submit; on a fine pointer Enter behaves as before (submits).
   3. Errors: an error marked `data-error-for` is linked to its field
      (aria-describedby, aria-invalid) and unlinked when it goes away.
   4. A failed submit focuses the first invalid field in page order and scrolls
      it into view.
   ============================================================================= */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFormFlow } from '@/ui-kit/lib/formFlow';
import { Input } from '@/ui-kit/components/ui/input';

function setPointer(coarse: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
let scrollSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setPointer(false);
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as unknown as Element['scrollIntoView'];
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function ThreeFieldForm({ onSubmit = () => {}, extra = false }: { onSubmit?: () => void; extra?: boolean }) {
  const flow = useFormFlow();
  return (
    <form
      noValidate
      {...flow.formProps}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="a">First</label>
      <Input id="a" />
      <label htmlFor="b">Second</label>
      <Input id="b" />
      <label htmlFor="c">Third</label>
      <Input id="c" />
      {extra && (
        <>
          <label htmlFor="d">Fourth</label>
          <Input id="d" />
        </>
      )}
      <button type="submit">Save</button>
    </form>
  );
}

const hint = (label: string) => screen.getByLabelText(label).getAttribute('enterkeyhint');

describe('action keys', () => {
  it('a three-field form using the helper gives Next, Next, Done', () => {
    render(<ThreeFieldForm />);
    expect([hint('First'), hint('Second'), hint('Third')]).toEqual(['next', 'next', 'done']);
  });

  it('renumbers when a field is added after the first render', async () => {
    const { rerender } = render(<ThreeFieldForm />);
    rerender(<ThreeFieldForm extra />);
    // The observer runs as a microtask after the DOM change.
    await act(async () => {});
    expect([hint('First'), hint('Second'), hint('Third'), hint('Fourth')]).toEqual(['next', 'next', 'next', 'done']);
  });

  it('a field that names its own action key keeps it, and a textarea gets none but still counts', () => {
    function Form() {
      const flow = useFormFlow({ lastKey: 'send' });
      return (
        <form {...flow.formProps}>
          <label htmlFor="q">Search</label>
          <Input id="q" kind="search" />
          <label htmlFor="n">Name</label>
          <Input id="n" />
          <label htmlFor="t">Notes</label>
          <textarea id="t" />
          <label htmlFor="z">Last</label>
          <Input id="z" />
          <input type="checkbox" aria-label="Agree" />
          <input type="hidden" name="x" />
          <Input aria-label="Off" disabled />
        </form>
      );
    }
    render(<Form />);
    expect(hint('Search')).toBe('search');
    expect(hint('Name')).toBe('next');
    expect(hint('Notes')).toBeNull();
    expect(hint('Last')).toBe('send');
    expect(screen.getByLabelText('Agree').getAttribute('enterkeyhint')).toBeNull();
    expect(screen.getByLabelText('Off').getAttribute('enterkeyhint')).toBeNull();
  });
});

describe('the Enter key on a Next field', () => {
  it('on a touch pointer, moves to the next field and does not submit', async () => {
    setPointer(true);
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<ThreeFieldForm onSubmit={onSubmit} />);
    await user.click(screen.getByLabelText('First'));
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByLabelText('Second'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('on the last (Done) field, submits as before', async () => {
    setPointer(true);
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<ThreeFieldForm onSubmit={onSubmit} />);
    await user.click(screen.getByLabelText('Third'));
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('on a fine pointer (desktop), Enter keeps submitting the form', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<ThreeFieldForm onSubmit={onSubmit} />);
    await user.click(screen.getByLabelText('First'));
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter alone when a field handled it itself (a suggestion list picked a row)', () => {
    setPointer(true);
    function Form() {
      const flow = useFormFlow();
      return (
        <form {...flow.formProps}>
          <label htmlFor="a">First</label>
          <Input id="a" onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          <label htmlFor="b">Second</label>
          <Input id="b" />
        </form>
      );
    }
    render(<Form />);
    const first = screen.getByLabelText('First');
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(first);
  });
});

describe('errors', () => {
  function ErrorForm({ errorOn }: { errorOn: string[] }) {
    const flow = useFormFlow();
    return (
      <form {...flow.formProps}>
        <label htmlFor="a">First</label>
        <Input id="a" aria-describedby="a-hint" />
        <p id="a-hint">Hint</p>
        {errorOn.includes('a') && <p data-error-for="a">First is required</p>}
        <label htmlFor="b">Second</label>
        <Input id="b" name="b_name" />
        {errorOn.includes('b') && <p data-error-for="b_name">Second is required</p>}
        <button type="button" onClick={() => flow.focusFirstInvalid()}>Check</button>
      </form>
    );
  }

  it('links an error to its field (by id or by name) and unlinks it when it goes', async () => {
    const { rerender } = render(<ErrorForm errorOn={['a', 'b']} />);
    await act(async () => {});
    const a = screen.getByLabelText('First');
    const b = screen.getByLabelText('Second');
    expect(a).toHaveAttribute('aria-invalid', 'true');
    expect(a).toHaveAccessibleDescription('Hint First is required');
    expect(b).toHaveAttribute('aria-invalid', 'true');
    expect(b).toHaveAccessibleDescription('Second is required');

    rerender(<ErrorForm errorOn={['b']} />);
    await act(async () => {});
    expect(a).not.toHaveAttribute('aria-invalid', 'true');
    expect(a.getAttribute('aria-describedby')).toBe('a-hint');
    expect(b).toHaveAttribute('aria-invalid', 'true');
  });

  it('focusFirstInvalid focuses the first invalid field in page order and scrolls it into view', async () => {
    render(<ErrorForm errorOn={['b', 'a']} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement).toBe(screen.getByLabelText('First'));
    expect(scrollSpy).toHaveBeenCalled();
    expect(scrollSpy.mock.contexts.at(-1)).toBe(screen.getByLabelText('First'));
  });

  describe('revealAndFocus does not scroll the page when the field is already in view', () => {
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const originalElementFromPoint = document.elementFromPoint;
    afterEach(() => {
      document.elementFromPoint = originalElementFromPoint;
    });

    async function failSubmit(setup: (field: HTMLElement) => void) {
      render(<ErrorForm errorOn={['a']} />);
      await act(async () => {});
      const field = screen.getByLabelText('First');
      setup(field);
      fireEvent.click(screen.getByRole('button', { name: 'Check' }));
      await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
      expect(document.activeElement).toBe(field);
      return scrollSpy.mock.calls.at(-1)?.[0] as ScrollIntoViewOptions;
    }

    it('uses block "nearest" (a no-op) for a field fully in the viewport and not covered', async () => {
      const opts = await failSubmit((field) => {
        field.getBoundingClientRect = () => rect(100, 140);
        document.elementFromPoint = () => field;
      });
      expect(opts.block).toBe('nearest');
    });

    it('centres a field that is below the fold', async () => {
      const opts = await failSubmit((field) => {
        field.getBoundingClientRect = () => rect(window.innerHeight + 50, window.innerHeight + 90);
        document.elementFromPoint = () => field;
      });
      expect(opts.block).toBe('center');
    });

    it('centres a field that sits under a sticky bar', async () => {
      const opts = await failSubmit((field) => {
        field.getBoundingClientRect = () => rect(10, 50);
        document.elementFromPoint = () => document.body;
      });
      expect(opts.block).toBe('center');
    });

    it('centres a field clipped by its own scroller even though the viewport shows it', async () => {
      const opts = await failSubmit((field) => {
        const scroller = field.closest('form') as HTMLElement;
        scroller.style.overflowY = 'auto';
        scroller.getBoundingClientRect = () => rect(0, 100);
        field.getBoundingClientRect = () => rect(150, 190);
        document.elementFromPoint = () => field;
      });
      expect(opts.block).toBe('center');
    });
  });

  it('focusFirstInvalid waits for the errors to render (it is called before React commits them)', async () => {
    function LateForm() {
      const flow = useFormFlow();
      const [err, setErr] = React.useState(false);
      return (
        <form {...flow.formProps}>
          <label htmlFor="a">First</label>
          <Input id="a" />
          <label htmlFor="b">Second</label>
          <Input id="b" aria-invalid={err} />
          {err && <p data-error-for="b">Bad</p>}
          <button type="button" onClick={() => { setErr(true); flow.focusFirstInvalid(); }}>Go</button>
        </form>
      );
    }
    render(<LateForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.activeElement).toBe(screen.getByLabelText('Second'));
  });
});
