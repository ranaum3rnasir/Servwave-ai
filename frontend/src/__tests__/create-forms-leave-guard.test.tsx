/**
 * Mobile slice 66: navigating away from a half-filled lead, customer or job create form asks first.
 *
 * Before this the three create pages left on Cancel, the back link, a sidebar tap or the Back
 * button with no question, so a rep who had typed a customer's details on a phone lost them to a
 * stray tap. They now publish their dirtiness to the shared leave guard (see `useLeaveGuard`).
 * A form that only holds what the link prefilled (a phone from the dialer, a customer chosen
 * before the page opened) is clean, and a successful create never asks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { leadFormElement, serveLeadForm } from '@/__tests__/harness/leadFormPage';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const PICKER_ROW = {
  id: 'c0000000-0000-0000-0000-0000000000f1',
  first_name: 'Res',
  last_name: 'Tricted',
  company_name: null,
  phone_last4: '9999',
  city: 'Austin',
  restricted: true,
};

function renderAt(path: string, route: string, element: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <AbilityProvider ability={adminAbility}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={element} />
          </Routes>
        </MemoryRouter>
      </AbilityProvider>
    </QueryClientProvider>,
  );
}

interface FormCase {
  name: string;
  render: (search?: string) => ReturnType<typeof render>;
  /** Type one thing into the form. */
  touch: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  /** Fill what a create needs, and submit. */
  submit: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  /** The create response. */
  created: unknown;
  /** Where a successful create goes. */
  landsOn: unknown[];
}

const CASES: FormCase[] = [
  {
    name: 'lead',
    render: (search = '') => renderAt(`/leads/create${search}`, '/leads/create', leadFormElement()),
    touch: async (user) => { await user.type(await screen.findByLabelText(/first name/i), 'Jane'); },
    submit: async (user) => {
      await user.type(await screen.findByLabelText(/first name/i), 'Jane');
      await user.type(screen.getByPlaceholderText('Phone number'), '5551234567');
      await user.type(screen.getByPlaceholderText(/^describe the/i), 'Door will not latch');
      await user.click(screen.getByRole('button', { name: 'Create Lead' }));
    },
    created: { lead: { id: 'lead-9', customer_id: 'cust-9', customer: { first_name: 'Jane', last_name: '' } } },
    landsOn: ['/leads/lead-9'],
  },
  {
    name: 'job',
    render: (search = '') => renderAt(`/jobs/new${search}`, '/jobs/new', <JobFormPage />),
    touch: async (user) => { await user.type(await screen.findByLabelText(/first name/i), 'Jane'); },
    submit: async (user) => {
      await user.type(await screen.findByLabelText(/first name/i), 'Jane');
      await user.type(screen.getByPlaceholderText('Phone number'), '5551234567');
      await user.type(screen.getByPlaceholderText(/^describe the/i), 'Door will not latch');
      await user.type(screen.getByLabelText(/^address/i), '12 Main St');
      await user.type(screen.getByLabelText(/^city/i), 'Austin');
      await user.type(screen.getByLabelText(/^state/i), 'TX');
      await user.type(screen.getByLabelText(/^zip/i), '78701');
      await user.click(screen.getByRole('button', { name: 'Create Job' }));
    },
    created: { job: { id: 'job-9' } },
    landsOn: ['/jobs/job-9'],
  },
  {
    name: 'customer',
    render: (search = '') => renderAt(`/customers/new${search}`, '/customers/new', <CustomerFormPage />),
    touch: async (user) => { await user.type(await screen.findByPlaceholderText('Jane'), 'Jane'); },
    submit: async (user) => {
      await user.type(await screen.findByPlaceholderText('Jane'), 'Jane');
      await user.type(screen.getByPlaceholderText('(555) 123-4567'), '5551234567');
      await user.click(screen.getByTestId('customer-form-submit'));
    },
    created: { customer: { id: 'cust-9' } },
    landsOn: ['/customers/cust-9'],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState(null, '');
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  serveLeadForm({
    // The new-lead form shows the creator rule's pre-fill and will not save blind without it.
    creatorPrefill: { prefill: { owner_id: null, dispatcher_id: null } },
    // The new-job form shows the creator rule's pre-fill (Sold By and Dispatcher) and will not save blind without it.
    jobCreatorPrefill: { prefill: { sold_by_id: null, dispatcher_id: null } },
    picker: [PICKER_ROW],
    pickerOne: PICKER_ROW,
  });
});
afterEach(() => {
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe.each(CASES)('the $name create form leave guard', (c) => {
  it('an untouched form leaves on Cancel without a question', async () => {
    const user = userEvent.setup();
    c.render();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('Cancel on a half-filled form asks first; Keep editing keeps what was typed', async () => {
    const user = userEvent.setup();
    c.render();
    await c.touch(user);
    expect(hasUnsavedWork()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('the back link asks too, and Discard goes back', async () => {
    const user = userEvent.setup();
    c.render();
    await c.touch(user);
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(-1));
  });

  it('a tap on the sidebar, top bar or search (the shared exit path) asks first', async () => {
    const user = userEvent.setup();
    c.render();
    await c.touch(user);
    const go = vi.fn();
    useSettingsGuard.getState().requestLeave(go);
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(go).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
  });

  it('Back asks instead of leaving', async () => {
    const user = userEvent.setup();
    c.render();
    await c.touch(user);
    window.history.back();
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a successful create goes on without asking', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: c.created });
    c.render();
    await c.submit(user);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockNavigate.mock.calls[0]?.[0]).toBe(c.landsOn[0]);
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
  });
});

describe('what a link prefills is not unsaved work', () => {
  it('a lead opened from the dialer with a phone number is clean until the user edits it', async () => {
    const user = userEvent.setup();
    renderAt('/leads/create?phone=%2B15551234567', '/leads/create', leadFormElement());
    await screen.findByLabelText(/first name/i);
    expect(hasUnsavedWork()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('a lead opened for an existing customer is clean until the user edits it', async () => {
    const user = userEvent.setup();
    renderAt(`/leads/create?customer_id=${PICKER_ROW.id}`, '/leads/create', leadFormElement());
    expect(await screen.findByDisplayValue('Res')).toBeInTheDocument();
    expect(hasUnsavedWork()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('choosing a customer in the form is work: leaving asks', async () => {
    const user = userEvent.setup();
    renderAt('/leads/create', '/leads/create', leadFormElement());
    await user.type(await screen.findByLabelText(/first name/i), 'Re');
    await user.click(await screen.findByText(/Res Tricted/));
    await screen.findByDisplayValue('Res');
    // The picked customer's details arrive by the form's own setValue, which is not an edit: it is
    // the choice itself that counts as work.
    expect(hasUnsavedWork()).toBe(true);
  });
});

describe('the edit forms are not guarded by this slice', () => {
  it('a customer edit page Cancel still goes straight back', async () => {
    const user = userEvent.setup();
    serveLeadForm({
      routes: [{ match: (url) => url === '/api/customers/cust-1', data: { customer: { id: 'cust-1', first_name: 'Edit', last_name: 'Me', phone: '5551234567', email: '', service_locations: [] } } }],
    });
    renderAt('/customers/cust-1/edit', '/customers/:id/edit', <CustomerFormPage />);
    await user.type(await screen.findByDisplayValue('Edit'), 'x');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
