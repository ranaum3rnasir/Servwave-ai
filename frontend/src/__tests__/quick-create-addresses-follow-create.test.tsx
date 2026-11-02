/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.25 - the two quick-create addresses (`/tasks?action=new-task` and
 * `/estimates?action=new-estimate`), which the dashboard's "New" menu (New Task) and older bookmarks still reach, open
 * their create dialog only for a person with the module's Create switch. Without it the page shows and the dialog
 * stays shut (the server refuses the save either way; this is the screen no longer offering a dead end). The Create
 * switch reaches the screen as a compiled rule, so each person is a rule list, never a built-in role name.
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';
import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';

import { renderWithProviders } from './helpers';

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));
// The dialogs are stand-ins that say whether they were opened: what is under test is the page deciding to open them.
vi.mock('@/pages/v2/tasks/components/createTaskDialog', () => ({
  CreateTaskDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Create task dialog" /> : null),
}));
vi.mock('@/pages/v2/estimates/components/newEstimateDialog', () => ({
  NewEstimateDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="New estimate dialog" /> : null),
}));

const mockApi = vi.mocked(api);

const PAGINATION = { page: 1, limit: 25, total: 0, totalPages: 1 };

function answerEmptyLists() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/estimates') return { data: { estimates: [], pagination: PAGINATION, stats: {}, users: [] } };
    if (url === '/api/tasks') return { data: { tasks: [], users: [] } };
    return { data: {} };
  });
}

interface Address {
  name: string;
  Page: ComponentType;
  url: string;
  dialog: string;
  create: AbilityRule;
  view: AbilityRule;
  /** The other switches the Create switch requires on (catalog `requires`), as the rules they compile to. */
  needs: AbilityRule[];
}

// Create estimates needs Edit estimates (every rule it compiles to) and See prices.
const EDIT_ESTIMATES_AND_SEE_PRICES: AbilityRule[] = [
  ...['update', 'send', 'cancel', 'revise'].map((action) => ({ action, subject: 'Estimate' }) as AbilityRule),
  { action: 'read', subject: 'Prices' },
];

const ADDRESSES: Address[] = [
  { name: 'tasks', Page: TasksHubPage, url: '/tasks?action=new-task', dialog: 'Create task dialog',
    create: { action: 'create', subject: 'Task' }, view: { action: 'read', subject: 'Task' },
    needs: [{ action: 'update', subject: 'Task' }] },
  { name: 'estimates', Page: EstimatesPage, url: '/estimates?action=new-estimate', dialog: 'New estimate dialog',
    create: { action: 'create', subject: 'Estimate' }, view: { action: 'read', subject: 'Estimate' },
    needs: EDIT_ESTIMATES_AND_SEE_PRICES },
];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
  answerEmptyLists();
});

describe.each(ADDRESSES)('the $name quick-create address (S02.25)', ({ Page, url, dialog, create, view, needs }) => {
  it('opens the create dialog for a person with the Create switch on', async () => {
    renderWithProviders(<Page />, { initialEntries: [url], ability: buildAbility([view, ...needs, create]) });

    expect(await screen.findByRole('dialog', { name: dialog })).toBeInTheDocument();
  });

  it('skips the dialog for a person with Create off, and still draws the page', async () => {
    renderWithProviders(<Page />, { initialEntries: [url], ability: buildAbility([view]) });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: dialog })).not.toBeInTheDocument();
  });
});

/**
 * S02.26 - the return path after a customer is created from the new-estimate dialog (`/estimates?newCustomerId=<id>`)
 * reopens that dialog on the new customer, so it follows the same rule as the other entries: only with Create estimates.
 */
describe('the return path after creating a customer (S02.26)', () => {
  const returnUrl = '/estimates?newCustomerId=c0000000-0000-0000-0000-0000000000aa';
  const view: AbilityRule = { action: 'read', subject: 'Estimate' };
  const create: AbilityRule = { action: 'create', subject: 'Estimate' };

  it('reopens the new-estimate dialog for a person with the Create switch on', async () => {
    renderWithProviders(<EstimatesPage />, {
      initialEntries: [returnUrl],
      ability: buildAbility([view, ...EDIT_ESTIMATES_AND_SEE_PRICES, create]),
    });

    expect(await screen.findByRole('dialog', { name: 'New estimate dialog' })).toBeInTheDocument();
  });

  it('skips the dialog for a person with Create off, and still draws the page', async () => {
    renderWithProviders(<EstimatesPage />, { initialEntries: [returnUrl], ability: buildAbility([view]) });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: 'New estimate dialog' })).not.toBeInTheDocument();
  });
});
