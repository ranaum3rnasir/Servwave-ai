import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import { buildAbility } from '@/lib/ability';

/**
 * V7-03c: the inline "+ Add new type" on the lead form adds a row through `POST /api/job-types`
 * and no longer rewrites the organization's list with a PATCH. A refused add never blocks the lead.
 */

const mockUpdateOrg = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: ['Install'], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: mockUpdateOrg }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

async function openAddRowAndCommit(name: string) {
  const user = userEvent.setup();
  renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/create'] });
  await user.click(await screen.findByRole('combobox', { name: 'Job Type' }));
  await user.click(await screen.findByRole('option', { name: /add new type/i }));
  const input = await screen.findByPlaceholderText(/new job type/i);
  await user.type(input, name);
  await user.keyboard('{Enter}');
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: { id: 'jt-1', name: 'Repair' } });
});

describe('LeadFormPage (create) - inline add of a job type', () => {
  it('posts the typed name to /api/job-types and never patches the organization', async () => {
    await openAddRowAndCommit('Repair');
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/job-types', { name: 'Repair' }));
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it('closes the add row and shows no error when the add is refused (the lead is not blocked)', async () => {
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'exists' } } });
    await openAddRowAndCommit('Repair');
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText(/new job type/i)).not.toBeInTheDocument();
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });
});

describe('LeadFormPage (create) - keyboard', () => {
  it('Escape closes the add row, keeps what was typed out of the list, and returns focus to the Job Type select', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/create'] });
    await user.click(await screen.findByRole('combobox', { name: 'Job Type' }));
    await user.click(await screen.findByRole('option', { name: /add new type/i }));
    const input = await screen.findByPlaceholderText(/new job type/i);
    await user.type(input, 'Repa');
    await user.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText(/new job type/i)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Job Type' })).toHaveFocus();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
