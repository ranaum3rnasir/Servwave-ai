/**
 * Roles & Permissions, PRD 3, slice S03.15 - the new-lead form says Owner and Dispatcher, both holding the
 * creator rule's pre-fill. A person with Assign people to leads gets pickers (change, clear, pick anyone
 * eligible); anyone else gets fixed text and the form sends no people at all (the server applies the rule).
 * Rendered through the routed form over a mocked HTTP layer: what the person sees, and what the form posts.
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

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));

const CREATOR = { id: 'u-creator', first_name: 'Casey', last_name: 'Creator' };
const OWNERS = [
  { id: 'u-owner-a', first_name: 'Olive', last_name: 'Owner', role: 'SALES', department: null },
  { id: 'u-owner-b', first_name: 'Otto', last_name: 'Owns', role: 'TECHNICIAN', department: null },
];
const DISPATCHERS = [
  { id: 'u-dispatch-a', first_name: 'Dana', last_name: 'Dispatch', role: 'DISPATCHER', department: null },
  { id: 'u-dispatch-b', first_name: 'Dev', last_name: 'Dispatches', role: 'TECHNICIAN', department: null },
];

const mockApi = vi.mocked(api);
const canCreate = buildAbility([{ action: 'create', subject: 'Lead' }]);
const canCreateAndAssign = buildAbility([
  { action: 'create', subject: 'Lead' },
  { action: 'assign', subject: 'Lead' },
  { action: 'read', subject: 'User' },
]);

/** Where the creator rule pre-fills the signed-in person, as the server answers it. */
function prefillAs(slot: 'owner' | 'dispatcher') {
  mockApi.get.mockImplementation(async (url: string, config?: AxiosRequestConfig) => {
    if (url === '/api/leads/creator-prefill') {
      return {
        data: {
          prefill: {
            owner_id: slot === 'owner' ? CREATOR.id : null,
            dispatcher_id: slot === 'dispatcher' ? CREATOR.id : null,
          },
        },
      };
    }
    if (url === '/api/users/assignable') {
      return { data: (config?.params as Record<string, unknown> | undefined)?.eligible_for === 'dispatcher' ? DISPATCHERS : OWNERS };
    }
    return { data: {} };
  });
}

function renderForm(ability: ReturnType<typeof buildAbility>, entry = '/leads/create') {
  return renderWithProviders(<LeadFormPage />, { ability, initialEntries: [entry] });
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/first name/i), 'Pat');
  await user.type(screen.getByLabelText(/^phone/i), '5551234567');
  await user.type(screen.getByLabelText(/service request/i), 'Fix the door');
}

/** A picker, found again each time: it mounts once the pre-fill has arrived. */
const picker = (name: 'Owner' | 'Dispatcher') => screen.getByRole('combobox', { name });
const pickerShows = (name: 'Owner' | 'Dispatcher', text: string) =>
  waitFor(() => expect(picker(name)).toHaveTextContent(text));

/** The body of the one lead the form posted. */
const postedLead = () => {
  const call = mockApi.post.mock.calls.find(([url]) => String(url).startsWith('/api/leads'));
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
  prefillAs('owner');
  mockApi.post.mockResolvedValue({ data: { lead: { id: 'e0000000-0000-0000-0000-0000000000cc', customer_id: 'c1' } } });
});

