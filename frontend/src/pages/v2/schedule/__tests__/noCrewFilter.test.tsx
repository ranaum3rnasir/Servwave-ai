/**
 * Roles & Permissions, PRD 9, slice S09.12 - the Schedule's "No crew" filter, reachable by link.
 *
 * The filter is a view of the existing Schedule named in its address (`/schedule?filter=no_crew`), not a page. These
 * tests drive the routed board (`pages/v2/schedule/SchedulePage`) opened by that link: the board shows the next 7
 * days in the company's time zone, asks the SERVER for the filter (the browser hides nothing), says that the filter is
 * on, and clears it by taking the parameter out of the address. The rows the server answers with are the server's
 * business and are tested against a real database in backend/src/__tests__/permission-schedule-no-crew-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { addDays, format } from 'date-fns';
import { useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { nowWallClock, toInstant } from '@/lib/schedule-tz';

import SchedulePage from '../SchedulePage';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const TZ = 'America/New_York';

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
    return kind === 'min' ? width >= Number(px) : width <= Number(px);
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

/** A job whose one visit starts tomorrow at 14:00Z and has nobody on it, built when asked so it follows the test clock. */
function crewlessJob() {
  const d = addDays(new Date(), 1);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 14, 0, 0)).toISOString();
  const end = new Date(new Date(start).getTime() + 3_600_000).toISOString();
  return {
    id: 'job-nc',
    job_number: 'J00077',
    status: 'SCHEDULED',
    scope_notes: 'Gate operator swap',
    customer: { first_name: 'Ada', last_name: 'Byron', company_name: '' },
    assignees: [],
    tags: [],
    scheduled_start: start,
    scheduled_end: end,
    visits: [{ id: 'v-nc', visit_seq: 1, status: 'SCHEDULED', scheduled_at: start, scheduled_end: end, is_all_day: false, assignees: [] }],
  };
}

/** A Wednesday, so the next 7 days (Wed to Tue) cannot be mistaken for the Sunday-to-Saturday week. */
const WEDNESDAY = new Date('2026-10-14T15:00:00.000Z');

type Params = Record<string, unknown> | undefined;
/** The board's window requests to this list: the ones that ask for a date window, not the bucket's. */
const feedCalls = (url: string) =>
  mockApi.get.mock.calls.filter(([u, cfg]) => {
    const params = (cfg as { params?: Params } | undefined)?.params;
    return u === url && (params?.scheduled_after !== undefined || params?.walkthrough_after !== undefined);
  });

function mockBoard(jobs: Array<Record<string, unknown>> = [], leads: Array<Record<string, unknown>> = []) {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED';
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : jobs } });
    }
    if (url === '/api/leads') return Promise.resolve({ data: { leads } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: TZ } });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/calendar-entries') return Promise.resolve({ data: { calendar_entries: [] } });
    return Promise.resolve({ data: {} });
  });
}

