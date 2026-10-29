/**
 * Mobile slice 03: the shared v2 tab strip is ONE row that scrolls sideways
 * inside itself, keeps the selected tab in view, and moves between tabs with
 * the arrow keys.
 *
 * Before this slice the strip was `flex-wrap`, so the job page's ten tabs
 * stacked onto two or three rows at 320 px, and nothing scrolled the selected
 * tab into view because nothing needed to.
 *
 * jsdom has no layout, so the geometry is supplied here: every tab is 100 px
 * wide and the strip shows 300 px of them. `getBoundingClientRect` is derived
 * from that and from the strip's live `scrollLeft`, which is what a browser
 * does. The real-browser proof at 320/360/393/838/768/1280 lives in the
 * slice's Playwright check; this file pins the behaviour so it cannot regress
 * silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Button } from '@/ui-kit/components/ui/button';

import { TabPanel, TabStrip, type TabItem } from '../tabs';

const TEN: TabItem[] = 'abcdefghij'.split('').map((v) => ({ value: v, label: `Tab ${v.toUpperCase()}` }));

const TAB_W = 100;
const STRIP_W = 300;

const scrollLefts = new WeakMap<Element, number>();
let restore: Array<() => void> = [];

function stub<T extends object, K extends keyof T>(target: T, key: K, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<PropertyKey, unknown>)[key as PropertyKey];
  });
}

function rect(left: number, width: number): DOMRect {
  return {
    left, right: left + width, width, x: left, top: 0, bottom: 34, height: 34, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  stub(HTMLElement.prototype, 'scrollLeft', {
    get(this: HTMLElement) { return scrollLefts.get(this) ?? 0; },
    set(this: HTMLElement, v: number) {
      const max = Math.max(0, this.scrollWidth - this.clientWidth);
      scrollLefts.set(this, Math.min(Math.max(0, v), max));
    },
  });
  stub(HTMLElement.prototype, 'clientWidth', {
    get(this: HTMLElement) { return this.getAttribute('role') === 'tablist' ? STRIP_W : 0; },
  });
  stub(HTMLElement.prototype, 'scrollWidth', {
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'tablist'
        ? this.querySelectorAll('[role="tab"]').length * TAB_W
        : 0;
    },
  });
  stub(Element.prototype, 'getBoundingClientRect', {
    value(this: Element) {
      if (this.getAttribute('role') === 'tablist') return rect(0, STRIP_W);
      if (this.getAttribute('role') === 'tab') {
        const list = this.closest('[role="tablist"]')!;
        const index = Array.from(list.querySelectorAll('[role="tab"]')).indexOf(this);
        return rect(index * TAB_W - list.scrollLeft, TAB_W);
      }
      return rect(0, 0);
    },
  });
});

afterEach(() => {
  restore.reverse().forEach((undo) => undo());
  restore = [];
});

function visibleInStrip(name: string) {
  const r = screen.getByRole('tab', { name }).getBoundingClientRect();
  return r.left >= 0 && r.right <= STRIP_W;
}

describe('TabStrip on a narrow screen', () => {
  it('lays the tabs out on one row that scrolls sideways, never wrapping', () => {
    render(<TabStrip tabs={TEN} value="a" onValueChange={vi.fn()} />);

    const classes = screen.getByRole('tablist').className.split(/\s+/);
    expect(classes).not.toContain('flex-wrap');
    expect(classes).toContain('flex-nowrap');
    expect(classes).toContain('overflow-x-auto');
  });

  it('keeps the tabs on one row when a right-hand control shares the line', () => {
    render(<TabStrip tabs={TEN} value="a" onValueChange={vi.fn()} right={<Button size="sm">Filter</Button>} />);

    const list = screen.getByRole('tablist');
    expect(list.className.split(/\s+/)).not.toContain('flex-wrap');
    expect(list.className.split(/\s+/)).toContain('overflow-x-auto');
    // The control stays out of the tablist, as before.
    expect(list).not.toContainElement(screen.getByRole('button', { name: 'Filter' }));
  });

  it('marks the scrolling row as an intended sideways scroller, with or without a right-hand control', () => {
    // The mobile gate (e2e/mobile) fails any element that scrolls sideways
    // unless it carries this marker; the one-row strip scrolls on purpose.
    const { unmount } = render(<TabStrip tabs={TEN} value="a" onValueChange={vi.fn()} />);
    expect(screen.getByRole('tablist')).toHaveAttribute('data-mobile-scroll-x', 'tab-strip');
    unmount();

    render(<TabStrip tabs={TEN} value="a" onValueChange={vi.fn()} right={<Button size="sm">Filter</Button>} />);
    expect(screen.getByRole('tablist')).toHaveAttribute('data-mobile-scroll-x', 'tab-strip');
    // Only the tabs' row scrolls; the right-hand control is not inside the marked scroller.
    expect(screen.getByRole('button', { name: 'Filter' }).closest('[data-mobile-scroll-x]')).toBeNull();
  });

  it('scrolls the selected tab into view on load, inside the strip only', () => {
    const pageScroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(<TabStrip tabs={TEN} value="h" onValueChange={vi.fn()} />);

    expect(visibleInStrip('Tab H')).toBe(true);
    expect(screen.getByRole('tablist').scrollLeft).toBeGreaterThan(0);
    // `scrollIntoView` would also scroll the PAGE to the strip on load. The
    // strip's own scrollLeft is the only thing that may move.
    expect(pageScroll).not.toHaveBeenCalled();
    pageScroll.mockRestore();
  });

  it('scrolls the newly selected tab into view when the selection changes', () => {
    const { rerender } = render(<TabStrip tabs={TEN} value="a" onValueChange={vi.fn()} />);
    expect(screen.getByRole('tablist').scrollLeft).toBe(0);

    rerender(<TabStrip tabs={TEN} value="j" onValueChange={vi.fn()} />);
    expect(visibleInStrip('Tab J')).toBe(true);

    rerender(<TabStrip tabs={TEN} value="b" onValueChange={vi.fn()} />);
    expect(visibleInStrip('Tab B')).toBe(true);
  });
});

describe('TabStrip keyboard', () => {
  it('moves focus between tabs with the arrow keys, Home and End, wrapping at the ends', () => {
    const onValueChange = vi.fn();
    render(<TabStrip tabs={TEN} value="a" onValueChange={onValueChange} />);
    const tab = (n: string) => screen.getByRole('tab', { name: n });

    tab('Tab A').focus();
    fireEvent.keyDown(tab('Tab A'), { key: 'ArrowRight' });
    expect(tab('Tab B')).toHaveFocus();

    fireEvent.keyDown(tab('Tab B'), { key: 'ArrowLeft' });
    expect(tab('Tab A')).toHaveFocus();

    fireEvent.keyDown(tab('Tab A'), { key: 'ArrowLeft' });
    expect(tab('Tab J')).toHaveFocus();

    fireEvent.keyDown(tab('Tab J'), { key: 'ArrowRight' });
    expect(tab('Tab A')).toHaveFocus();

    fireEvent.keyDown(tab('Tab A'), { key: 'End' });
    expect(tab('Tab J')).toHaveFocus();
    // A tab reached by keyboard is scrolled into the strip too.
    expect(visibleInStrip('Tab J')).toBe(true);

    fireEvent.keyDown(tab('Tab J'), { key: 'Home' });
    expect(tab('Tab A')).toHaveFocus();

    // Arrows move focus; they do not switch the panel. Enter/Space (the
    // button's own click) still does.
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(tab('Tab A'));
    expect(onValueChange).toHaveBeenCalledWith('a');
  });

  it('keeps the tablist semantics: one tablist, tabs with aria-selected and aria-controls', () => {
    render(
      <>
        <TabStrip tabs={TEN} value="c" onValueChange={vi.fn()} />
        <TabPanel value="c" activeValue="c">panel</TabPanel>
      </>,
    );

    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(10);
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Tab C' })).toHaveAttribute('aria-controls', 'v2-tabpanel-c');
    expect(screen.getByRole('tab', { name: 'Tab C' })).toHaveAttribute('id', 'v2-tab-c');
  });

  it('names no panel that is not in the page (aria-valid-attr-value, mobile slice 75)', () => {
    render(<TabStrip tabs={TEN} value="c" onValueChange={vi.fn()} />);
    for (const t of screen.getAllByRole('tab')) expect(t).not.toHaveAttribute('aria-controls');
  });
});
