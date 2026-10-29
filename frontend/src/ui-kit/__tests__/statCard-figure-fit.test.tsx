import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatCard } from '@/ui-kit/components/data/statCard';

/**
 * Mobile slice F03a: a KPI figure never breaks inside the number.
 *
 * Slice 03 put two tiles in a 320 px row and gave the value
 * `overflow-wrap: anywhere`, so "$94,760.21" read "$94,760." on one line and
 * "21" on the next. A figure now stays on one line, and when it is wider than
 * its tile it is set smaller until it fits (never below a readable floor), so
 * it is neither broken nor cut off by the tile's overflow-hidden.
 *
 * jsdom has no layout, so the geometry is supplied: a figure's width is
 * 0.6 em per character at its current font size, and the tile gives each
 * figure TILE_W px. The real-browser proof at 320/360/393/838/768/1280 with
 * five- to eight-figure sums is e2e/mobile/kpi-figures.spec.ts.
 */

const CSS_PX: Record<string, number> = { 'stat-card-value': 24, 'stat-card-detail': 12.5 };
let tileW = 110;
let restore: Array<() => void> = [];
const observers: Array<{ cb: ResizeObserverCallback; els: Element[] }> = [];

function stub<T extends object, K extends keyof T>(target: T, key: K, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<PropertyKey, unknown>)[key as PropertyKey];
  });
}

const slotOf = (el: Element) => el.getAttribute('data-slot') ?? '';
const isFigure = (el: Element) => slotOf(el) in CSS_PX;
const fontPx = (el: HTMLElement) => parseFloat(el.style.fontSize) || CSS_PX[slotOf(el)]!;

beforeEach(() => {
  tileW = 110;
  stub(HTMLElement.prototype, 'clientWidth', {
    get(this: HTMLElement) { return isFigure(this) ? tileW : 0; },
  });
  stub(HTMLElement.prototype, 'scrollWidth', {
    get(this: HTMLElement) {
      if (!isFigure(this)) return 0;
      // Text that fits reports the box's width, as a browser does.
      return Math.max(tileW, Math.ceil((this.textContent ?? '').length * fontPx(this) * 0.6));
    },
  });
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  stub(window, 'getComputedStyle', {
    value(el: Element, pseudo?: string | null) {
      const real = realGetComputedStyle(el, pseudo);
      if (!isFigure(el)) return real;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'fontSize') return `${fontPx(el as HTMLElement)}px`;
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  });
  const RealRO = globalThis.ResizeObserver;
  class RecordingRO {
    entry: { cb: ResizeObserverCallback; els: Element[] };
    constructor(cb: ResizeObserverCallback) { this.entry = { cb, els: [] }; observers.push(this.entry); }
    observe(el: Element) { this.entry.els.push(el); }
    unobserve() {}
    disconnect() { this.entry.els = []; }
  }
  globalThis.ResizeObserver = RecordingRO as unknown as typeof ResizeObserver;
  restore.push(() => { globalThis.ResizeObserver = RealRO; observers.length = 0; });
});

afterEach(() => {
  restore.reverse().forEach((undo) => undo());
  restore = [];
});

/** What a browser would do when the tile changes width: tell every observer. */
function resizeTiles(width: number) {
  tileW = width;
  act(() => {
    for (const o of observers) {
      if (o.els.length) o.cb(o.els.map((target) => ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry), {} as ResizeObserver);
    }
  });
}

const fits = (el: HTMLElement) => el.scrollWidth <= el.clientWidth;

function figures(container: HTMLElement) {
  return {
    value: container.querySelector<HTMLElement>('[data-slot="stat-card-value"]')!,
    detail: container.querySelector<HTMLElement>('[data-slot="stat-card-detail"]'),
  };
}

describe('KPI figures on a narrow tile', () => {
  it('never breaks inside the number: the value and its second figure stay on one line', () => {
    const { container } = render(<StatCard label="Draft" value="$94,760.21" detail="$84,911.57" />);
    const { value, detail } = figures(container);

    for (const el of [value, detail!]) {
      const classes = el.className.split(/\s+/);
      expect(classes).toContain('whitespace-nowrap');
      expect(classes).not.toContain('[overflow-wrap:anywhere]');
      expect(classes).not.toContain('break-all');
    }
  });

  it('sets a figure wider than its tile smaller until it fits, and gives a short one back its full size', () => {
    const { container, rerender } = render(<StatCard label="Overdue" value="$1,234,567.89" />);
    const { value } = figures(container);

    expect(fits(value)).toBe(true);
    expect(fontPx(value)).toBeLessThan(24);
    expect(fontPx(value)).toBeGreaterThanOrEqual(12);

    rerender(<StatCard label="Overdue" value="$94" />);
    expect(value.style.fontSize).toBe('');
    expect(fits(value)).toBe(true);
  });

  it('fits the second figure under the value too', () => {
    const { container } = render(<StatCard label="Won" value={2210} detail="$123,456,789.01" />);
    const { detail } = figures(container);

    expect(fits(detail!)).toBe(true);
    expect(fontPx(detail!)).toBeLessThan(12.5);
  });

  it('stops at a readable floor instead of shrinking to nothing', () => {
    const { container } = render(<StatCard label="Collected" value="$123,456,789,012,345,678.90" />);

    expect(figures(container).value.style.fontSize).toBe('12px');
  });

  it('fits again when the tile changes width (rotation, a resized window)', () => {
    const { container } = render(<StatCard label="Due" value="$94,760.21" />);
    const { value } = figures(container);
    resizeTiles(240);
    expect(value.style.fontSize).toBe('');

    resizeTiles(100);
    expect(fits(value)).toBe(true);
    expect(fontPx(value)).toBeLessThan(24);
  });
});
