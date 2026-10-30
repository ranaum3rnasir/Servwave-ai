/**
 * Roles & Permissions, PRD 10, S10.25 - the mailbox marks in a person's Permissions page header.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`) with the real Permissions page, serving the catalog, the
 * people list and the person's set in the shapes the real routes answer. "Address needed" with "Set address", and
 * "Can't read: Email page is off for this person" read from the switches AS THEY STAND ON THE PAGE, so the mark appears
 * and goes as the admin flips the switch, before saving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { CANT_READ_PERSON_MARK } from '@/lib/api/permissionSwitches';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const SUFFIX = '.acme@mail.test.com';
const person = (over: Record<string, unknown> = {}) => ({
  id: 'u1', email: 'dee@signin.test', first_name: 'Dee', last_name: 'Spatch', role: 'DISPATCHER',
  custom_role_id: null, custom_role: null, admin_box: false, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null,
  department_id: null, department: null, enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
  mailbox: null, email_page_closed: false, ...over,
});
const personSet = (values = presetSet('DISPATCHER')) => ({
  user_id: 'u1', admin_box: false, editable: true, based_on: { key: 'DISPATCHER', label: 'Dispatcher', type: 'built_in' },
  values, differences: [], difference_count: 0,
});

const MANAGER_AND_EDITOR = buildAbility([
  { action: 'manage_roles', subject: 'Role' },
  { action: 'read', subject: 'Role' },
  { action: 'read', subject: 'User' },
  { action: 'update', subject: 'User' },
]);
const MANAGER_ONLY = buildAbility([
  { action: 'manage_roles', subject: 'Role' },
  { action: 'read', subject: 'Role' },
  { action: 'read', subject: 'User' },
]);

function open(user: ReturnType<typeof person>, set = personSet(), ability = MANAGER_AND_EDITOR) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: { manage_roles_and_permissions: true, view_users: true }, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/roles') return Promise.resolve({ data: [{ role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 1, type: 'system' }] });
    if (url === '/api/users') return Promise.resolve({ data: { users: [user] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users/u1/permissions') return Promise.resolve({ data: set });
    return Promise.resolve({ data: [] });
  });
  return renderWithProviders(
    <Suspense fallback={null}>
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: ['/settings/users/u1/permissions'], ability },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

const header = async () => {
  await screen.findByRole('heading', { name: /Dee Spatch/ });
  return document.querySelector('[data-person-header]') as HTMLElement;
};

describe('the Permissions page header: "Address needed"', () => {
  it('marks a person with no address and offers Set address to a holder of Edit users', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { mailbox: { status: 'active', address: 'dee.spatch.acme@mail.test.com' } } });
    open(person({ mailbox: { status: 'address_needed', address: null, address_suffix: SUFFIX } }));

    const h = await header();
    expect(await within(h).findByText('Address needed')).toBeInTheDocument();
    await user.click(within(h).getByRole('button', { name: 'Set address' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(SUFFIX)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Address'), 'dee.spatch');
    await user.click(within(dialog).getByRole('button', { name: 'Set address' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith('/api/users/u1/mailbox-address', { name_part: 'dee.spatch' }));
  });

  it('shows the mark but no Set address to a viewer without Edit users, and nothing to a person who has an address', async () => {
    const { unmount } = open(person({ mailbox: { status: 'address_needed', address: null, address_suffix: SUFFIX } }), personSet(), MANAGER_ONLY);
    const h = await header();
    expect(await within(h).findByText('Address needed')).toBeInTheDocument();
    expect(within(h).queryByRole('button', { name: 'Set address' })).toBeNull();
    unmount();

    open(person({ mailbox: { status: 'active', address: 'dee.spatch.acme@mail.test.com', address_suffix: SUFFIX } }));
    const h2 = await header();
    expect(within(h2).queryByText('Address needed')).toBeNull();
    expect(within(h2).queryByRole('button', { name: 'Set address' })).toBeNull();
  });
});

describe('the Permissions page header: "Can\'t read"', () => {
  it('shows no mark for a person on a built-in preset', async () => {
    open(person({ mailbox: { status: 'active', address: 'dee.spatch.acme@mail.test.com', address_suffix: SUFFIX } }));
    const h = await header();
    await screen.findByRole('switch', { name: catalogSwitch('show_email').label });
    expect(within(h).queryByText(CANT_READ_PERSON_MARK)).toBeNull();
  });

  it('marks a person whose saved switches have Show Email off, and the mark goes when it is turned back on, before saving', async () => {
    const user = userEvent.setup();
    open(
      person({ mailbox: { status: 'active', address: 'dee.spatch.acme@mail.test.com', address_suffix: SUFFIX }, email_page_closed: true }),
      personSet({ ...presetSet('DISPATCHER'), show_email: false }),
    );
    const h = await header();
    expect(await within(h).findByText(CANT_READ_PERSON_MARK)).toBeInTheDocument();

    await user.click(await screen.findByRole('switch', { name: catalogSwitch('show_email').label }));
    expect(within(h).queryByText(CANT_READ_PERSON_MARK)).toBeNull();
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('appears as Show Email, or Access Communication, is flipped off on the page, and goes when it is flipped back', async () => {
    const user = userEvent.setup();
    open(person({ mailbox: { status: 'active', address: 'dee.spatch.acme@mail.test.com', address_suffix: SUFFIX } }));
    const h = await header();

    const showEmail = await screen.findByRole('switch', { name: catalogSwitch('show_email').label });
    await user.click(showEmail);
    expect(await within(h).findByText(CANT_READ_PERSON_MARK)).toBeInTheDocument();
    await user.click(showEmail);
    expect(within(h).queryByText(CANT_READ_PERSON_MARK)).toBeNull();

    // Access Communication off turns Show Email off with it (Show Email needs it)
    await user.click(screen.getByRole('switch', { name: catalogSwitch('access_communication').label }));
    expect(await within(h).findByText(CANT_READ_PERSON_MARK)).toBeInTheDocument();
  });
});
