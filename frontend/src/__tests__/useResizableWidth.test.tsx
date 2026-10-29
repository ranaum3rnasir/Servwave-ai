import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResizableWidth } from '../hooks/useResizableWidth';

const STORAGE_KEY = 'test-sidebar-width';
const OPTS = { storageKey: STORAGE_KEY, defaultWidth: 240, min: 180, max: 420 };

function mousedown(clientX: number) {
  return {
    clientX,
    preventDefault: vi.fn(),
  } as unknown as React.MouseEvent;
}

// Queued rAF mock — mirrors real async semantics (the id is assigned before
// the callback runs) while letting tests flush frames deterministically.
let rafQueue: FrameRequestCallback[] = [];
function flushFrames() {
  const queue = rafQueue;
  rafQueue = [];
  queue.forEach((cb) => cb(0));
}

function moveTo(clientX: number) {
  document.dispatchEvent(new MouseEvent('mousemove', { clientX }));
  flushFrames();
}

function mouseup(clientX: number) {
  document.dispatchEvent(new MouseEvent('mouseup', { clientX }));
}

describe('useResizableWidth', () => {
  beforeEach(() => {
    localStorage.clear();
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('returns defaultWidth when localStorage is empty', () => {
    const { result } = renderHook(() => useResizableWidth(OPTS));
    expect(result.current.width).toBe(240);
  });

  it('restores a saved in-range value from the storage key', () => {
    localStorage.setItem(STORAGE_KEY, '320');
    const { result } = renderHook(() => useResizableWidth(OPTS));
    expect(result.current.width).toBe(320);
  });

  it('clamps a saved out-of-range value', () => {
    localStorage.setItem(STORAGE_KEY, '900');
    const high = renderHook(() => useResizableWidth(OPTS));
    expect(high.result.current.width).toBe(420);
    high.unmount();

    localStorage.setItem(STORAGE_KEY, '50');
    const low = renderHook(() => useResizableWidth(OPTS));
    expect(low.result.current.width).toBe(180);
  });

  it('falls back to defaultWidth on a corrupted stored value', () => {
    localStorage.setItem(STORAGE_KEY, 'garbage');
    const { result } = renderHook(() => useResizableWidth(OPTS));
    expect(result.current.width).toBe(240);
  });

  it('updates width during drag (mousemove after startResize)', () => {
    const { result } = renderHook(() => useResizableWidth(OPTS));
    act(() => {
      result.current.startResize(mousedown(300));
    });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    act(() => {
      moveTo(360);
    });
    expect(result.current.width).toBe(300); // 240 + 60
    act(() => {
      mouseup(360);
    });
  });

  it('clamps width during drag', () => {
    const { result } = renderHook(() => useResizableWidth(OPTS));
    act(() => {
      result.current.startResize(mousedown(300));
    });
    act(() => {
      moveTo(900);
    });
    expect(result.current.width).toBe(420);
    act(() => {
      moveTo(-500);
    });
    expect(result.current.width).toBe(180);
    act(() => {
      mouseup(-500);
    });
  });

  it('mouseup persists the final width, restores body styles, and detaches listeners', () => {
    const { result } = renderHook(() => useResizableWidth(OPTS));
    act(() => {
      result.current.startResize(mousedown(300));
    });
    act(() => {
      moveTo(360);
    });
    act(() => {
      mouseup(360);
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('300');
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    // Further mousemoves after mouseup must not change the width.
    act(() => {
      moveTo(500);
    });
    expect(result.current.width).toBe(300);
  });

  it('a second drag starts from the width the first drag ended at (no stale closure)', () => {
    const { result } = renderHook(() => useResizableWidth(OPTS));
    // Drag 1: 240 → 300
    act(() => {
      result.current.startResize(mousedown(300));
    });
    act(() => {
      moveTo(360);
    });
    act(() => {
      mouseup(360);
    });
    expect(result.current.width).toBe(300);
    // Drag 2: must start from 300, not snap back to 240.
    act(() => {
      result.current.startResize(mousedown(300));
    });
    act(() => {
      moveTo(340);
    });
    expect(result.current.width).toBe(340); // 300 + 40, NOT 280 (240 + 40)
    act(() => {
      mouseup(340);
    });
  });

  it('unmount mid-drag restores body cursor/userSelect and detaches listeners', () => {
    const { result, unmount } = renderHook(() => useResizableWidth(OPTS));
    act(() => {
      result.current.startResize(mousedown(300));
    });
    expect(document.body.style.cursor).toBe('col-resize');
    unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});
