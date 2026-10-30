/**
 * Roles & Permissions, PRD 3, slice S03.16 - the new-job form has a Sold By field and a Dispatcher field, both
 * holding the creator rule's pre-fill. A person with Assign people to jobs gets pickers (change, clear, pick anyone
 * eligible); anyone else gets fixed text and the form sends no people at all (the server applies the rule). A
 * creator who cannot open the job they just made lands on the Jobs list with a confirmation, never on the
 * not-authorised screen. Rendered through the routed form over a mocked HTTP layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/ui-kit/components/ui/sonner';
import type { AxiosRequestConfig } from 'axios';

type AuthState = ReturnType<typeof useAuthStore.getState>;

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
}));
// The routed page reports through the kit's toaster, which the test render does not mount.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const CREATOR = { id: 'u-creator', first_name: 'Casey', last_name: 'Creator' };
const SELLERS = [
  { id: 'u-seller-a', first_name: 'Sam', last_name: 'Seller', role: 'SALES', department: null },
  { id: 'u-seller-b', first_name: 'Sasha', last_name: 'Sells', role: 'TECHNICIAN', department: null },
];
const DISPATCHERS = [
  { id: 'u-dispatch-a', first_name: 'Dana', last_name: 'Dispatch', role: 'DISPATCHER', department: null },
  { id: 'u-dispatch-b', first_name: 'Dev', last_name: 'Dispatches', role: 'TECHNICIAN', department: null },
];
const NEW_JOB = { id: 'e0000000-0000-0000-0000-0000000000cc', job_number: 'J-100' };

const mockApi = vi.mocked(api);
const canCreate = buildAbility([{ action: 'create', subject: 'Job' }, { action: 'read', subject: 'Job' }]);
const canCreateAndAssign = buildAbility([
  { action: 'create', subject: 'Job' },
  { action: 'read', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
  { action: 'read', subject: 'User' },
]);

/** Where the creator rule pre-fills the signed-in person, as the server answers it. */
function prefillAs(slot: 'soldBy' | 'dispatcher') {
  mockApi.get.mockImplementation(async (url: string, config?: AxiosRequestConfig) => {
    if (url === '/api/jobs/creator-prefill') {
      return {
        data: {
          prefill: {
            sold_by_id: slot === 'soldBy' ? CREATOR.id : null,
            dispatcher_id: slot === 'dispatcher' ? CREATOR.id : null,
          },
        },
      };
    }
    if (url === '/api/users/assignable') {
      return { data: (config?.params as Record<string, unknown> | undefined)?.eligible_for === 'dispatcher' ? DISPATCHERS : SELLERS };
    }
    return { data: {} };
  });
}

function renderForm(ability: ReturnType<typeof buildAbility>, entry = '/jobs/new') {
  return renderWithProviders(<JobFormPage />, { ability, initialEntries: [entry] });
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/first name/i), 'Pat');
  await user.type(screen.getByLabelText(/^phone/i), '5551234567');
  await user.type(screen.getByLabelText(/address/i), '1 Test Way');
  await user.type(screen.getByLabelText(/^city/i), 'Testville');
  await user.type(screen.getByLabelText(/^state/i), 'MA');
  await user.type(screen.getByLabelText(/^zip/i), '02108');
  await user.type(screen.getByLabelText(/service request/i), 'Fix the door');
}

/** A picker, found again each time: it mounts once the pre-fill has arrived. */
const picker = (name: 'Sold By' | 'Dispatcher') => screen.getByRole('combobox', { name });
const pickerShows = (name: 'Sold By' | 'Dispatcher', text: string) =>
  waitFor(() => expect(picker(name)).toHaveTextContent(text));

/** The body of the one job the form posted. */
const postedJob = () => {
  const call = mockApi.post.mock.calls.find(([url]) => String(url).startsWith('/api/jobs'));
  return call?.[1] as Record<string, unknown> | undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  // The auth store is mocked suite-wide: the signed-in person is whoever the selector is handed.
  vi.mocked(useAuthStore).mockImplementation((selector: (s: AuthState) => unknown) =>
    selector({ user: { ...CREATOR, email: 'casey@example.com', role: 'TECHNICIAN', organization_id: 'org-1' } } as AuthState),
  );
  prefillAs('soldBy');
  mockApi.post.mockResolvedValue({ data: { job: NEW_JOB, job_openable: true } });
});

