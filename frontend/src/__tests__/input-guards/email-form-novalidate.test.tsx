import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import { buildAbility } from '@/lib/ability';

/**
 * Mobile slice 23 staging fix. The customer Email on the create-lead and
 * create-job forms became `type="email"` (field kinds). Inside a <form> without
 * `noValidate`, the browser then runs its own constraint check on submit: it
 * shows its own "Please include an '@'..." popup and never fires onSubmit, so
 * the app's inline "Invalid email" message never renders. The invoice form
 * already guards the same trap (#260). The app's schema owns validation, so
 * every form carrying an email field opts out of the browser's.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    // The new-lead form shows the creator rule's pre-fill and will not save blind without it.
    if (url === '/api/leads/creator-prefill') return { data: { prefill: { owner_id: null, dispatcher_id: null } } };
    // The new-job form shows the creator rule's pre-fill (Sold By and Dispatcher) and will not save blind without it.
    if (url === '/api/jobs/creator-prefill') return { data: { prefill: { sold_by_id: null, dispatcher_id: null } } };
    if (url === '/api/customers/picker') return { data: { customers: [] } };
    return { data: {} };
  });
});

const CASES = [
  { name: 'create lead', render: () => renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/create'] }), submit: /create lead/i },
  { name: 'create job', render: () => renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] }), submit: /create job/i },
] as const;

describe.each(CASES)('$name: an invalid email shows the app message, not the browser popup', ({ render, submit }) => {
  it('the form around the email field leaves validation to the app (noValidate)', () => {
    render();
    const email = screen.getByLabelText(/^email/i) as HTMLInputElement;
    expect(email.type).toBe('email');
    expect(email.form).not.toBeNull();
    expect(email.form!.noValidate).toBe(true);
  });

  it('submitting "abc" renders the inline "Invalid email" and sends nothing', async () => {
    const user = userEvent.setup();
    render();
    await user.type(screen.getByLabelText(/first name/i), 'Zzqa');
    await user.type(screen.getByLabelText(/^email/i), 'abc');
    await user.click(screen.getByRole('button', { name: submit }));
    await waitFor(() => expect(screen.getByText('Invalid email')).toBeInTheDocument());
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
