/**
 * The Filter on the jobs and estimates lists, on a phone (mobile slice 64).
 *
 * RED before the change: both lists had their own copy of the filter panel, a fixed 640 px window
 * with a 188 px rail at every width. On a 320 px phone it left the screen, and there was no sheet.
 * Now they use the shared filter: below md a bottom sheet whose facet list drills into one value
 * list, with a draft that only reaches the list on Apply; at md and up the anchored popover.
 *
 * The facets, their URL state and their request params are the lists' own and are untouched; this
 * pins the presentation per width and that a status still wears the module's own chip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import JobsPage from '@/pages/v2/jobs/JobsPage';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);

const LISTS = {
  jobs: {
    Page: JobsPage,
    path: '/jobs',
    payload: {
      jobs: [],
      pagination: { page: 1, limit: 25, total: 0, totalPages: 1 },
      stats: { unassigned: 0, scheduled: 0, in_progress: 0, completed: 0, cancelled: 0, need_invoices: 0 },
      users: [], departments: [], tags: [],
    },
    firstFacet: /^Status/,
    option: 'Unscheduled',
    param: /UNSCHEDULED/,
  },
  estimates: {
    Page: EstimatesPage,
    path: '/estimates',
    payload: {
      estimates: [],
      pagination: { page: 1, limit: 25, total: 0, totalPages: 1 },
      stats: {
        draft: { count: 0, value: 0 }, sent: { count: 0, value: 0 }, pending: { count: 0, value: 0 },
        won: { count: 0, value: 0 }, declined: { count: 0, value: 0 }, archived: { count: 0, value: 0 },
        pending_deposits: { count: 0, total: 0 },
      },
      users: [],
    },
    firstFacet: /^Status/,
    option: 'Draft',
    param: /DRAFT/,
  },
} as const;

const original = { w: window.innerWidth, h: window.innerHeight };
const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
};

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
});
afterEach(() => setViewport(original.w, original.h));

const filterButton = () => screen.getByRole('button', { name: /^Filter/ });
const requestedWith = (pattern: RegExp) => JSON.stringify(mockApi.get.mock.calls).match(pattern) !== null;

describe.each(Object.entries(LISTS))('the %s Filter', (_name, list) => {
  const { Page } = list;
  beforeEach(() => {
    mockApi.get.mockResolvedValue({ data: list.payload });
  });

  it('on a 320 px phone is a bottom sheet with the facet list first, not a side rail', async () => {
    setViewport(320, 568);
    renderWithProviders(<Page />, { initialEntries: [list.path] });
    await userEvent.click(filterButton());

    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(screen.queryByRole('tablist', { name: 'Filter facets' })).not.toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: list.firstFacet })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('drills into one value list, and the pick reaches the list only on Apply', async () => {
    setViewport(375, 667);
    renderWithProviders(<Page />, { initialEntries: [list.path] });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    await userEvent.click(filterButton());

    const sheet = await screen.findByRole('dialog');
    await userEvent.click(within(sheet).getByRole('button', { name: list.firstFacet }));
    await userEvent.click(within(sheet).getByRole('checkbox', { name: list.option }));
    expect(requestedWith(list.param)).toBe(false); // a draft, until Apply

    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(requestedWith(list.param)).toBe(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(filterButton()).getByText('1')).toBeInTheDocument();
  });

  it('at desktop width is still the anchored two-pane popover, live-applied', async () => {
    setViewport(1280, 720);
    renderWithProviders(<Page />, { initialEntries: [list.path] });
    await userEvent.click(filterButton());

    expect(await screen.findByRole('tablist', { name: 'Filter facets' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: list.option }));
    await waitFor(() => expect(requestedWith(list.param)).toBe(true));
  });
});