describe('the new-job form - Sold By and Dispatcher fields', () => {
  it('has a Sold By field and a Dispatcher field, as pickers for a person with Assign people to jobs', async () => {
    renderForm(canCreateAndAssign);

    expect(await screen.findByRole('combobox', { name: 'Sold By' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Dispatcher' })).toBeInTheDocument();
  });

  it('asks the Sold By picker for owner-eligible people and the Dispatcher picker for dispatcher-eligible people', async () => {
    renderForm(canCreateAndAssign);
    await screen.findByRole('combobox', { name: 'Sold By' });

    await waitFor(() => {
      const asked = mockApi.get.mock.calls
        .filter(([url]) => url === '/api/users/assignable')
        .map(([, config]) => (config as { params: Record<string, unknown> }).params.eligible_for);
      expect(asked).toEqual(expect.arrayContaining(['owner', 'dispatcher']));
    });
  });
});

describe('a person without Assign people to jobs', () => {
  it('sees fixed text, not pickers: the creator as Sold By and no Dispatcher when the rule gives Sold By', async () => {
    prefillAs('soldBy');
    renderForm(canCreate);

    expect(await screen.findByText('Casey Creator')).toBeInTheDocument();
    expect(screen.getByText('Sold By')).toBeInTheDocument();
    expect(screen.getByText('No dispatcher')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Sold By' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Dispatcher' })).toBeNull();
  });

  it('sees the creator as Dispatcher and nobody as Sold By when the rule gives Dispatcher', async () => {
    prefillAs('dispatcher');
    renderForm(canCreate);

    expect(await screen.findByText('Casey Creator')).toBeInTheDocument();
    expect(screen.getByText('No Sold By')).toBeInTheDocument();
    expect(screen.queryByText('No dispatcher')).toBeNull();
  });

  it('posts no people at all: what the form shows is what the server applies', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).not.toHaveProperty('sold_by_id');
    expect(postedJob()).not.toHaveProperty('dispatcher_id');
  });
});

describe('a person with Assign people to jobs', () => {
  it('sees the pre-fill in the pickers and posts it when they change nothing', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await pickerShows('Sold By', 'Casey Creator');
    expect(picker('Dispatcher')).toHaveTextContent('No dispatcher');

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).toMatchObject({ sold_by_id: CREATOR.id, dispatcher_id: null });
  });

  it('is pre-filled as Dispatcher when the rule says so', async () => {
    prefillAs('dispatcher');
    renderForm(canCreateAndAssign);

    await pickerShows('Dispatcher', 'Casey Creator');
    expect(picker('Sold By')).toHaveTextContent('No Sold By');
  });

  it('posts the people they change to', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await pickerShows('Sold By', 'Casey Creator');

    await user.click(picker('Sold By'));
    await user.click(await screen.findByRole('option', { name: 'Sam Seller' }));
    await user.click(picker('Dispatcher'));
    await user.click(await screen.findByRole('option', { name: 'Dana Dispatch' }));

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).toMatchObject({ sold_by_id: 'u-seller-a', dispatcher_id: 'u-dispatch-a' });
  });

  it('can clear both, and the job posts with nobody on it and no warning', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await pickerShows('Sold By', 'Casey Creator');

    await user.click(picker('Sold By'));
    await user.click(await screen.findByRole('option', { name: 'No Sold By' }));
    expect(picker('Sold By')).toHaveTextContent('No Sold By');

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).toMatchObject({ sold_by_id: null, dispatcher_id: null });
    expect(within(document.body).queryByText(/warning|are you sure/i)).toBeNull();
  });
});

describe('after saving', () => {
  it('opens the new job when the creator can open it', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockNavigate.mock.calls[0]![0]).toBe(`/jobs/${NEW_JOB.id}`);
  });

  it('lands a creator who handed the job to others on the Jobs list with a confirmation, not on a job they cannot open', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { job: { id: NEW_JOB.id, job_number: NEW_JOB.job_number }, job_openable: false } });
    renderForm(canCreateAndAssign);
    await pickerShows('Sold By', 'Casey Creator');
    await user.click(picker('Sold By'));
    await user.click(await screen.findByRole('option', { name: 'Sam Seller' }));
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockNavigate.mock.calls[0]![0]).toBe('/jobs');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('J-100'));
  });
});

describe('when the pre-fill cannot be loaded', () => {
  it.each([['without', canCreate], ['with', canCreateAndAssign]])('%s Assign people to jobs, says so and does not save a job blind', async (_label, ability) => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/jobs/creator-prefill') throw new Error('network down');
      return { data: [] };
    });
    renderForm(ability);

    expect(await screen.findByText(/couldn't load sold by and dispatcher/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
    expect(postedJob()).toBeUndefined();
  });
});

describe('the form opened from the dialer or the text inbox', () => {
  it('is the same form with the same pre-fill', async () => {
    renderForm(canCreate, '/jobs/new?phone=%2B15551234567');

    expect(await screen.findByText('Casey Creator')).toBeInTheDocument();
    expect(screen.getByText('No dispatcher')).toBeInTheDocument();
    expect(mockApi.get.mock.calls.filter(([url]) => url === '/api/jobs/creator-prefill')).toHaveLength(1);
  });
});
