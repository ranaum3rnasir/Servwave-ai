/**
 * Mobile slice 29: Settings > Users & Teams and Roles & Permissions on a phone and an iPad.
 *
 * jsdom applies no CSS, so breakpoint layout is checked through the classes that carry it (the
 * mobile gate's settings-users-roles.spec.ts measures the real thing on six devices). The users
 * card list is a JS swap (useMediaQuery), so only ONE of table and cards is ever mounted, and that
 * is driven through window.matchMedia here exactly as a narrow window would answer it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import RolesPage from '@/pages/v2/settings/RolesPage';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const SUBJECTS = ['Customer', 'Lead', 'Estimate', 'Job', 'Invoice', 'CalendarEntry'];
const vm = (role: string) => ({
  role,
  editable: true,
  matrix: Object.fromEntries(SUBJECTS.map((s) => [s, { read: false, create: false, update: false, delete: false }])),
  sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
  toggles: {
    dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false,
    enRouteJobs: false, arriveJobs: false, startJobs: false, completeJobs: false, rescheduleJobs: false,
  },
  scope: Object.fromEntries(SUBJECTS.map((s) => [s, 'All'])),
  general: { description: `${role} role` },
});
const ROLES = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 2, type: 'system' },
];

const USERS = [
  {
    id: 'u1', email: 'tess@test.com', first_name: 'Tess', last_name: 'Tech', role: 'TECHNICIAN',
    is_active: true, has_login: false, phone: '+15551112222', phone_ext: null, department_id: null,
    department: null, enforce_clock_in_location: true, can_approve_clock_overrides: false,
    created_at: '', updated_at: '',
  },
  {
    id: 'u2', email: 'sam@test.com', first_name: 'Sam', last_name: 'Sales', role: 'SALES',
    is_active: false, has_login: true, phone: '', phone_ext: null, department_id: null,
    department: null, enforce_clock_in_location: false, can_approve_clock_overrides: false,
    created_at: '', updated_at: '',
  },
];

const originalMatchMedia = window.matchMedia;
function windowWidth(px: number) {
  window.matchMedia = vi.fn((query: string) => {
    const q = query.replace(/\s+/g, '');
    const widths = [...q.matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
    const matches = widths.length > 0 && widths.every(([, k, v]) => (k === 'max' ? px <= Number(v) : px >= Number(v)));
    return {
      matches, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    const m = url.match(/\/api\/roles\/(\w+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1]) });
    if (url === '/api/users') return Promise.resolve({ data: { users: USERS } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: [] });
  });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('Roles & Permissions: one column below xl', () => {
  it('stacks the roles list above the detail below xl and keeps them side by side from xl', async () => {
    renderWithProviders(<RolesPage />, { ability: ADMIN });
    await screen.findByRole('heading', { name: 'Admin' });

    const list = screen.getByRole('group', { name: 'Roles' });
    const container = list.parentElement!;
    // Below xl the two panes are one column; the fixed 224 px list is an xl-only width.
    expect(container).toHaveClass('flex-col', 'xl:flex-row');
    expect(list).not.toHaveClass('w-56');
    expect(list).toHaveClass('xl:w-56');
    // Each role is still a button in the list.
    expect(within(list).getByRole('button', { name: /Technician/ })).toBeInTheDocument();
  });

  it('lets the role header and every switch row wrap instead of pushing past the edge', async () => {
    renderWithProviders(<RolesPage />, { ability: ADMIN });
    await screen.findByRole('heading', { name: 'Admin' });
    const heading = screen.getByRole('heading', { name: 'Admin' });
    expect(heading.closest('.flex')).toHaveClass('flex-wrap');

    const row = screen.getByText('See financial data').parentElement!;
    expect(row).toHaveClass('gap-3');
    expect(screen.getByText('See financial data')).toHaveClass('min-w-0');
  });
});

describe('Users & Teams: cards below md', () => {
  it('renders the users as a card list, with no table, below md', async () => {
    windowWidth(393);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    const list = await screen.findByRole('list', { name: 'Users' });
    expect(screen.queryByRole('table')).toBeNull();

    const cards = await within(list).findAllByRole('listitem');
    expect(cards).toHaveLength(2);
    // Every row's facts and controls are on the card.
    const tess = cards[0];
    expect(within(tess).getByText('Tess Tech')).toBeInTheDocument();
    expect(within(tess).getByText('tess@test.com')).toBeInTheDocument();
    expect(within(tess).getByText('No login')).toBeInTheDocument();
    expect(within(tess).getByRole('combobox', { name: 'Role for Tess Tech' })).toBeInTheDocument();
    expect(within(tess).getByRole('combobox', { name: 'Team for Tess Tech' })).toBeInTheDocument();
    expect(within(tess).getByRole('switch', { name: 'Enforce clock-in location' })).toBeInTheDocument();
    expect(within(tess).getByText('Active')).toBeInTheDocument();
    for (const name of ['Edit', 'Permissions', 'Send invite', 'Deactivate']) {
      expect(within(tess).getByRole('button', { name })).toBeInTheDocument();
    }
    const sam = cards[1];
    expect(within(sam).getByText('No phone')).toBeInTheDocument();
    expect(within(sam).getByText('Inactive')).toBeInTheDocument();
    expect(within(sam).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('keeps the table from md, as before', async () => {
    windowWidth(768);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Users' })).toBeNull();
  });

  it('lets the filter row wrap so Invite User stays on screen', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    const invite = await screen.findByRole('button', { name: '+ Invite User' });
    expect(invite.parentElement).toHaveClass('flex-wrap');
  });
});
