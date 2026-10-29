import { afterEach, describe, expect, it, vi } from 'vitest';

import { isModalOpen, subscribeModalOpen } from './modalOpen';

afterEach(() => {
  document.body.removeAttribute('data-scroll-locked');
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
});

describe('isModalOpen', () => {
  it('is false on a plain page', () => {
    expect(isModalOpen()).toBe(false);
  });

  it('is true while a Radix modal has locked scroll or made the page inert', () => {
    document.body.setAttribute('data-scroll-locked', '1');
    expect(isModalOpen()).toBe(true);
    document.body.removeAttribute('data-scroll-locked');
    document.body.style.pointerEvents = 'none';
    expect(isModalOpen()).toBe(true);
  });

  it('is true while a hand-built overlay holds the body scroll lock', () => {
    document.body.style.overflow = 'hidden';
    expect(isModalOpen()).toBe(true);
  });
});

describe('subscribeModalOpen', () => {
  it('tells the listener when the lock marks change, and stops after unsubscribe', async () => {
    const listener = vi.fn();
    const off = subscribeModalOpen(listener);
    document.body.style.pointerEvents = 'none';
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    document.body.style.pointerEvents = '';
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });
});
