/**
 * Mobile slice 25 (rubric A11Y-03): the controls the audit found unnamed now have a name a screen
 * reader announces. The Roles matrix said "switch" 40 times with no hint of which module or verb,
 * and a tag chip's remove button said only "button".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '../helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { TagInput } from '@/components/leads/TagInput';
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

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') {
      return Promise.resolve({
        data: [{ role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 2, type: 'system' }],
      });
    }
    const m = url.match(/\/api\/roles\/(\w+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1]!) });
    if (url === '/api/tags') return Promise.resolve({ data: { tags: [] } });
    return Promise.resolve({ data: [] });
  });
});

describe('Roles switches are named (v2 RolesPage, the routed one)', () => {
  it('names each matrix switch by its verb and module', async () => {
    renderWithProviders(<RolesPage />);
    expect(await screen.findByRole('switch', { name: 'View Customers' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Delete Invoices' })).toBeInTheDocument();
  });

  it('leaves no switch on the page without a name', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByText('Mark on the way');
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThan(10);
    const unnamed = switches.filter((s) => {
      const labelledBy = s.getAttribute('aria-labelledby');
      const byId = labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : '';
      return !(s.getAttribute('aria-label')?.trim() || byId);
    });
    expect(unnamed).toHaveLength(0);
  });
});

describe('a tag chip remove button is named', () => {
  it('says which tag it removes', () => {
    renderWithProviders(
      <TagInput entityType="LEAD" entityId="lead-1" tags={[{ id: 't1', name: 'VIP', color: '#0f766e' }]} />,
    );
    expect(screen.getByRole('button', { name: 'Remove tag VIP' })).toBeInTheDocument();
  });
});
