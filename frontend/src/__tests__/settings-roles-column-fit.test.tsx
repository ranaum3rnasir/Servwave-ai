/**
 * Roles & Permissions, PRD 2, S02.4 fix - the side column of the routed Settings > Roles page takes exactly the room the
 * page scroller has left under it, so no role row is ever cut by the panel's bottom edge.
 *
 * jsdom has no layout, so the geometry is answered by hand: the shell's page scroller (the <main> the canvas scrolls in)
 * reports a height and a top, the column's anchor reports where the page puts it, and the column is asserted to take
 * `scroller height - anchor offset - the scroller's bottom padding`, and to follow a resize of the scroller.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { FIXTURE_CATALOG } from './support/permissionCatalogFixture';

const mockApi = vi.mocked(api);

vi.mock('@/pages/v2/settings/settingsBar', () => ({ useSettingsBar: () => ({ registerSaver: () => {} }) }));

const ROLES = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  ...Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`, role: `crew_${i}`, label: `Crew ${i}`, fullAccess: false, editable: true, userCount: 1, type: 'custom', base_role: 'TECHNICIAN',
  })),
];

/** What the browser would report: the scroller's height and top, and where the column's anchor sits inside it. */
const geometry = { scrollerHeight: 700, scrollerTop: 50, anchorTop: 188, scrollTop: 0 };

const proto = HTMLElement.prototype;
const original = {
  rect: proto.getBoundingClientRect,
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
};
const isScroller = (el: Element) => el.getAttribute('data-testid') === 'page-scroller';
const isAnchor = (el: Element) => el.querySelector(':scope > [data-roles-column]') !== null;

let resizeCallbacks: Array<() => void> = [];
class ResizeObserverStub {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  resizeCallbacks = [];
  Object.assign(geometry, { scrollerHeight: 700, scrollerTop: 50, anchorTop: 188, scrollTop: 0 });
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const top = isScroller(this) ? geometry.scrollerTop : isAnchor(this) ? geometry.anchorTop - geometry.scrollTop : 0;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isScroller(this) ? geometry.scrollerHeight : 0; } });
  Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get(this: Element) { return isScroller(this) ? geometry.scrollTop : 0; }, set() {} });
  window.matchMedia = vi.fn((query: string) => ({
    matches: /min-width/.test(query), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    return Promise.resolve({ data: [] });
  });
});
afterEach(() => {
  proto.getBoundingClientRect = original.rect;
  if (original.clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', original.clientHeight);
  if (original.scrollTop) Object.defineProperty(Element.prototype, 'scrollTop', original.scrollTop);
});

/** The page inside a stand-in for the shell's scroller: a scrolling box with the canvas's 32px of bottom padding. */
function renderInScroller() {
  return renderWithProviders(
    <main data-testid="page-scroller" style={{ overflowY: 'auto', paddingBottom: '32px' }}>
      <RolesPage />
    </main>,
  );
}

async function theColumn() {
  const list = await screen.findByRole('group', { name: 'Roles' });
  return list.closest('[data-roles-column]') as HTMLElement;
}

describe('Roles side column fits the page scroller', () => {
  it('takes the scroller height, less where the page puts it and the scroller bottom padding', async () => {
    renderInScroller();
    const column = await theColumn();
    // 700 - (188 - 50) - 32
    await waitFor(() => expect(column.style.maxHeight).toBe('530px'));
  });

  it('measures from where the page puts the column at the top, however far the page is scrolled', async () => {
    geometry.scrollTop = 120;
    renderInScroller();
    const column = await theColumn();
    // The anchor reads 120px higher on screen, and the scroll offset is added back: still 700 - 138 - 32.
    await waitFor(() => expect(column.style.maxHeight).toBe('530px'));
  });

  it('follows the scroller when its height changes', async () => {
    renderInScroller();
    const column = await theColumn();
    await waitFor(() => expect(column.style.maxHeight).toBe('530px'));
    geometry.scrollerHeight = 600;
    act(() => resizeCallbacks.forEach((cb) => cb()));
    await waitFor(() => expect(column.style.maxHeight).toBe('430px'));
  });

  it('is not capped by a guess at the window height, and stays in view beside the editor', async () => {
    renderInScroller();
    const column = await theColumn();
    expect(column.className).not.toMatch(/vh|calc\(/);
    expect(column).toHaveClass('sticky');
    // The list is the part that scrolls, inside the column's own height.
    expect(column.querySelector('[data-roles-scroll]')).toHaveClass('overflow-y-auto', 'min-h-0');
  });
});
