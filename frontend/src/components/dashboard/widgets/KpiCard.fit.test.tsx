import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import KpiCard from './KpiCard';

/**
 * Mobile slice 18 (staging fix 1): at 200% text a dashboard KPI figure is cut off by its own
 * two-up tile ("$1,985/mo" read "$1,985/", "$67,370" read "$67,37(").
 *
 * The figure moved from 20 px to 1.25rem (40 px at 200%) inside a flex row; it cannot shrink
 * below its own text, so the tile's overflow-hidden clipped it. It now stays on ONE line (a
 * money amount broken mid-number reads as another amount) and is set smaller, in steps, until it
 * fits its tile - the same rule the list pages' stat cards follow (statCard.tsx).
 *
 * jsdom has no layout, so the geometry is supplied: a figure is 0.6 em per character wide at its
 * current font size, and the tile gives it boxW px. The real-browser proof is
 * e2e/mobile/text-200.spec.ts (the dashboard KPI figures at 200% with real-sized amounts).
 */

const CSS_PX = 40; // 1.25rem at a 200% root
let boxW = 128;
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

const isFigure = (el: Element) => el.getAttribute('data-slot') === 'kpi-value';
const fontPx = (el: HTMLElement) => parseFloat(el.style.fontSize) || CSS_PX;

beforeEach(() => {
  boxW = 128;
  stub(HTMLElement.prototype, 'clientWidth', { get(this: HTMLElement) { return isFigure(this) ? boxW : 0; } });
  stub(HTMLElement.prototype, 'scrollWidth', {
    get(this: HTMLElement) {
      if (!isFigure(this)) return 0;
      return Math.max(boxW, Math.ceil((this.textContent ?? '').length * fontPx(this) * 0.6));
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

const renderCard = (value: string) =>
  render(<KpiCard icon={<i />} iconBg="bg-primary" label="Recurring (Plans)" value={value} onClick={() => {}} />);

const figure = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="kpi-value"]')!;
const fitsBox = (el: HTMLElement) => Math.ceil((el.textContent ?? '').length * fontPx(el) * 0.6) <= boxW;

function resizeTo(width: number) {
  boxW = width;
  act(() => {
    for (const o of observers) {
      if (o.els.length) o.cb(o.els.map((target) => ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry), {} as ResizeObserver);
    }
  });
}

describe('dashboard KPI figure at 200% text', () => {
  it('is set smaller until the whole figure fits its tile, instead of being cut off', () => {
    const { container } = renderCard('$1,985/mo');
    const el = figure(container);
    expect(el.textContent).toBe('$1,985/mo');
    expect(fontPx(el)).toBeLessThan(CSS_PX);
    expect(fitsBox(el)).toBe(true);
  });

  it('keeps the figure on one line: it is never allowed to break inside the number', () => {
    const { container } = renderCard('$67,370');
    const cls = figure(container).className;
    expect(cls).toContain('whitespace-nowrap');
    expect(cls).not.toMatch(/break-words|break-all|\[overflow-wrap/);
  });

  it('keeps its own size when it already fits (the default text size is untouched)', () => {
    boxW = 400;
    const { container } = renderCard('$67,370');
    expect(figure(container).style.fontSize).toBe('');
  });

  it('never goes below a readable floor, and gets its size back when the tile widens', () => {
    const { container } = renderCard('$1,234,567.89');
    resizeTo(20);
    expect(fontPx(figure(container))).toBe(12);
    resizeTo(600);
    expect(figure(container).style.fontSize).toBe('');
  });
});
