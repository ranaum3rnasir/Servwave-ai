import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import UsersTeamsPage from '@/pages/settings/UsersTeamsPage';

// Regression guard for the RBAC QA browser-pass finding (2026-06-18): a DISPATCHER
// (read User only) was shown the FULL Settings → Users admin editor — Invite User,
// editable role/team dropdowns, Edit/Permissions/Deactivate — even though the backend
// 403s every write. The FE must gate every user-management mutation control on the
// CASL ability so a read-only viewer sees a read-only table.
const mockApi = vi.mocked(api);

const USER = {
  id: 'u1',
  email: 'tess@test.com',
  first_name: 'Tess',
  last_name: 'Tech',
  role: 'TECHNICIAN',
  is_active: true,
  has_login: true,
  phone: '5551112222',
  phone_ext: null,
  department_id: null,
  department: null,
  enforce_clock_in_location: true,
  can_approve_clock_overrides: false,
  created_at: '',
  updated_at: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [USER] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    // SRVW-138/139 - the role picker (roleAssignmentOptions) reads this list directly.
    if (url === '/api/roles') {
      return Promise.resolve({
        data: [
          { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 0, type: 'system' },
          { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 0, type: 'system' },
          { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 0, type: 'system' },
          { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 1, type: 'system' },
        ],
      });
    }
    return Promise.resolve({ data: {} });
  });
  mockApi.patch.mockResolvedValue({ data: { user: USER } });
});

// Mirrors the dispatcher default grant: read User, nothing else.
const READ_ONLY = buildAbility([{ action: 'read', subject: 'User' }]);
// Admin = manage all.
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

describe('UsersTeamsPage — RBAC gating of mutation controls', () => {
  it('a read-User-only viewer (dispatcher) sees a read-only table — no management controls', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: READ_ONLY });
    await screen.findByText('Tess Tech');

    // No create-user affordance.
    expect(screen.queryByRole('button', { name: /invite user/i })).toBeNull();
    // No editable selects (role / team) → the row is not mutable.
    expect(screen.queryByRole('combobox')).toBeNull();
    // No per-row mutation actions.
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^permissions$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^deactivate$/i })).toBeNull();
    // …but the user's role is still visible as read-only text.
    expect(screen.getByText('TECHNICIAN')).toBeInTheDocument();
  });

  it('an admin (manage all) still sees the full management controls', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    expect(screen.getByRole('button', { name: /invite user/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^permissions$/i })).toBeInTheDocument();
    // Role + team are editable selects.
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
  });
});
