/**
 * Mobile slice 43: nothing discards half-filled work without asking.
 *
 * Three layers, each pinned on its own: the pure machine (every dismissal path, clean and dirty),
 * the hook that drives it (what the user is shown, what is closed), and the shared unsaved-work
 * signal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { decideDismissal, type Dismissal } from '@/ui-kit/lib/dirtyGuard';
import { useDirtyGuard } from '@/ui-kit/hooks/useDirtyGuard';
import { DiscardConfirm } from '@/ui-kit/components/ui/discardConfirm';
import { hasUnsavedWork, useHasUnsavedWork } from '@/ui-kit/lib/unsavedWork';

const LEAVING: Dismissal[] = ['outside', 'escape', 'swipe', 'close', 'navigation'];

describe('decideDismissal (the pure machine)', () => {
  it.each(LEAVING)('%s closes a clean overlay', (path) => {
    expect(decideDismissal(path, false)).toBe('close');
  });

  it.each(LEAVING)('%s asks first when the overlay is dirty', (path) => {
    expect(decideDismissal(path, true)).toBe('confirm');
  });

  it('a viewport resize is ignored, clean or dirty', () => {
    expect(decideDismissal('resize', false)).toBe('ignore');
    expect(decideDismissal('resize', true)).toBe('ignore');
  });
});

describe('useDirtyGuard', () => {
  // Taking the Back marker off is a real history pop (async in jsdom): unmount here, and let the
  // pop land BEFORE the next test starts. (Left to the automatic cleanup it landed inside the next
  // test, where the guard mistook it for the user pressing Back and the Back test passed on that.)
  afterEach(async () => {
    vi.restoreAllMocks();
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it('closes straight away when clean', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDirtyGuard({ dirty: false, onClose }));
    act(() => result.current.onOpenChange(false));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.confirmOpen).toBe(false);
  });

  it('holds a dirty overlay open and asks; Keep editing leaves it alone', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDirtyGuard({ dirty: true, onClose }));
    act(() => result.current.onOpenChange(false));
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.confirmOpen).toBe(true);
    act(() => result.current.keepEditing());
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.confirmOpen).toBe(false);
  });

  it('Discard closes, and runs the navigation that asked', () => {
    const onClose = vi.fn();
    const go = vi.fn();
    const { result } = renderHook(() => useDirtyGuard({ dirty: true, onClose }));
    act(() => {
      result.current.requestDismiss('navigation', go);
    });
    expect(go).not.toHaveBeenCalled();
    act(() => result.current.discard());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('a resize does nothing even when dirty: no prompt, no close', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDirtyGuard({ dirty: true, onClose }));
    act(() => {
      expect(result.current.requestDismiss('resize')).toBe('ignore');
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.confirmOpen).toBe(false);
  });

  it('closeNow (a save) closes a dirty overlay without asking', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDirtyGuard({ dirty: true, onClose }));
    act(() => result.current.closeNow());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.confirmOpen).toBe(false);
  });

  it('the Back button asks instead of leaving, and Discard then closes', async () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDirtyGuard({ dirty: true, onClose }));
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(result.current.confirmOpen).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    act(() => result.current.discard());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks the browser to confirm a reload only while dirty', () => {
    const clean = renderHook(() => useDirtyGuard({ dirty: false, onClose: vi.fn() }));
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
    clean.unmount();

    const dirty = renderHook(() => useDirtyGuard({ dirty: true, onClose: vi.fn() }));
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    dirty.unmount();
  });
});

describe('the unsaved-work signal', () => {
  it('is raised while an overlay is dirty and cleared when it is not', () => {
    expect(hasUnsavedWork()).toBe(false);
    const { rerender, unmount } = renderHook(
      ({ dirty }) => {
        useDirtyGuard({ dirty, onClose: () => {} });
        return useHasUnsavedWork();
      },
      { initialProps: { dirty: false } },
    );
    expect(hasUnsavedWork()).toBe(false);
    rerender({ dirty: true });
    expect(hasUnsavedWork()).toBe(true);
    rerender({ dirty: false });
    expect(hasUnsavedWork()).toBe(false);
    rerender({ dirty: true });
    unmount();
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe('DiscardConfirm', () => {
  it('is a kit dialog with Keep editing and Discard, and no vendor names', async () => {
    const user = userEvent.setup();
    const onKeepEditing = vi.fn();
    const onDiscard = vi.fn();
    render(<DiscardConfirm open onKeepEditing={onKeepEditing} onDiscard={onDiscard} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ctm|calltracking|supabase|render|vercel/i);
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onKeepEditing).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
