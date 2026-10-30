/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.24 - a list page's New button follows its module's Create switch.
 *
 * The list itself already needs the module's View and Show (the route guard, S02.23), so the pair for the button is
 * "the page is open" plus the Create switch. These render the six routed v2 list pages (the Customers page's
 * "Add Customer" included) for a person who can see the list, once with the Create switch and once without: Show on
 * and Create off shows the page and no New button. The Create switch reaches the screen as a compiled rule, so each
 * person is a rule list, never a built-in role name. The invoices list creates the standalone invoice, so its button
 * follows Standalone invoices.
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import CustomersPage from '@/pages/v2/customers/CustomersPage';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';
import InvoicesPage from '@/pages/v2/invoices/InvoicesPage';
import JobsPage from '@/pages/v2/jobs/JobsPage';
import LeadsPage from '@/pages/v2/leads/LeadsPage';
import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';

import { renderWithProviders } from './helpers';

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

const mockApi = vi.mocked(api);

const PAGINATION = { page: 1, limit: 25, total: 0, totalPages: 1 };

/** Every list route answers with an empty list: these pages are under test for their header, not their rows. */
function answerEmptyLists() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/leads') return { data: { leads: [], pagination: PAGINATION, stats: {}, users: [] } };
    if (url === '/api/customers') return { data: { customers: [], pagination: PAGINATION } };
    if (url === '/api/customers/stats') return { data: {} };
    if (url === '/api/jobs') {
      return { data: { jobs: [], pagination: PAGINATION, stats: {}, users: [], departments: [], tags: [] } };
    }
    if (url === '/api/estimates') return { data: { estimates: [], pagination: PAGINATION, stats: {}, users: [] } };
    if (url === '/api/invoices') return { data: { invoices: [], pagination: PAGINATION, stats: {} } };
    if (url === '/api/tasks') return { data: { tasks: [], users: [] } };
    return { data: {} };
  });
}

interface ListPage {
  name: string;
  Page: ComponentType;
  path: string;
  button: string;
  /** The rule the module's Create switch compiles to. */
  create: AbilityRule;
  /** What the person can already do on the list with Create off: they can see it. */
  view: AbilityRule;
}

const LISTS: ListPage[] = [
  { name: 'Leads', Page: LeadsPage, path: '/leads', button: 'New Lead',
    create: { action: 'create', subject: 'Lead' }, view: { action: 'read', subject: 'Lead' } },
  { name: 'Customers', Page: CustomersPage, path: '/customers', button: 'Add Customer',
    create: { action: 'create', subject: 'Customer' }, view: { action: 'read', subject: 'Customer' } },
  { name: 'Jobs', Page: JobsPage, path: '/jobs', button: 'New Job',
    create: { action: 'create', subject: 'Job' }, view: { action: 'read', subject: 'Job' } },
  { name: 'Estimates', Page: EstimatesPage, path: '/estimates', button: 'New Estimate',
    create: { action: 'create', subject: 'Estimate' }, view: { action: 'read', subject: 'Estimate' } },
  { name: 'Tasks', Page: TasksHubPage, path: '/tasks', button: 'New Task',
    create: { action: 'create', subject: 'Task' }, view: { action: 'read', subject: 'Task' } },
  { name: 'Invoices', Page: InvoicesPage, path: '/invoices', button: 'New Invoice',
    create: { action: 'create_standalone', subject: 'Invoice' }, view: { action: 'read', subject: 'Invoice' } },
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

describe.each(LISTS)('the $name list page (S02.24)', ({ Page, path, button, create, view }) => {
  it('shows its New button to a person with the Create switch on', async () => {
    renderWithProviders(<Page />, { initialEntries: [path], ability: buildAbility([view, create]) });

    expect(await screen.findByRole('button', { name: button })).toBeInTheDocument();
  });

  it('shows the page without its New button when Show is on and Create is off', async () => {
    renderWithProviders(<Page />, { initialEntries: [path], ability: buildAbility([view]) });

    // The page itself is drawn (it asked for its list), and then the button is still not there.
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: button })).not.toBeInTheDocument();
  });
});

describe('the invoices list creates the standalone invoice', () => {
  it('shows no New Invoice with Create invoices on and Standalone invoices off', async () => {
    renderWithProviders(<InvoicesPage />, {
      initialEntries: ['/invoices'],
      ability: buildAbility([
        { action: 'read', subject: 'Invoice' },
        { action: 'create', subject: 'Invoice' },
      ]),
    });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'New Invoice' })).not.toBeInTheDocument();
  });
});
