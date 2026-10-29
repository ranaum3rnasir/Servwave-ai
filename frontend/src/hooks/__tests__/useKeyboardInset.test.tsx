// Mobile slice 54: ONE app-level hook reads the visual viewport and publishes the keyboard overlap
// and the visible height as CSS variables. These tests stub the visual viewport (jsdom has none).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';

import { computeKeyboardMetrics } from '@/lib/keyboardInset';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';

type FakeViewport = EventTarget & { height: number; offsetTop: number; scale: number };

function installViewport(init: { inner: number; width?: number; height: number; offsetTop?: number; scale?: number }) {
  const vv = Object.assign(new EventTarget(), {
    height: init.height,
    offsetTop: init.offsetTop ?? 0,
    scale: init.scale ?? 1,
  }) as FakeViewport;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: init.inner });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: init.width ?? 390 });
  return vv;
}

function setInnerHeight(value: number) {
  (window as unknown as { innerHeight: number }).innerHeight = value;
}

const root = () => document.documentElement.style;

beforeEach(() => {
  root().removeProperty('--keyboard-inset');
  root().removeProperty('--visible-height');
  root().removeProperty('--keyboard-open');
});
afterEach(() => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  (document.activeElement as HTMLElement | null)?.blur();
  document.body.innerHTML = '';
});

describe('computeKeyboardMetrics', () => {
  const base = { layoutHeight: 800, baselineHeight: 800, vvHeight: 800, vvOffsetTop: 0, vvScale: 1, editableFocused: true };

  it('is the gap under the visual viewport when the keyboard overlays the page', () => {
    expect(computeKeyboardMetrics({ ...base, vvHeight: 500 })).toEqual({ inset: 300, visibleHeight: 500, open: true });
  });

  it('counts a visual viewport that has panned down', () => {
    expect(computeKeyboardMetrics({ ...base, vvHeight: 450, vvOffsetTop: 50 })).toMatchObject({ inset: 300 });
  });

  it('is zero when the layout viewport itself shrank (the layout is already above the keyboard)', () => {
    const m = computeKeyboardMetrics({ ...base, layoutHeight: 500, vvHeight: 500 });
    expect(m.inset).toBe(0);
    expect(m.visibleHeight).toBe(500);
    // ...but the keyboard is still known to be open, from the shrink plus a focused field.
    expect(m.open).toBe(true);
  });

  it('does not take a shrunk window with nothing focused for a keyboard', () => {
    expect(computeKeyboardMetrics({ ...base, layoutHeight: 500, vvHeight: 500, editableFocused: false }).open).toBe(false);
  });

  it('treats browser chrome (under 150 px) as no keyboard', () => {
    expect(computeKeyboardMetrics({ ...base, vvHeight: 720 })).toEqual({ inset: 0, visibleHeight: 720, open: false });
  });

  it('ignores a pinch zoom, which also shrinks the visual viewport', () => {
    expect(computeKeyboardMetrics({ ...base, vvHeight: 400, vvScale: 2 })).toEqual({ inset: 0, visibleHeight: 400, open: false });
  });
});

describe('useKeyboardInset', () => {
  it('publishes zero overlap and the full height before any keyboard', () => {
    installViewport({ inner: 800, height: 800 });
    renderHook(() => useKeyboardInset());
    expect(root().getPropertyValue('--keyboard-inset')).toBe('0px');
    expect(root().getPropertyValue('--visible-height')).toBe('800px');
    expect(root().getPropertyValue('--keyboard-open')).toBe('0');
  });

  it('publishes the overlap and the visible height when the visual viewport shrinks', () => {
    const vv = installViewport({ inner: 800, height: 800 });
    renderHook(() => useKeyboardInset());
    act(() => {
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(root().getPropertyValue('--keyboard-inset')).toBe('300px');
    expect(root().getPropertyValue('--visible-height')).toBe('500px');
    expect(root().getPropertyValue('--keyboard-open')).toBe('1');
    act(() => {
      vv.height = 800;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(root().getPropertyValue('--keyboard-inset')).toBe('0px');
    expect(root().getPropertyValue('--keyboard-open')).toBe('0');
  });

  it('reports zero overlap when the layout viewport shrank with it (resizes-content mode)', () => {
    const vv = installViewport({ inner: 800, height: 800 });
    renderHook(() => useKeyboardInset());
    act(() => {
      setInnerHeight(500);
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(root().getPropertyValue('--keyboard-inset')).toBe('0px');
    expect(root().getPropertyValue('--visible-height')).toBe('500px');
  });

  it('follows a visual viewport that scrolls under the keyboard', () => {
    const vv = installViewport({ inner: 800, height: 500 });
    renderHook(() => useKeyboardInset());
    expect(root().getPropertyValue('--keyboard-inset')).toBe('300px');
    act(() => {
      vv.offsetTop = 40;
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(root().getPropertyValue('--keyboard-inset')).toBe('260px');
  });

  it('removes every listener and its variables on unmount', () => {
    const vv = installViewport({ inner: 800, height: 500 });
    const vvAdd = vi.spyOn(vv, 'addEventListener');
    const vvRemove = vi.spyOn(vv, 'removeEventListener');
    const winAdd = vi.spyOn(window, 'addEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useKeyboardInset());
    expect(vvAdd).toHaveBeenCalled();
    unmount();
    const types = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).sort();
    expect(types(vvRemove)).toEqual(types(vvAdd));
    // The window gets other listeners from React and the test library; ours are matched by type.
    for (const type of ['resize', 'focusin', 'focusout']) {
      expect(winRemove.mock.calls.filter((c) => c[0] === type).length)
        .toBe(winAdd.mock.calls.filter((c) => c[0] === type).length);
    }
    expect(root().getPropertyValue('--keyboard-inset')).toBe('');
    expect(root().getPropertyValue('--visible-height')).toBe('');
  });

  it('publishes a zero overlap where the visual viewport API is missing', () => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 700 });
    renderHook(() => useKeyboardInset());
    expect(root().getPropertyValue('--keyboard-inset')).toBe('0px');
    expect(root().getPropertyValue('--visible-height')).toBe('700px');
  });
});

describe('useKeyboardOpen on a layout that resizes with the keyboard', () => {
  function Probe({ out }: { out: { open?: boolean } }) {
    out.open = useKeyboardOpen();
    return null;
  }

  it('is true when the layout viewport shrank under a focused field', () => {
    const vv = installViewport({ inner: 800, height: 800 });
    const out: { open?: boolean } = {};
    render(<Probe out={out} />);
    expect(out.open).toBe(false);
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    act(() => {
      setInnerHeight(480);
      vv.height = 480;
      vv.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(out.open).toBe(true);
    act(() => {
      setInnerHeight(800);
      vv.height = 800;
      vv.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(out.open).toBe(false);
  });
});