/** Shows the address the board is at, so a test reads what a click did to it. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{`${location.pathname}${location.search}`}</output>;
}

async function renderBoard(url: string) {
  const utils = renderWithProviders(<><SchedulePage /><Address /></>, { ability: ADMIN, initialEntries: [url] });
  await waitFor(() => expect(utils.container.querySelector('.schedule-cal .animate-spin')).toBeNull());
  return utils;
}

const address = () => screen.getByTestId('address').textContent;
const dayColumns = (container: HTMLElement) => container.querySelectorAll('.rbc-time-content .rbc-day-slot').length;
const shownView = () => screen.getByRole('combobox', { name: 'Calendar view' }).textContent?.trim().toLowerCase();
const chip = () => screen.queryByRole('button', { name: 'Remove Crew filter' });

describe('the Schedule opened by the "No crew" link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(WEDNESDAY);
    sessionStorage.clear();
    setViewportWidth(DESKTOP);
    mockBoard();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
  });

  it('asks the server for the filter on the visits and on the walkthroughs, and for nothing the filter does not show', async () => {
    await renderBoard('/schedule?filter=no_crew');
    await waitFor(() => expect(feedCalls('/api/jobs').length).toBeGreaterThan(0));
    await waitFor(() => expect(feedCalls('/api/leads').length).toBeGreaterThan(0));
    for (const [, cfg] of [...feedCalls('/api/jobs'), ...feedCalls('/api/leads')]) {
      expect((cfg as { params: Params }).params?.missing_crew).toBe('true');
    }
    // Calendar entries are not visits or walkthroughs, so the filtered board does not fetch them.
    expect(mockApi.get.mock.calls.some(([u]) => u === '/api/calendar-entries')).toBe(false);
  });

  it('opens on the next 7 days in the company\'s time zone, starting today', async () => {
    const { container } = await renderBoard('/schedule?filter=no_crew');
    expect(shownView()).toBe('week');
    expect(dayColumns(container)).toBe(7);

    const today = nowWallClock(TZ);
    const headers = Array.from(container.querySelectorAll('.rbc-time-header-content .rbc-header')).map((h) => (h.textContent ?? '').toLowerCase());
    expect(headers[0]).toContain(format(today, 'EEE').toLowerCase());
    expect(headers[0]).toContain(format(today, 'd'));
    expect(headers[6]).toContain(format(addDays(today, 6), 'EEE').toLowerCase());

    // The window the board asks the server about is the same 7 days: today's start to the end of the 7th day.
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfSeventh = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6, 23, 59, 59, 999);
    await waitFor(() => expect(feedCalls('/api/jobs').length).toBeGreaterThan(0));
    const params = (feedCalls('/api/jobs')[0]![1] as { params: Record<string, string> }).params;
    expect(params.scheduled_after).toBe(toInstant(startOfToday, TZ).toISOString());
    expect(params.scheduled_before).toBe(toInstant(endOfSeventh, TZ).toISOString());
  });

  it('shows the crewless visit the server answered with', async () => {
    mockBoard([crewlessJob()]);
    const { container } = await renderBoard('/schedule?filter=no_crew');
    await waitFor(() => expect(container.querySelector('[data-board-id="jv-v-nc"]')).not.toBeNull());
  });

  it('says that the filter is on and what it shows, with a way to clear it', async () => {
    await renderBoard('/schedule?filter=no_crew');
    expect(chip()).not.toBeNull();
    expect(screen.getByText('None, next 7 days')).toBeTruthy();
  });

  it('clears the filter by taking it out of the address, and the board asks for everything again', async () => {
    const { container } = await renderBoard('/schedule?filter=no_crew');
    fireEvent.click(chip()!);
    await waitFor(() => expect(address()).toBe('/schedule'));
    expect(chip()).toBeNull();

    await waitFor(() => {
      const calls = feedCalls('/api/jobs');
      expect((calls.at(-1)![1] as { params: Params }).params?.missing_crew).toBeUndefined();
    });
    expect(mockApi.get.mock.calls.some(([u]) => u === '/api/calendar-entries')).toBe(true);
    // Back on the ordinary week: Sunday to Saturday.
    expect(dayColumns(container)).toBe(7);
    const headers = Array.from(container.querySelectorAll('.rbc-time-header-content .rbc-header')).map((h) => (h.textContent ?? '').toLowerCase());
    expect(headers[0]).toContain('sun');
  });

  it('keeps the rest of the address when it clears', async () => {
    await renderBoard('/schedule?filter=no_crew&view=week');
    fireEvent.click(chip()!);
    await waitFor(() => expect(address()).toBe('/schedule?view=week'));
  });

  it('lets a view named in the link win, and a view picked afterwards is kept in the address', async () => {
    await renderBoard('/schedule?filter=no_crew&view=day');
    expect(shownView()).toBe('day');
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(shownView()).toBe('week'));
    expect(address()).toContain('view=week');
    expect(address()).toContain('filter=no_crew');
  });

  it('opens a phone on the same 7 days, with the chip in view', async () => {
    setViewportWidth(PHONE);
    const { container } = await renderBoard('/schedule?filter=no_crew');
    expect(shownView()).toBe('week');
    expect(dayColumns(container)).toBe(7);
    expect(chip()).not.toBeNull();
  });

  it('does not let a view picked earlier in the session replace the 7 days', async () => {
    sessionStorage.setItem('servwave.schedule.view', 'month');
    const { container } = await renderBoard('/schedule?filter=no_crew');
    expect(shownView()).toBe('week');
    expect(dayColumns(container)).toBe(7);
  });

  it('says there is nothing to staff, not that no jobs are scheduled, when the filtered board is empty', async () => {
    await renderBoard('/schedule?filter=no_crew');
    expect(screen.getByText('No visits without a crew')).toBeTruthy();
    expect(screen.queryByText(/No jobs scheduled/)).toBeNull();
  });
});

describe('the Schedule opened without the filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(WEDNESDAY);
    sessionStorage.clear();
    setViewportWidth(DESKTOP);
    mockBoard();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
  });

  it('is unchanged: no filter asked for, no chip, a Sunday-to-Saturday week', async () => {
    const { container } = await renderBoard('/schedule');
    await waitFor(() => expect(feedCalls('/api/jobs').length).toBeGreaterThan(0));
    for (const [, cfg] of [...feedCalls('/api/jobs'), ...feedCalls('/api/leads')]) {
      expect((cfg as { params: Params }).params?.missing_crew).toBeUndefined();
    }
    expect(chip()).toBeNull();
    const headers = Array.from(container.querySelectorAll('.rbc-time-header-content .rbc-header')).map((h) => (h.textContent ?? '').toLowerCase());
    expect(headers[0]).toContain('sun');
  });

  it('ignores a filter name it does not know', async () => {
    await renderBoard('/schedule?filter=something_else');
    expect(chip()).toBeNull();
    await waitFor(() => expect(feedCalls('/api/jobs').length).toBeGreaterThan(0));
    expect((feedCalls('/api/jobs')[0]![1] as { params: Params }).params?.missing_crew).toBeUndefined();
  });
});
