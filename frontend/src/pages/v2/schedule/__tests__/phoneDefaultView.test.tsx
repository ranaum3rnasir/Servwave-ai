/**
 * Mobile slice 02 - the routed board opens on Day at phone width, keeps a view the
 * user picked for the rest of the session, still opens on Week on a desktop, lets an
 * explicit ?view= win at every width, and its empty state never points a phone user
 * at a side panel that is not on their screen.
 *
 * jsdom applies no stylesheet and has no real viewport, so the width is simulated the
 * way the page reads it: through window.matchMedia. The stub below evaluates the
 * min-width / max-width queries the page asks against a chosen width.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import SchedulePage from '../SchedulePage';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const PHONE = 393;
const DESKTOP = 1280;

/** Evaluate `(max-width: Npx)` / `(min-width: Npx)` (and `and`-joined pairs) at `width`. */
function matchesAt(query: string, width: number): boolean {
  const parts = query.match(/\((min|max)-width:\s*([\d.]+)px\)/g) ?? [];
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const [, kind, px] = part.match(/\((min|max)-width:\s*([\d.]+)px\)/) ?? [];
    const n = Number(px);
    return kind === 'min' ? width >= n : width <= n;
  });
}

const originalMatchMedia = window.matchMedia;

function setViewportWidth(width: number) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matchesAt(query, width),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function mockEmptyBoard() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

/** Render the board at `url` and wait until the first load has settled. */
async function renderBoard(url = '/schedule') {
  const utils = renderWithProviders(<SchedulePage />, { ability: ADMIN, initialEntries: [url] });
  await waitFor(() => expect(utils.container.querySelector('.schedule-cal .animate-spin')).toBeNull());
  return utils;
}

/** The view the board is showing, as the toolbar's view picker reports it. */
const shownView = () =>
  screen.getByRole('combobox', { name: 'Calendar view' }).textContent?.trim().toLowerCase();

/** react-big-calendar paints one `.rbc-day-slot` time column per visible day. */
const dayColumns = (container: HTMLElement) => container.querySelectorAll('.rbc-time-content .rbc-day-slot').length;

describe('v2 schedule board - default view by width, URL and session choice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockEmptyBoard();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('opens on Day at phone width', async () => {
    setViewportWidth(PHONE);
    const { container } = await renderBoard();
    expect(shownView()).toBe('day');
    expect(dayColumns(container)).toBe(1);
  });

  it('keeps a Week the user picked on a phone for the next visit in the session', async () => {
    setViewportWidth(PHONE);
    const first = await renderBoard();
    expect(shownView()).toBe('day');

    // The board's own shortcut for Week - the same setter the toolbar picker uses.
    act(() => {
      fireEvent.keyDown(window, { key: '2' });
    });
    expect(shownView()).toBe('week');
    first.unmount();

    const second = await renderBoard();
    expect(shownView()).toBe('week');
    expect(dayColumns(second.container)).toBe(7);
  });

  it('still opens on Week on a desktop', async () => {
    setViewportWidth(DESKTOP);
    const { container } = await renderBoard();
    expect(shownView()).toBe('week');
    expect(dayColumns(container)).toBe(7);
  });

  it.each([
    [PHONE, 'week'],
    [PHONE, 'month'],
    [DESKTOP, 'day'],
    [DESKTOP, 'month'],
  ])('lets an explicit ?view= win at width %i (%s)', async (width, view) => {
    setViewportWidth(width);
    sessionStorage.setItem('servwave.schedule.view', view === 'day' ? 'week' : 'day');
    await renderBoard(`/schedule?view=${view}`);
    expect(shownView()).toBe(view);
  });

  it('lets the user switch away from a view the URL asked for', async () => {
    // ?view= wins on arrival, but it must not pin the board: picking another view
    // rewrites the param, so the URL and the board agree.
    setViewportWidth(PHONE);
    await renderBoard('/schedule?view=day');
    expect(shownView()).toBe('day');
    act(() => {
      fireEvent.keyDown(window, { key: '2' });
    });
    await waitFor(() => expect(shownView()).toBe('week'));
  });

  it('does not point a phone user at a side panel in the empty state', async () => {
    setViewportWidth(PHONE);
    await renderBoard();
    const empty = await screen.findByText(/^No jobs scheduled/);
    const card = empty.closest('[data-slot="empty-state"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).not.toMatch(/panel/i);
    expect(card.textContent).not.toMatch(/on the left/i);
  });

  it('keeps the drag hint on a desktop, where the panel is on screen', async () => {
    setViewportWidth(DESKTOP);
    await renderBoard();
    expect(await screen.findByText('No jobs scheduled this week')).toBeInTheDocument();
    expect(screen.getByText('Drag a job from the panel on the left to assign it')).toBeInTheDocument();
  });
});
