/**
 * Issue #372 — confirmation toasts must auto-close after a few seconds.
 *
 * The shared `toast()` factory (use-toast.ts) now schedules its own
 * duration-aware auto-dismiss timer:
 *   - no `duration`        → auto-close after TOAST_AUTO_DISMISS (4000ms)
 *   - numeric `duration`   → auto-close at that value (e.g. NotificationItem's 3000)
 *   - `duration: Infinity` → NO timer; stays sticky until manual close
 *     (SendInvoiceDialog / SendEstimateDialog / EstimateDetailPage 'Send failed')
 *
 * use-toast.ts keeps module-level state (memoryState + toastTimeouts), so each
 * test re-imports a fresh module instance via vi.resetModules().
 */
import { render, screen, act, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshToastModules() {
  vi.resetModules();
  const useToastModule = await import('@/components/ui/use-toast');
  const toasterModule = await import('@/components/ui/toaster');
  return { toast: useToastModule.toast, Toaster: toasterModule.Toaster };
}

describe('toast auto-dismiss (#372)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('auto-closes a default toast (no duration) after ~4s', async () => {
    const { toast, Toaster } = await freshToastModules();
    render(<Toaster />);

    act(() => {
      toast({ description: 'Text sent to Acme' });
    });
    expect(screen.getByText('Text sent to Acme')).toBeInTheDocument();

    // Auto-dismiss fires at 4000ms → open:false → toast leaves the DOM
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText('Text sent to Acme')).not.toBeInTheDocument();

    // After the separate TOAST_REMOVE_DELAY the toast is purged from state too
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText('Text sent to Acme')).not.toBeInTheDocument();
  });

  it('REGRESSION GUARD: duration: Infinity toasts stay sticky (never auto-close)', async () => {
    const { toast, Toaster } = await freshToastModules();
    render(<Toaster />);

    act(() => {
      toast({ description: 'Send failed', duration: Infinity });
    });
    expect(screen.getByText('Send failed')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByText('Send failed')).toBeInTheDocument();
  });

  it('honors a shorter per-toast duration override (3000ms)', async () => {
    const { toast, Toaster } = await freshToastModules();
    render(<Toaster />);

    act(() => {
      toast({ description: 'Done', duration: 3000 });
    });

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.getByText('Done')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('manual dismiss before the auto-timer closes immediately with no later side effect', async () => {
    const { toast, Toaster } = await freshToastModules();
    render(<Toaster />);

    let handle!: ReturnType<typeof toast>;
    act(() => {
      handle = toast({ description: 'Text sent to Acme' });
    });
    expect(screen.getByText('Text sent to Acme')).toBeInTheDocument();

    act(() => {
      handle.dismiss();
    });
    expect(screen.queryByText('Text sent to Acme')).not.toBeInTheDocument();

    // Advancing past the auto-dismiss window must not throw or resurrect anything
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.queryByText('Text sent to Acme')).not.toBeInTheDocument();
  });
});
