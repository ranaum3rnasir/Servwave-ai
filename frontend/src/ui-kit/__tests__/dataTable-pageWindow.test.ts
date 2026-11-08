import { describe, it, expect } from 'vitest';

import { pageWindow } from '@/ui-kit/components/data/dataTable/pageWindow';

/**
 * The numbered pager's window (visits slice 06): which page numbers to draw, and where an
 * ellipsis stands in for a run of hidden pages. The first and last page and the current page's
 * neighbours are always drawn; an ellipsis never hides a single page (the page number takes the
 * same room and is one click closer); once there are more pages than fit, the item count is
 * constant, so paging never makes the control jump.
 */
const E = '…';
const show = (current: number, count: number, siblings?: number) =>
  pageWindow(current, count, siblings).map((item) => (item.type === 'page' ? item.page : E));

describe('pageWindow - every page fits', () => {
  it('no pages: nothing to draw', () => {
    expect(show(1, 0)).toEqual([]);
  });

  it('one page', () => {
    expect(show(1, 1)).toEqual([1]);
  });

  it('two pages, from either end', () => {
    expect(show(1, 2)).toEqual([1, 2]);
    expect(show(2, 2)).toEqual([1, 2]);
  });

  it('seven pages: all of them, wherever the current page is', () => {
    for (const current of [1, 4, 7]) expect(show(current, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('pageWindow - eight pages', () => {
  it('current at the start: one ellipsis before the last page', () => {
    expect(show(1, 8)).toEqual([1, 2, 3, 4, 5, E, 8]);
  });

  it('current at the end: one ellipsis after the first page', () => {
    expect(show(8, 8)).toEqual([1, E, 4, 5, 6, 7, 8]);
  });

  it('current in the middle: first, neighbours and last; an ellipsis never stands for one page', () => {
    expect(show(4, 8)).toEqual([1, 2, 3, 4, 5, E, 8]);
    expect(show(5, 8)).toEqual([1, E, 4, 5, 6, 7, 8]);
  });
});

describe('pageWindow - one hundred pages', () => {
  it('current at the start', () => {
    expect(show(1, 100)).toEqual([1, 2, 3, 4, 5, E, 100]);
    expect(show(3, 100)).toEqual([1, 2, 3, 4, 5, E, 100]);
  });

  it('current in the middle: both ellipses, the neighbours between them', () => {
    expect(show(50, 100)).toEqual([1, E, 49, 50, 51, E, 100]);
    expect(show(5, 100)).toEqual([1, E, 4, 5, 6, E, 100]);
  });

  it('current at the end', () => {
    expect(show(100, 100)).toEqual([1, E, 96, 97, 98, 99, 100]);
    expect(show(98, 100)).toEqual([1, E, 96, 97, 98, 99, 100]);
  });

  it('the item count stays constant while paging (no jumping control)', () => {
    for (let current = 1; current <= 100; current += 1) expect(show(current, 100)).toHaveLength(7);
  });

  it('every drawn window holds the current page, the first and the last', () => {
    for (let current = 1; current <= 100; current += 1) {
      const pages = show(current, 100);
      expect(pages).toContain(current);
      expect(pages[0]).toBe(1);
      expect(pages[pages.length - 1]).toBe(100);
    }
  });
});

describe('pageWindow - the compact (phone) window, no neighbours', () => {
  it('first, current and last only', () => {
    expect(show(50, 100, 0)).toEqual([1, E, 50, E, 100]);
    expect(show(1, 100, 0)).toEqual([1, 2, 3, E, 100]);
    expect(show(100, 100, 0)).toEqual([1, E, 98, 99, 100]);
  });

  it('five pages still all fit', () => {
    expect(show(3, 5, 0)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('pageWindow - out-of-range current page', () => {
  it('is clamped into range, never drawn as a page that does not exist', () => {
    expect(show(0, 8)).toEqual(show(1, 8));
    expect(show(12, 8)).toEqual(show(8, 8));
  });
});

describe('pageWindow - ellipsis keys', () => {
  it('the two ellipses carry distinct keys', () => {
    const gaps = pageWindow(50, 100).filter((item) => item.type === 'ellipsis');
    expect(gaps.map((g) => g.key)).toEqual(['ellipsis-start', 'ellipsis-end']);
  });
});
