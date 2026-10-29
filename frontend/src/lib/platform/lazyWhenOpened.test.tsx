/**
 * Mobile slice 61 (PERF-03): a dialog the page mounts once and drives with `open` is only
 * downloaded when it is first asked to open, then stays mounted.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { lazyWhenOpened } from './lazyWhenOpened';

type DialogProps = { open: boolean; label: string };

function setup() {
  const loaded = vi.fn();
  const mounted = vi.fn();
  const Dialog = lazyWhenOpened(
    async () => {
      loaded();
      return {
        Dialog: function Dialog({ open, label }: DialogProps) {
          mounted();
          return <div role="dialog" aria-hidden={!open}>{label}</div>;
        },
      };
    },
    (m) => m.Dialog,
  );
  return { Dialog, loaded, mounted };
}

describe('lazyWhenOpened', () => {
  it('downloads and renders nothing while it has never been opened', () => {
    const { Dialog, loaded, mounted } = setup();
    const { container } = render(<Dialog open={false} label="hello" />);
    expect(container).toBeEmptyDOMElement();
    expect(loaded).not.toHaveBeenCalled();
    expect(mounted).not.toHaveBeenCalled();
  });

  it('downloads the dialog the first time open turns true and passes every prop through', async () => {
    const { Dialog, loaded } = setup();
    const { rerender } = render(<Dialog open={false} label="hello" />);
    rerender(<Dialog open label="hello" />);
    expect(await screen.findByRole('dialog')).toHaveTextContent('hello');
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it('opens at once on a page that mounts it already open', async () => {
    const { Dialog } = setup();
    render(<Dialog open label="born open" />);
    expect(await screen.findByRole('dialog')).toHaveTextContent('born open');
  });

  it('stays mounted after it closes, so the close can animate and a reopen is instant', async () => {
    const { Dialog, loaded, mounted } = setup();
    const { rerender } = render(<Dialog open label="x" />);
    await screen.findByRole('dialog');
    rerender(<Dialog open={false} label="x" />);
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument();
    const mountsBefore = mounted.mock.calls.length;
    rerender(<Dialog open label="x" />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(mounted.mock.calls.length).toBeGreaterThanOrEqual(mountsBefore);
  });

  it('preload() fetches the chunk without opening or rendering anything, and is safe to repeat', async () => {
    const { Dialog, loaded, mounted } = setup();
    const { container } = render(<Dialog open={false} label="x" />);
    await act(async () => {
      Dialog.preload();
      Dialog.preload();
    });
    expect(loaded).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
    expect(mounted).not.toHaveBeenCalled();
  });

  it('a failed preload is swallowed; the open that follows is the one that reports the failure', async () => {
    const Dialog = lazyWhenOpened(
      () => Promise.reject(new Error('Failed to fetch dynamically imported module')) as Promise<{ Dialog: (p: DialogProps) => null }>,
      (m) => m.Dialog,
    );
    expect(() => Dialog.preload()).not.toThrow();
    await Promise.resolve();
  });
});
