/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions scenario pass 1 - the routed Estimates page asks for the creators roster only for a person whose
 * Estimates scope is All. The server refuses that roster to anyone whose scope is narrowed (their own estimates are
 * never filtered by creator), so for them the page makes no request and draws no "Created By" filter.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';

import { renderWithProviders } from './helpers';

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

const mockApi = vi.mocked(api);
const PAGINATION = { page: 1, limit: 25, total: 0, totalPages: 1 };

function answerAs(switches: { admin_box?: boolean; values: Record<string, unknown> }) {
  localStorage.clear();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: switches.admin_box === true, values: switches.values } };
    if (url === '/api/estimates') return { data: { estimates: [], pagination: PAGINATION, stats: {}, users: [] } };
    if (url === '/api/estimates/creators') return { data: { users: [{ id: 'u1', first_name: 'Ana', last_name: 'Lee' }] } };
    return { data: {} };
  });
}

const asked = (path: string) => mockApi.get.mock.calls.some(([url]) => url === path);

async function openEstimates() {
  renderWithProviders(<EstimatesPage />, {
    initialEntries: ['/estimates'],
    ability: buildAbility([{ action: 'read', subject: 'Estimate' }]),
  });
  await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
  await waitFor(() => expect(asked('/api/estimates')).toBe(true));
}

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the Estimates page creators roster', () => {
  it.each(['attached', 'team', 'location', 'through_own_leads'])(
    'is not requested for a person whose Estimates scope is %s',
    async (scope) => {
      answerAs({ values: { view_estimates: true, show_estimates_page: true, estimates_scope: scope } });
      await openEstimates();
      // Give a late request every chance to show up before saying there was none.
      await new Promise((r) => setTimeout(r, 50));

      expect(asked('/api/estimates/creators')).toBe(false);
    },
  );

  it('is requested for a person whose Estimates scope is All', async () => {
    answerAs({ values: { view_estimates: true, show_estimates_page: true, estimates_scope: 'all' } });
    await openEstimates();

    await waitFor(() => expect(asked('/api/estimates/creators')).toBe(true));
  });

  it('is requested for the Admin box holder', async () => {
    answerAs({ admin_box: true, values: { view_estimates: true, show_estimates_page: true } });
    await openEstimates();

    await waitFor(() => expect(asked('/api/estimates/creators')).toBe(true));
  });

  it('is not asked for before the person\'s switches have arrived', async () => {
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    localStorage.clear();
    renderWithProviders(<EstimatesPage />, {
      initialEntries: ['/estimates'],
      ability: buildAbility([{ action: 'read', subject: 'Estimate' }]),
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(asked('/api/estimates/creators')).toBe(false);
  });
});

describe('the Estimates page Created By filter', () => {
  async function filterNames() {
    // The toolbar offers its facets, one tab each, from the filter button.
    await userEvent.click(await screen.findByRole('button', { name: /filter/i }));
  }

  it('is offered to a person with Estimates scope All', async () => {
    answerAs({ values: { view_estimates: true, show_estimates_page: true, estimates_scope: 'all' } });
    await openEstimates();
    await filterNames();

    expect(await screen.findByRole('tab', { name: /Created By/ })).toBeInTheDocument();
  });

  it('is not offered to a person with a narrowed Estimates scope, whose other filters stay', async () => {
    answerAs({ values: { view_estimates: true, show_estimates_page: true, estimates_scope: 'attached' } });
    await openEstimates();
    await filterNames();

    expect(await screen.findByRole('tab', { name: /Status/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Created By/ })).not.toBeInTheDocument();
  });
});
