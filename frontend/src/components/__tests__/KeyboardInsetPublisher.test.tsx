// Mobile slice 54 (CI fix): the app mounts the keyboard-inset hook through a lazily loaded component, so
// the hook's code stays out of the staff app's entry bundle (which has a hard size ceiling at build).
// This proves that component does the same job as mounting the hook directly, and removes it on unmount.
import { afterEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';

import KeyboardInsetPublisher from '@/components/KeyboardInsetPublisher';

type FakeViewport = EventTarget & { height: number; offsetTop: number; scale: number };

function installViewport(height: number, inner: number) {
  const vv = Object.assign(new EventTarget(), { height, offsetTop: 0, scale: 1 }) as FakeViewport;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: inner });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
  return vv;
}

const root = () => document.documentElement.style;

afterEach(() => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  root().removeProperty('--keyboard-inset');
  root().removeProperty('--visible-height');
  root().removeProperty('--keyboard-open');
});

describe('KeyboardInsetPublisher', () => {
  it('renders nothing and publishes the keyboard variables on the document root', () => {
    const vv = installViewport(800, 800);
    const { container, unmount } = render(<KeyboardInsetPublisher />);
    expect(container.firstChild).toBeNull();
    expect(root().getPropertyValue('--keyboard-inset')).toBe('0px');
    expect(root().getPropertyValue('--visible-height')).toBe('800px');

    vv.height = 500;
    act(() => {
      vv.dispatchEvent(new Event('resize'));
    });
    expect(root().getPropertyValue('--keyboard-inset')).toBe('300px');
    expect(root().getPropertyValue('--keyboard-open')).toBe('1');

    unmount();
    expect(root().getPropertyValue('--keyboard-inset')).toBe('');
  });
});
