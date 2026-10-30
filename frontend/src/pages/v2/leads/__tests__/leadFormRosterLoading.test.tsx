/**
 * Scenario pass 1 fix - the new-lead form's people pickers while their roster is on the way. A company of 217 people
 * answered the roster after many seconds, and the pickers read "No owner" and "No more members" for the whole wait
 * (an empty list, disabled), as if nobody could be chosen. Now a roster still loading shows a loading placeholder, a
 * failed one shows an error with Retry, and only a roster that arrived empty or full shows a picker.
 * Rendered through the routed form over a mocked HTTP layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import type { AxiosRequestConfig } from 'axios';

type AuthState = ReturnType<typeof useAuthStore.getState>;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));

const CREATOR = { id: 'u-creator', first_name: 'Casey', last_name: 'Creator' };
const PEOPLE = [{ id: 'u-olive', first_name: 'Olive', last_name: 'Owner', role: 'SALES', department: null }];

const mockApi = vi.mocked(api);
const canBookAndAssign = buildAbility([
  { action: 'create', subject: 'Lead' },
  { action: 'assign', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
  { action: 'read', subject: 'User' },
]);

type Answer = 'pending' | 'fail' | 'ok' | 'empty';

/** Answers the pre-fill at once and the roster the way the case says, per slot; a pending roster never answers. */
function rosters(answerFor: (slot: string) => Answer) {
  mockApi.get.mockImplementation(async (url: string, config?: AxiosRequestConfig) => {
    if (url === '/api/leads/creator-prefill') return { data: { prefill: { owner_id: CREATOR.id, dispatcher_id: null } } };
    if (url === '/api/users/assignable') {
      const slot = String((config?.params as Record<string, unknown> | undefined)?.eligible_for);
      const answer = answerFor(slot);
      if (answer === 'pending') return new Promise(() => {});
      if (answer === 'fail') throw new Error('Request failed with status code 500');
      return { data: answer === 'empty' ? [] : PEOPLE };
    }
    return { data: {} };
  });
}

/** The field a label names, as the block holding the label and its control. */
const fieldOf = (label: string) => screen.getByText(label, { selector: 'label' }).parentElement as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.mocked(useAuthStore).mockImplementation((selector: (s: AuthState) => unknown) =>
    selector({ user: { ...CREATOR, email: 'casey@example.com', role: 'TECHNICIAN', organization_id: 'org-1' } } as AuthState),
  );
});

const renderForm = () => renderWithProviders(<LeadFormPage />, { ability: canBookAndAssign, initialEntries: ['/leads/create'] });

describe('the new-lead form while the rosters load', () => {
  it('shows a loading placeholder for Owner, Dispatcher and Performers, never an empty list', async () => {
    rosters(() => 'pending');
    renderForm();

    for (const label of ['Owner', 'Dispatcher', 'Performers']) {
      expect(await within(fieldOf(label)).findByRole('status', { name: 'Loading people' }), label).toBeInTheDocument();
    }
    expect(screen.queryByRole('combobox', { name: 'Owner' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Dispatcher' })).toBeNull();
    expect(screen.queryByText('No owner')).toBeNull();
    expect(screen.queryByText('No dispatcher')).toBeNull();
    expect(screen.queryByText(/no more members/i)).toBeNull();
  });

  it('replaces the placeholder with the pickers once the rosters arrive', async () => {
    rosters(() => 'ok');
    renderForm();

    expect(await screen.findByRole('combobox', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Dispatcher' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading people' })).toBeNull();
  });

  it('shows a picker, not an error, for a roster that arrived with nobody in it', async () => {
    rosters(() => 'empty');
    renderForm();

    expect(await screen.findByRole('combobox', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading people' })).toBeNull();
  });

  it('shows an error with Retry for a roster that failed, and a picker after Retry succeeds', async () => {
    let ownerRosterWorks = false;
    rosters((slot) => (slot === 'owner' && !ownerRosterWorks ? 'fail' : 'ok'));
    const user = userEvent.setup();
    renderForm();

    const ownerField = fieldOf('Owner');
    expect(await within(ownerField).findByText('Could not load the list of people.')).toBeInTheDocument();
    // The other roster is fine and keeps its picker.
    expect(await screen.findByRole('combobox', { name: 'Dispatcher' })).toBeInTheDocument();

    ownerRosterWorks = true;
    await user.click(within(ownerField).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Owner' })).toBeInTheDocument());
    expect(within(fieldOf('Owner')).queryByRole('alert')).toBeNull();
  });
});
