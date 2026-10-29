/**
 * Mobile slice 42 - the scheduler toolbar is one short row at phone width (and on a phone held
 * sideways), with the rarely used controls behind one "More" button, and the Month view at
 * phone width is a grid of 44 px day cells that show a count and open that day.
 *
 * jsdom has no stylesheet, so sizes are asserted in the real-browser mobile gate
 * (e2e/mobile/scheduler-phone.spec.ts). What jsdom CAN pin is which controls render where, and
 * the DOM contract of a Month cell: it is a button, named with its date and its event count,
 * and activating it opens the day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

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

/** Evaluate width queries, and `(max-height: Npx)` queries, at the simulated viewport. */
function matchesAt(query: string, width: number, height: number): boolean {
  const parts = query.match(/\((min|max)-(width|height):\s*([\d.]+)px\)/g) ?? [];
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const [, kind, axis, px] = part.match(/\((min|max)-(width|height):\s*([\d.]+)px\)/) ?? [];
    const actual = axis === 'width' ? width : height;
    return kind === 'min' ? actual >= Number(px) : actual <= Number(px);
  });
}

const originalMatchMedia = window.matchMedia;

function setViewport(width: number, height = 800) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matchesAt(query, width, height),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function noon(daysFromNow: number) {
  const d = new Date();
  d.setUTCHours(16, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d;
}

function mockBoard(jobs: Array<Record<string, unknown>> = []) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

const aJob = (n: number, startsIn: number) => ({
  id: `job-${n}`,
  job_number: `J0000${n}`,
  status: 'SCHEDULED',
  scope_notes: 'Door repair',
  customer: { first_name: 'Raul', last_name: 'Herrera', company_name: null },
  assignees: [],
  tags: [],
  is_all_day: false,
  scheduled_start: noon(startsIn).toISOString(),
  scheduled_end: new Date(noon(startsIn).getTime() + 3600_000).toISOString(),
});

async function renderBoard(url = '/schedule') {
  const utils = renderWithProviders(<SchedulePage />, { ability: ADMIN, initialEntries: [url] });
  await waitFor(() => expect(utils.container.querySelector('.schedule-cal .animate-spin')).toBeNull());
  return utils;
}

describe('scheduler toolbar at phone width', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockBoard();
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('keeps navigation and the view picker in the row, and puts the rest behind one More button', async () => {
    setViewport(PHONE);
    await renderBoard();

    expect(screen.getByRole('button', { name: 'Previous period' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next period' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Calendar view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More schedule options' })).toBeInTheDocument();

    // Not in the row any more: they live in the sheet.
    expect(screen.queryByRole('combobox', { name: 'Filter schedule by department' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plan Mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show fewer hours' })).toBeNull();
  });

  it('opens a sheet with the other controls, each still reachable by its own name', async () => {
    setViewport(PHONE);
    await renderBoard();

    fireEvent.click(screen.getByRole('button', { name: 'More schedule options' }));
    const sheet = await screen.findByRole('dialog', { name: 'Schedule options' });

    expect(within(sheet).getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(within(sheet).getByRole('combobox', { name: 'Filter schedule by department' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Plan Mode' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Show fewer hours' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Show more hours' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Schedule legend' })).toBeInTheDocument();
  });

  it('uses the same compact row on a phone held sideways (wide but short)', async () => {
    setViewport(838, 390);
    await renderBoard();
    expect(screen.getByRole('button', { name: 'More schedule options' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter schedule by department' })).toBeNull();
  });

  it('leaves the desktop toolbar exactly as it was', async () => {
    setViewport(DESKTOP, 800);
    await renderBoard();
    expect(screen.queryByRole('button', { name: 'More schedule options' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Filter schedule by department' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan Mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer hours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });
});

describe('Month view at phone width', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('marks the board so the stylesheet can size the cells, and names every cell with its count', async () => {
    setViewport(PHONE);
    mockBoard([aJob(1, 0), aJob(2, 0)]);
    const { container } = await renderBoard('/schedule?view=month');

    expect(container.querySelector('.schedule-cal')).toHaveAttribute('data-phone-month', 'true');
    // Two jobs on the same day: one cell announces "2 events".
    const busy = await screen.findByRole('button', { name: /, 2 events$/ });
    expect(busy).toBeInTheDocument();
    // An empty day is still a named, tappable cell.
    expect(screen.getAllByRole('button', { name: /, no events$/ }).length).toBeGreaterThan(20);
  });

  it('opens that day when a cell is tapped', async () => {
    setViewport(PHONE);
    mockBoard([aJob(1, 0)]);
    await renderBoard('/schedule?view=month');

    fireEvent.click(await screen.findByRole('button', { name: /, 1 event$/ }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Calendar view' }).textContent?.trim().toLowerCase()).toBe('day'),
    );
  });

  it('keeps the desktop Month view as it was: no phone marker, no per-cell count buttons', async () => {
    setViewport(DESKTOP, 800);
    mockBoard([aJob(1, 0)]);
    const { container } = await renderBoard('/schedule?view=month');

    expect(container.querySelector('.schedule-cal')).not.toHaveAttribute('data-phone-month');
    expect(screen.queryByRole('button', { name: /, 1 event$/ })).toBeNull();
  });
});
