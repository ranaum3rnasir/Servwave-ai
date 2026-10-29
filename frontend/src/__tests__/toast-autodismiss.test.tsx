/**
 * Issue #372 - confirmation toasts must auto-close after a few seconds.
 *
 * The shared `toast()` factory (use-toast.ts) is now an adapter onto the one surviving toaster
 * (mobile slice 27), which owns the timer:
 *   - no `duration`        -> auto-close after the toaster default (4000ms)
 *   - numeric `duration`   -> auto-close at that value (e.g. NotificationItem's 3000)
 *   - `duration: Infinity` -> NO timer; stays sticky until manual close
 *     (SendInvoiceDialog / SendEstimateDialog / EstimateDetailPage 'Send failed')
 *
 * sonner mounts a toast a tick after the call and plays a short exit animation, so the
 * boundaries below are a few hundred ms wide rather than exact to the millisecond.
 */
import { render, screen, act, cleanup } from '@testing-library/react';
import { toast as sonnerToast } from 'sonner';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { toast } from '@/components/ui/use-toast';
import { Toaster } from '@/ui-kit/components/ui/sonner';

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('toast auto-dismiss (#372)', () => {
  beforeEach(() => {
    // sonner's programmatic dismiss waits one animation frame, so fake that clock too.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
  });

  afterEach(() => {
    act(() => {
      sonnerToast.dismiss();
    });
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('auto-closes a default toast (no duration) after ~4s', async () => {
    render(<Toaster />);
    act(() => {
      toast({ description: 'Text sent to Acme' });
    });
    await advance(100);
    expect(screen.getByText('Text sent to Acme')).toBeInTheDocument();

    await advance(3500);
    expect(screen.getByText('Text sent to Acme')).toBeInTheDocument();

    await advance(1500);
    expect(screen.queryByText('Text sent to Acme')).not.toBeInTheDocument();
  });

  it('REGRESSION GUARD: duration: Infinity toasts stay sticky (never auto-close)', async () => {
    render(<Toaster />);
    act(() => {
      toast({ description: 'Send failed', duration: Infinity });
    });
    await advance(100);
    expect(screen.getByText('Send failed')).toBeInTheDocument();

    await advance(20000);
    expect(screen.getByText('Send failed')).toBeInTheDocument();
  });

  it('honors a shorter per-toast duration override (3000ms)', async () => {
    render(<Toaster />);
    act(() => {
      toast({ description: 'Done', duration: 3000 });
    });
    await advance(100);

    await advance(2500);
    expect(screen.getByText('Done')).toBeInTheDocument();

    await advance(1500);
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('manual dismiss before the auto-timer closes immediately with no later side effect', async () => {
    render(<Toaster />);
    let handle!: ReturnType<typeof toast>;
    act(() => {
      handle = toast({ description: 'Text sent to Acme' });
    });
    await advance(100);
    expect(screen.getByText('Text sent to Acme')).toBeInTheDocument();

    act(() => {
      handle.dismiss();
    });
    // Two steps: the frame that delivers the dismiss, then the exit animation it starts.
    await advance(100);
    await advance(1000);
    expect(screen.queryByText('Text sent to Acme')).not.toBeInTheDocument();

    // Advancing past the auto-dismiss window must not throw or resurrect anything
    await advance(10000);
    expect(screen.queryByText('Text sent to Acme')).not.toBeInTheDocument();
  });
});
