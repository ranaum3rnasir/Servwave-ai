/**
 * useConfirm - the promise contract every ConfirmDialog call site now depends on.
 *
 * These test the HOOK, not any one caller: the whole point of the sweep is that 16 sites share one
 * settlement behaviour. The cases that matter are the ones where a promise could silently never
 * settle, because an unsettled promise hangs the caller's handler with no error anywhere.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfirm, type ConfirmOptions } from '@/hooks/useConfirm';

/** Harness: a button that runs `confirm` and records what the promise resolved to. */
function Harness({ options, onResult }: { options: ConfirmOptions; onResult: (ok: boolean) => void }) {
  const { confirm, confirmDialog } = useConfirm();
  return (
    <>
      <button onClick={async () => onResult(await confirm(options))}>Run</button>
      {confirmDialog}
    </>
  );
}

const OPTS: ConfirmOptions = {
  title: 'Delete this attachment?',
  description: 'This cannot be undone.',
  confirmLabel: 'Delete',
  tone: 'danger',
};

describe('useConfirm', () => {
  it('renders nothing until confirm() is called', () => {
    render(<Harness options={OPTS} onResult={vi.fn()} />);

    expect(screen.queryByText('Delete this attachment?')).toBeNull();
  });

  it('shows the app dialog with the supplied copy, not a browser prompt', async () => {
    const user = userEvent.setup();
    render(<Harness options={OPTS} onResult={vi.fn()} />);

    await user.click(screen.getByText('Run'));

    expect(await screen.findByText('Delete this attachment?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('resolves true when confirmed, and closes', async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<Harness options={OPTS} onResult={onResult} />);

    await user.click(screen.getByText('Run'));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByText('Delete this attachment?')).toBeNull());
  });

  it('resolves false when cancelled', async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<Harness options={OPTS} onResult={onResult} />);

    await user.click(screen.getByText('Run'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('resolves false when dismissed with Escape - a dismissal is a decline, never a hang', async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<Harness options={OPTS} onResult={onResult} />);

    await user.click(screen.getByText('Run'));
    await screen.findByText('Delete this attachment?');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('settles a superseded prompt rather than orphaning it', async () => {
    // NOT driven through two user clicks: Radix puts `pointer-events: none` on the background
    // while the dialog is open, so a user physically cannot raise a second prompt. The hazard is
    // reachable only from code - two overlapping async flows - so the harness models that
    // directly by firing both confirms from one handler without awaiting the first.
    const onResult = vi.fn();
    function DoubleHarness() {
      const { confirm, confirmDialog } = useConfirm();
      return (
        <>
          <button
            onClick={() => {
              void confirm({ ...OPTS, title: 'First' }).then((ok) => onResult(ok));
              void confirm({ ...OPTS, title: 'Second' }).then((ok) => onResult(ok));
            }}
          >
            Run
          </button>
          {confirmDialog}
        </>
      );
    }
    const user = userEvent.setup();
    render(<DoubleHarness />);

    await user.click(screen.getByText('Run'));

    // The first promise must settle (declined) rather than hang forever.
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    // ...and the surviving prompt is the second one, still answerable.
    expect(await screen.findByText('Second')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it('can be reopened after being answered', async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<Harness options={OPTS} onResult={onResult} />);

    await user.click(screen.getByText('Run'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));

    await user.click(screen.getByText('Run'));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });
});
