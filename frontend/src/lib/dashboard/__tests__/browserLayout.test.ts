/**
 * Roles & Permissions S09.5 - reading the layout this browser used to keep, so it can be carried to the server once.
 *
 * Seam: `readBrowserLayout` / `clearBrowserLayout`. The fixtures are the shape the browser really stored under
 * `alpha:dashboard-layout:v1:<person id>` before layouts moved to the server: a JSON list of
 * `{ id, visible, size?, range? }`, the whole layout, in the person's order.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearBrowserLayout, readBrowserLayout } from '../browserLayout';

const ME = '00000000-0000-0000-0000-0000000000a1';
const SOMEONE_ELSE = '00000000-0000-0000-0000-0000000000b2';
const keyOf = (userId: string) => `alpha:dashboard-layout:v1:${userId}`;

/** A customised layout as the old page wrote it: Close Rate moved first, Jobs Today hidden, two tiles resized. */
const CUSTOMISED = [
  { id: 'kpi.close_rate', visible: true },
  { id: 'kpi.jobs_today', visible: false },
  { id: 'kpi.revenue_mtd', visible: true, size: 'half', range: '30d' },
  { id: 'needs_attention', visible: true, size: 'full' },
  { id: 'revenue_chart', visible: true, range: 'month' },
];

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('reading the layout this browser used to keep', () => {
  it('returns a real old-shape layout as it was saved, order and choices intact', () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(CUSTOMISED));
    expect(readBrowserLayout(ME)).toEqual(CUSTOMISED);
  });

  it('returns nothing when this browser kept no layout for the person', () => {
    expect(readBrowserLayout(ME)).toBeNull();
  });

  it('reads only the signed-in person\'s own copy, never another person\'s on the same browser', () => {
    localStorage.setItem(keyOf(SOMEONE_ELSE), JSON.stringify(CUSTOMISED));
    expect(readBrowserLayout(ME)).toBeNull();
    expect(readBrowserLayout(SOMEONE_ELSE)).toEqual(CUSTOMISED);
  });

  it('reads nothing when nobody is signed in', () => {
    localStorage.setItem(keyOf('anon'), JSON.stringify(CUSTOMISED));
    expect(readBrowserLayout(undefined)).toBeNull();
  });

  it.each([
    ['text that is not JSON', '{"id": "kpi.jobs_today", vis'],
    ['an object, not a list', JSON.stringify({ id: 'kpi.jobs_today', visible: true })],
    ['a string', JSON.stringify('kpi.jobs_today')],
    ['null', 'null'],
    ['an empty list', '[]'],
    ['a list with nothing usable in it', JSON.stringify([{}, { id: 7, visible: true }, { id: 'kpi.jobs_today' }, 'x', null])],
  ])('carries nothing from %s', (_name, raw) => {
    localStorage.setItem(keyOf(ME), raw);
    expect(readBrowserLayout(ME)).toBeNull();
  });

  it('keeps the usable entries of a partly damaged layout and drops a size or range word it does not know', () => {
    localStorage.setItem(
      keyOf(ME),
      JSON.stringify([
        { id: 'kpi.close_rate', visible: true, size: 'huge', range: 'forever' },
        { id: 'kpi.jobs_today' },
        null,
        { id: 'kpi.jobs_week', visible: false, size: 'third', extra: 'dropped' },
      ]),
    );
    expect(readBrowserLayout(ME)).toEqual([
      { id: 'kpi.close_rate', visible: true },
      { id: 'kpi.jobs_week', visible: false, size: 'third' },
    ]);
  });

  it('keeps a tile once, in its first place', () => {
    localStorage.setItem(keyOf(ME), JSON.stringify([{ id: 'kpi.jobs_week', visible: true }, { id: 'kpi.jobs_today', visible: true }, { id: 'kpi.jobs_week', visible: false }]));
    expect(readBrowserLayout(ME)).toEqual([{ id: 'kpi.jobs_week', visible: true }, { id: 'kpi.jobs_today', visible: true }]);
  });

  it('carries nothing from a list too long to be a layout', () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ id: `tile.${i}`, visible: true }))));
    expect(readBrowserLayout(ME)).toBeNull();
  });

  it('carries nothing, and does not throw, when browser storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readBrowserLayout(ME)).toBeNull();
  });
});

describe('clearing the browser copy', () => {
  it('removes only the person\'s own copy', () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(CUSTOMISED));
    localStorage.setItem(keyOf(SOMEONE_ELSE), JSON.stringify(CUSTOMISED));
    clearBrowserLayout(ME);
    expect(localStorage.getItem(keyOf(ME))).toBeNull();
    expect(localStorage.getItem(keyOf(SOMEONE_ELSE))).not.toBeNull();
  });

  it('does not throw when browser storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => clearBrowserLayout(ME)).not.toThrow();
  });
});
