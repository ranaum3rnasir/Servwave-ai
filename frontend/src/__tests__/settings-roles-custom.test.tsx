import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/settings/RolesPage';

const mockApi = vi.mocked(api);

const SUBJECTS = ['Customer', 'Lead'];
const emptyMatrix = () =>
  Object.fromEntries(SUBJECTS.map((s) => [s, { read: false, create: false, update: false, delete: false }]));
const emptyToggles = {
  dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false,
};

const vm = (role: string) => ({
  role,
  editable: true,
  matrix: emptyMatrix(),
  sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
  toggles: emptyToggles,
  scope: Object.fromEntries(SUBJECTS.map((s) => [s, 'All'])),
  general: { description: '' },
});

const SALES_ROLE = { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' };
const CUSTOM_ROLE = {
  id: 'cr-1', role: 'office-manager', label: 'Office Manager', description: 'Runs the office',
  base_role: 'ADMIN', fullAccess: false, editable: true, userCount: 0, type: 'custom',
};

let roles: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  roles = [SALES_ROLE, CUSTOM_ROLE];
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: roles });
    const m = url.match(/\/api\/roles\/([\w-]+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1]) });
    return Promise.resolve({ data: [] });
  });
});

describe('RolesPage - custom role management (SRVW-138/139)', () => {
  it('badges the custom role and leaves system roles unbadged in the list', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('creates a custom role via the dialog and selects it', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({
      data: { id: 'cr-2', role: 'ops-lead', label: 'Ops Lead', description: '', base_role: 'TECHNICIAN', fullAccess: false, editable: true, userCount: 0, type: 'custom' },
    });
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /Sales/ });

    await user.click(screen.getByRole('button', { name: '+ New custom role' }));
    await user.type(screen.getByLabelText('Name'), 'Ops Lead');
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/roles', expect.objectContaining({ label: 'Ops Lead', base_role: 'TECHNICIAN' })),
    );
  });

  it('shows Rename + Archive only for the custom role, not the system role', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Office Manager/ }));
    expect(await screen.findByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('renames a custom role, prefilled from the current label/description', async () => {
    const user = userEvent.setup();
    mockApi.patch.mockResolvedValue({ data: { ...CUSTOM_ROLE, label: 'Ops Lead' } });
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /Sales/ });

    await user.click(screen.getByRole('button', { name: /Office Manager/ }));
    await user.click(await screen.findByRole('button', { name: 'Rename' }));

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('Office Manager');
    await user.clear(nameInput);
    await user.type(nameInput, 'Ops Lead');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/roles/office-manager', expect.objectContaining({ label: 'Ops Lead' })),
    );
  });

  it('archives a custom role after the confirm dialog', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /Sales/ });

    await user.click(screen.getByRole('button', { name: /Office Manager/ }));
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await user.click(screen.getByRole('button', { name: 'Archive role' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/roles/office-manager/archive'));
  });

  it('renders the 5 SRVW-139 toggle rows in an Access card', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(await screen.findByText('Dashboard access')).toBeInTheDocument();
    expect(screen.getByText('Account settings')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Modify done jobs')).toBeInTheDocument();
    expect(screen.getByText('Cancel jobs')).toBeInTheDocument();
  });
});
