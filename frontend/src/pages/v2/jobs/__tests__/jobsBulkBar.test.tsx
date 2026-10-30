import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobsPage from '../JobsPage';

/**
 * Roles & Permissions S04.6 - each bulk action on the Jobs list follows the switches of its
 * single-job twin, and the row checkboxes and the bulk bar hide when no bulk action is left.
 *
 *   On site      Mark arrived            AND Update any visit's status
 *   In progress  Start and finish visits AND Update any visit's status
 *   Complete job Complete jobs
 *   Cancelled    Cancel jobs
 *   Assign       Assign people to jobs   AND Assign work to other people
 *
 * Every person here is a bag of grants (what the switches grant), never a role name.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);

const JOB_LIST = {
  jobs: [
    {
      id: 'j0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scheduled_start: '2026-07-20T09:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
      assignees: [],
      service_location: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: { unassigned: 2, scheduled: 5, in_progress: 1, completed: 3, cancelled: 1, need_invoices: 4 },
  users: [],
  departments: [],
  tags: [],
};

// The grants behind each switch (backend switch catalog, `grants`).
const VIEW_JOBS = { action: 'read', subject: 'Job' } as const;
const MARK_ARRIVED = { action: 'arrive', subject: 'Job' } as const;
const START_AND_FINISH = { action: 'start', subject: 'Job' } as const;
const UPDATE_ANY_VISIT_STATUS = { action: 'update_any_visit_status', subject: 'Job' } as const;
const COMPLETE_JOBS = { action: 'complete', subject: 'Job' } as const;
const CANCEL_JOBS = { action: 'cancel', subject: 'Job' } as const;
const ASSIGN_PEOPLE_TO_JOBS = { action: 'assign', subject: 'Job' } as const;
const ASSIGN_WORK_TO_OTHERS = { action: 'assign', subject: 'User' } as const;

function person(...grants: AbilityRule[]) {
  return buildAbility([VIEW_JOBS, ...grants]);
}

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockResolvedValue({ data: JOB_LIST });
});

async function selectFirstRow() {
  await screen.findByText('J00001');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select J00001' }));
  await screen.findByText('1 job selected');
}

async function openStatusMenu() {
  await userEvent.click(screen.getByRole('button', { name: /change status/i }));
}

async function statusChoices(ability: ReturnType<typeof person>): Promise<string[]> {
  renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
  await selectFirstRow();
  await openStatusMenu();
  await screen.findAllByRole('menuitem');
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
}

describe('Jobs list bulk bar follows switches', () => {
  it('shows a Technician-preset person no row checkboxes and no bulk bar', async () => {
    // Mark arrived and Start and finish visits on; Update any visit's status, Complete jobs, Cancel jobs
    // and the assign switches off.
    renderWithProviders(<JobsPage />, {
      ability: person(MARK_ARRIVED, START_AND_FINISH),
      initialEntries: ['/jobs'],
    });

    await screen.findByText('J00001');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      });

  it('shows Complete job alone to a person with only Complete jobs', async () => {
    expect(await statusChoices(person(COMPLETE_JOBS))).toEqual(['Complete job']);
    expect(screen.queryByRole('button', { name: /^assign$/i })).not.toBeInTheDocument();
  });

  it('shows Cancelled alone to a person with only Cancel jobs', async () => {
    expect(await statusChoices(person(CANCEL_JOBS))).toEqual(['Cancelled']);
  });

  it('offers On site only with Mark arrived AND Update any visit\'s status', async () => {
    expect(await statusChoices(person(MARK_ARRIVED, UPDATE_ANY_VISIT_STATUS, COMPLETE_JOBS))).toEqual([
      'On site',
      'Complete job',
    ]);
  });

  it('offers In progress only with Start and finish visits AND Update any visit\'s status', async () => {
    expect(await statusChoices(person(START_AND_FINISH, UPDATE_ANY_VISIT_STATUS, COMPLETE_JOBS))).toEqual([
      'In progress',
      'Complete job',
    ]);
  });

  it('offers neither visit step without Update any visit\'s status, keeping the rest', async () => {
    expect(await statusChoices(person(MARK_ARRIVED, START_AND_FINISH, COMPLETE_JOBS))).toEqual(['Complete job']);
  });

  it('offers neither visit step with only Update any visit\'s status', async () => {
    renderWithProviders(<JobsPage />, {
      ability: person(UPDATE_ANY_VISIT_STATUS),
      initialEntries: ['/jobs'],
    });

    await screen.findByText('J00001');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('offers Assign only with Assign people to jobs AND Assign work to other people', async () => {
    renderWithProviders(<JobsPage />, {
      ability: person(ASSIGN_PEOPLE_TO_JOBS, ASSIGN_WORK_TO_OTHERS),
      initialEntries: ['/jobs'],
    });
    await selectFirstRow();

    expect(screen.getByRole('button', { name: /^assign$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change status/i })).not.toBeInTheDocument();
  });

  it('shows a Sales-preset person no bulk Assign', async () => {
    // Assign people to jobs and Assign work to other people are both off for the Sales preset.
    renderWithProviders(<JobsPage />, {
      ability: person(MARK_ARRIVED, START_AND_FINISH, COMPLETE_JOBS),
      initialEntries: ['/jobs'],
    });
    await selectFirstRow();

    expect(screen.queryByRole('button', { name: /^assign$/i })).not.toBeInTheDocument();
  });

  it('hides Assign from a person who may assign jobs but not to other people', async () => {
    renderWithProviders(<JobsPage />, {
      ability: person(ASSIGN_PEOPLE_TO_JOBS),
      initialEntries: ['/jobs'],
    });

    await screen.findByText('J00001');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('hides Assign from a person who may assign to other people but not assign jobs', async () => {
    renderWithProviders(<JobsPage />, {
      ability: person(ASSIGN_WORK_TO_OTHERS),
      initialEntries: ['/jobs'],
    });

    await screen.findByText('J00001');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('keeps On site, In progress, Complete job and Assign for an office user holding all their switches', async () => {
    const office = person(
      MARK_ARRIVED,
      START_AND_FINISH,
      UPDATE_ANY_VISIT_STATUS,
      COMPLETE_JOBS,
      ASSIGN_PEOPLE_TO_JOBS,
      ASSIGN_WORK_TO_OTHERS,
    );
    expect(await statusChoices(office)).toEqual(['On site', 'In progress', 'Complete job']);
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeInTheDocument();
  });
});
