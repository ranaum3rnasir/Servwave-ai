/**
 * Mobile slice 34 (SCR-01): the shell's one page scroller.
 *
 * The shell's <main> outlives every route change, so its scrollTop used to carry over to the next
 * page: a forward navigation opened the new page part-way down, and Back landed wherever the last
 * page left the scroller. The rule: a forward navigation (PUSH) opens at the top, Back and
 * Forward (POP) restore the position that history entry had when it was left.
 */
import { act, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellScroll } from '../useShellScroll';

type Navigate = ReturnType<typeof useNavigate>;
const nav: { current: Navigate | null } = { current: null };
const go: Navigate = ((...args: unknown[]) => (nav.current as unknown as (...a: unknown[]) => void)(...args)) as Navigate;

function Harness() {
  const ref = useRef<HTMLElement>(null);
  useShellScroll(ref);
  const navigate = useNavigate();
  useEffect(() => { nav.current = navigate; }, [navigate]);
  return <main ref={ref} data-testid="scroller" />;
}

/** jsdom has no layout: give the element a writable scrollTop that can only reach `reach.max`. */
function mount() {
  const utils = render(
    <MemoryRouter initialEntries={['/list']}>
      <Harness />
    </MemoryRouter>,
  );
  const el = utils.getByTestId('scroller');
  const state = { top: 0, max: 5000 };
  Object.defineProperty(el, 'scrollTop', {
    get: () => state.top,
    set: (v: number) => { state.top = Math.max(0, Math.min(v, state.max)); },
    configurable: true,
  });
  const userScrollTo = (v: number) => { state.top = v; el.dispatchEvent(new Event('scroll')); };
  return { el, state, userScrollTo };
}

const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('useShellScroll', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens a page reached by a forward navigation at the top', async () => {
    const { el, userScrollTo } = mount();
    userScrollTo(700);
    expect(el.scrollTop).toBe(700);
    act(() => { go('/detail'); });
    await wait(100);
    expect(el.scrollTop).toBe(0);
  });

  it('keeps the position on a forward navigation that changes only the query string (a tab, chip or filter)', async () => {
    const { el, userScrollTo } = mount();
    userScrollTo(700);
    act(() => { go('/list?tab=2'); });
    await wait(100);
    expect(el.scrollTop).toBe(700);
    act(() => { go('/list?tab=2&chip=attention'); });
    await wait(100);
    expect(el.scrollTop).toBe(700);
    act(() => { go('/elsewhere'); });
    await wait(100);
    expect(el.scrollTop).toBe(0);
  });

  it('puts Back and Forward at the position each entry was left at', async () => {
    const { el, userScrollTo } = mount();
    userScrollTo(700);
    act(() => { go('/detail'); });
    await wait(100);
    userScrollTo(120);
    act(() => { go(-1); });
    await wait(100);
    expect(el.scrollTop).toBe(700);
    act(() => { go(1); });
    await wait(100);
    expect(el.scrollTop).toBe(120);
  });

  it('leaves a replaced entry on the same path where it is, but a redirect to another path starts at the top', async () => {
    const { el, userScrollTo } = mount();
    userScrollTo(300);
    act(() => { go('/list?tab=2', { replace: true }); });
    await wait(100);
    expect(el.scrollTop).toBe(300);
    act(() => { go('/other', { replace: true }); });
    await wait(100);
    expect(el.scrollTop).toBe(0);
  });

  it('keeps trying to restore while the page it came back to is still loading', async () => {
    const { el, state, userScrollTo } = mount();
    userScrollTo(900);
    act(() => { go('/detail'); });
    await wait(100);
    state.max = 200; // the list is short while its data loads
    act(() => { go(-1); });
    await wait(50);
    expect(el.scrollTop).toBe(200);
    state.max = 5000; // the rows arrive
    await wait(300);
    expect(el.scrollTop).toBe(900);
  });

  it('stops restoring the moment the user touches the scroller', async () => {
    const { el, state, userScrollTo } = mount();
    userScrollTo(900);
    act(() => { go('/detail'); });
    await wait(100);
    state.max = 200;
    act(() => { go(-1); });
    await wait(50);
    act(() => { el.dispatchEvent(new Event('touchstart')); });
    state.top = 50;
    state.max = 5000;
    await wait(300);
    expect(el.scrollTop).toBe(50);
  });
});
