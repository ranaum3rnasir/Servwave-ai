/**
 * Scheduling-notifications slice 07: the visit milestone is called "on the way" everywhere a user
 * reads it. This pins the Roles & Permissions toggle for the `en_route Job` verb on the ROUTED
 * RolesPage (`pages/v2/settings/RolesPage`, see settings-roles-v2-events-row.test.tsx for why the
 * v1 fork is not the file to test). The toggle KEY (`enRouteJobs`) and the grant it writes are
 * untouched; only the words change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';

const mockApi = vi.mocked(api);

const SUBJECTS = ['Customer', 'Lead', 'Estimate', 'Job', 'Invoice', 'CalendarEntry'];
const vm = (role: string) => ({
  role,
  editable: true,
  matrix: Object.fromEntries(
    SUBJECTS.map((s) => [s, { read: false, create: false, update: false, delete: false }]),
  ),
  sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
  toggles: {
    dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false,
    enRouteJobs: false, arriveJobs: false, startJobs: false, completeJobs: false, rescheduleJobs: false,
  },
  scope: Object.fromEntries(SUBJECTS.map((s) => [s, 'All'])),
  general: { description: `${role} role` },
});

const ROLES = [
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 2, type: 'system' },
];

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    const m = url.match(/\/api\/roles\/(\w+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1]) });
    return Promise.resolve({ data: [] });
  });
});

describe('v2 RolesPage - the on-the-way milestone toggle', () => {
  it('labels the en_route Job toggle "Mark on the way"', async () => {
    renderWithProviders(<RolesPage />);
    expect(await screen.findByText('Mark on the way')).toBeInTheDocument();
  });

  it('never says "en route" anywhere on the roles editor', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByText('Job Milestones');
    expect(screen.queryByText(/en[ -]route/i)).toBeNull();
  });
});