describe('the new-lead form - Owner and Dispatcher fields', () => {
  it('says Owner, never Assign to, and has a Dispatcher field beside it', async () => {
    renderForm(canCreateAndAssign);

    expect(await screen.findByRole('combobox', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Dispatcher' })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/assign to/i);
  });

  it('asks the Owner picker for owner-eligible people and the Dispatcher picker for dispatcher-eligible people', async () => {
    renderForm(canCreateAndAssign);
    await screen.findByRole('combobox', { name: 'Owner' });

    await waitFor(() => {
      const asked = mockApi.get.mock.calls
        .filter(([url]) => url === '/api/users/assignable')
        .map(([, config]) => (config as { params: Record<string, unknown> }).params.eligible_for);
      expect(asked).toEqual(expect.arrayContaining(['owner', 'dispatcher']));
    });
  });
});

describe('a person without Assign people to leads', () => {
  it('sees fixed text, not pickers: the creator as Owner and no Dispatcher when the rule gives Owner', async () => {
    prefillAs('owner');
    renderForm(canCreate);

    expect(await screen.findByText('Casey Creator')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('No dispatcher')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Owner' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Dispatcher' })).toBeNull();
  });

  it('sees the creator as Dispatcher and no Owner when the rule gives Dispatcher', async () => {
    prefillAs('dispatcher');
    renderForm(canCreate);

    expect(await screen.findByText('Casey Creator')).toBeInTheDocument();
    expect(screen.getByText('No owner')).toBeInTheDocument();
    expect(screen.queryByText('No dispatcher')).toBeNull();
  });

  it('posts no people at all: what the form shows is what the server applies', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()).not.toHaveProperty('assigned_to');
    expect(postedLead()).not.toHaveProperty('dispatcher_id');
  });
});

describe('a person with Assign people to leads', () => {
  it('sees the pre-fill in the pickers and posts it when they change nothing', async () => {
    const user = userEvent.setup();
    prefillAs('owner');
    renderForm(canCreateAndAssign);
    await pickerShows('Owner', 'Casey Creator');
    expect(picker('Dispatcher')).toHaveTextContent('No dispatcher');

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()).toMatchObject({ assigned_to: CREATOR.id, dispatcher_id: null });
  });

  it('is pre-filled as Dispatcher when the rule says so', async () => {
    prefillAs('dispatcher');
    renderForm(canCreateAndAssign);

    await pickerShows('Dispatcher', 'Casey Creator');
    expect(picker('Owner')).toHaveTextContent('No owner');
  });

  it('posts the people they change to', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await pickerShows('Owner', 'Casey Creator');

    await user.click(picker('Owner'));
    await user.click(await screen.findByRole('option', { name: 'Olive Owner' }));
    await user.click(picker('Dispatcher'));
    await user.click(await screen.findByRole('option', { name: 'Dana Dispatch' }));

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()).toMatchObject({ assigned_to: 'u-owner-a', dispatcher_id: 'u-dispatch-a' });
  });

  it('can clear the pre-filled Owner, and the lead posts with nobody in it', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await pickerShows('Owner', 'Casey Creator');

    await user.click(picker('Owner'));
    await user.click(await screen.findByRole('option', { name: 'No owner' }));
    expect(picker('Owner')).toHaveTextContent('No owner');

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.assigned_to ?? null).toBeNull();
    expect(postedLead()!.dispatcher_id ?? null).toBeNull();
    expect(within(document.body).queryByText(/warning|are you sure/i)).toBeNull();
  });

  it('shows no warning for empty people fields: the form simply saves', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await pickerShows('Owner', 'Casey Creator');
    await user.click(picker('Owner'));
    await user.click(await screen.findByRole('option', { name: 'No owner' }));
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });
});

describe('when the pre-fill cannot be loaded', () => {
  it.each([['without', canCreate], ['with', canCreateAndAssign]])('%s Assign people to leads, says so and does not save a lead blind', async (_label, ability) => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/leads/creator-prefill') throw new Error('network down');
      return { data: [] };
    });
    renderForm(ability);

    expect(await screen.findByText(/couldn't load the owner and dispatcher/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create lead/i })).toBeDisabled();
    expect(postedLead()).toBeUndefined();
  });
});

describe('the form opened from the dialer or the text inbox', () => {
  it('is the same form with the same pre-fill', async () => {
    renderForm(canCreate, '/leads/create?phone=5551234567');

    expect(await screen.findByText('Casey Creator')).toBeInTheDocument();
    expect(screen.getByText('No dispatcher')).toBeInTheDocument();
    expect(mockApi.get.mock.calls.filter(([url]) => url === '/api/leads/creator-prefill')).toHaveLength(1);
  });
});
