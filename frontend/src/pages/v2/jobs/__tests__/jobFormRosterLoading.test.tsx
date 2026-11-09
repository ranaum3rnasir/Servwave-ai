/**
 * Scenario pass 1 fix - the new-job form's Sold By and Dispatcher pickers while their roster is on the way. A roster
 * that took many seconds left the pickers reading "No Sold By" and "No dispatcher" as if nobody could be chosen.
 * Now a roster still loading shows a loading placeholder, a failed one an error with Retry, and only a roster that
 * arrived (empty or full) shows a picker. Rendered through the routed form over a mocked HTTP layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import type { AxiosRequestConfig } from 'axios';

type AuthState = ReturnType<typeof useAuthStore.getState>;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
}));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const CREATOR = { id: 'u-creator', first_name: 'Casey', last_name: 'Creator' };
const PEOPLE = [{ id: 'u-sam', first_name: 'Sam', last_name: 'Seller', role: 'SALES', department: null }];

const mockApi = vi.mocked(api);
const canCreateAndAssign = buildAbility([
  { action: 'create', subject: 'Job' },
  { action: 'read', subject: 'Job' },
  // Create jobs needs Edit jobs.
  { action: 'update', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
  { action: 'read', subject: 'User' },
]);

type Answer = 'pending' | 'fail' | 'ok' | 'empty';

function rosters(answerFor: (slot: string) => Answer) {
  mockApi.get.mockImplementation(async (url: string, config?: AxiosRequestConfig) => {
    if (url === '/api/jobs/creator-prefill') return { data: { prefill: { sold_by_id: CREATOR.id, dispatcher_id: null } } };
    if (url === '/api/users/assignable') {
      const answer = answerFor(String((config?.params as Record<string, unknown> | undefined)?.eligible_for));
      if (answer === 'pending') return new Promise(() => {});
      if (answer === 'fail') throw new Error('Request failed with status code 500');
      return { data: answer === 'empty' ? [] : PEOPLE };
    }
    return { data: {} };
  });
}

const fieldOf = (label: string) => screen.getByText(label, { selector: 'label' }).parentElement as HTMLElement;
const renderForm = () => renderWithProviders(<JobFormPage />, { ability: canCreateAndAssign, initialEntries: ['/jobs/new'] });

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.mocked(useAuthStore).mockImplementation((selector: (s: AuthState) => unknown) =>
    selector({ user: { ...CREATOR, email: 'casey@example.com', role: 'TECHNICIAN', organization_id: 'org-1' } } as AuthState),
  );
});

describe('the new-job form while the rosters load', () => {
  it('shows a loading placeholder for Sold By and Dispatcher, never an empty list', async () => {
    rosters(() => 'pending');
    renderForm();

    for (const label of ['Sold By', 'Dispatcher']) {
      expect(await within(fieldOf(label)).findByRole('status', { name: 'Loading people' }), label).toBeInTheDocument();
    }
    expect(screen.queryByRole('combobox', { name: 'Sold By' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Dispatcher' })).toBeNull();
    expect(screen.queryByText('No Sold By')).toBeNull();
    expect(screen.queryByText('No dispatcher')).toBeNull();
  });

  it('replaces the placeholder with the pickers once the rosters arrive', async () => {
    rosters(() => 'ok');
    renderForm();

    expect(await screen.findByRole('combobox', { name: 'Sold By' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Dispatcher' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading people' })).toBeNull();
  });

  it('shows a picker, not an error, for a roster that arrived with nobody in it', async () => {
    rosters(() => 'empty');
    renderForm();

    expect(await screen.findByRole('combobox', { name: 'Sold By' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error with Retry for a roster that failed, and a picker after Retry succeeds', async () => {
    let dispatcherRosterWorks = false;
    rosters((slot) => (slot === 'dispatcher' && !dispatcherRosterWorks ? 'fail' : 'ok'));
    const user = userEvent.setup();
    renderForm();

    const field = fieldOf('Dispatcher');
    expect(await within(field).findByText('Could not load the list of people.')).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Sold By' })).toBeInTheDocument();

    dispatcherRosterWorks = true;
    await user.click(within(field).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Dispatcher' })).toBeInTheDocument());
  });
});
