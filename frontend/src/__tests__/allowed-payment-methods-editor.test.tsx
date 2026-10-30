/**
 * Roles & Permissions, PRD 2, S02.31 - the Allowed payment methods editor on both screens.
 *
 * Two seams. The shared editor, through its public props (catalog, values, onChange, and the company's effective
 * accepted list), and the two ROUTED screens that draw it (Settings > Roles and a person's Permissions page), served
 * the real answer shapes of the catalog, the role/person reads and `GET /api/permission-switches/accepted-payment-methods`.
 * Labels come from the catalog fixture and the shared payment-method labels, never written here as a second list.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import SwitchSetEditor from '@/components/permissions/SwitchSetEditor';
import { ALL_ACCEPTED, type AcceptedPaymentMethods, type SwitchSet } from '@/lib/api/permissionSwitches';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import type { PaymentMethod } from '@/lib/api/organization';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const SWITCH = 'allowed_payment_methods';
const LIST_LABEL = catalogSwitch(SWITCH).label;
const OPTIONS = catalogSwitch(SWITCH).listOptions!;
const label = (m: string) => PAYMENT_METHOD_LABELS[m as PaymentMethod];

/** The company ticked Check in Payments & Lists, with the card processor live (the server adds Credit Card). */
const CHECK_AND_CARD: AcceptedPaymentMethods = { every_method: false, methods: ['CHECK', 'CARD'] };
/** The company ticked Check only, no live processor. */
const CHECK_ONLY: AcceptedPaymentMethods = { every_method: false, methods: ['CHECK'] };
/** No manual method chosen: every method is accepted. */
const EVERY_METHOD: AcceptedPaymentMethods = { every_method: true, methods: [...OPTIONS] };

const HASNT_CHOSEN =
  "Your company hasn't chosen its accepted payment methods in Payments & Lists, so every method is allowed.";

function Harness({
  accepted,
  initial = presetSet('DISPATCHER'),
  onChange,
}: {
  accepted?: { data?: AcceptedPaymentMethods; isError: boolean };
  initial?: SwitchSet;
  onChange?: (next: SwitchSet) => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <TooltipProvider>
      <SwitchSetEditor
        catalog={FIXTURE_CATALOG}
        values={values}
        editable
        acceptedMethods={accepted}
        onChange={(next) => {
          setValues(next);
          onChange?.(next);
        }}
      />
    </TooltipProvider>
  );
}

const list = () => screen.getByRole('group', { name: LIST_LABEL });
const allAccepted = () => within(list()).getByRole('checkbox', { name: 'All accepted methods' });
/** The ticks of the checklist (everything but "All accepted methods"), by the words beside them. */
const checklist = () =>
  within(list())
    .queryAllByRole('listitem')
    .map((li) => li.textContent);

describe('Allowed payment methods editor, the shared editor', () => {
  it('starts on All accepted methods with no checklist, and the marker saved as its own value, not a list', () => {
    expect(presetSet('DISPATCHER')[SWITCH]).toBe(ALL_ACCEPTED);
    render(<Harness accepted={{ data: CHECK_AND_CARD, isError: false }} />);
    expect(allAccepted()).toBeChecked();
    expect(checklist()).toEqual([]);
  });

  it('offers exactly the company\'s methods once All accepted is unticked: Check and Credit Card with the processor live', async () => {
    const user = userEvent.setup();
    render(<Harness accepted={{ data: CHECK_AND_CARD, isError: false }} />);
    await user.click(allAccepted());
    // Today's order of the catalog's methods, filtered to the company's list.
    const expected = OPTIONS.filter((o) => CHECK_AND_CARD.methods.includes(o as PaymentMethod)).map(label);
    expect(expected).toContain('Check');
    expect(expected).toContain('Credit Card');
    expect(checklist()).toEqual(expected);
    expect(screen.queryByText(HASNT_CHOSEN)).toBeNull();
  });

  it('does not offer Credit Card when the company has Check and no live processor', async () => {
    const user = userEvent.setup();
    render(<Harness accepted={{ data: CHECK_ONLY, isError: false }} />);
    await user.click(allAccepted());
    expect(checklist()).toEqual(['Check']);
    expect(within(list()).queryByRole('checkbox', { name: 'Credit Card' })).toBeNull();
  });

  it('offers every method, with the "hasn\'t chosen" line, when the company has chosen none', async () => {
    const user = userEvent.setup();
    render(<Harness accepted={{ data: EVERY_METHOD, isError: false }} />);
    // The line shows on the default too: it explains what "All accepted methods" means for this company.
    expect(screen.getByText(HASNT_CHOSEN)).toBeInTheDocument();
    await user.click(allAccepted());
    expect(checklist()).toEqual(OPTIONS.map(label));
    expect(screen.getByText(HASNT_CHOSEN)).toBeInTheDocument();
  });

  it('saves a ticked subset, and the marker again, not the company list, when All accepted is ticked back', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness accepted={{ data: CHECK_AND_CARD, isError: false }} onChange={onChange} />);
    await user.click(allAccepted());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ [SWITCH]: [] }));
    await user.click(within(list()).getByRole('checkbox', { name: 'Check' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ [SWITCH]: ['CHECK'] }));
    await user.click(within(list()).getByRole('checkbox', { name: 'Credit Card' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ [SWITCH]: OPTIONS.filter((o) => o === 'CHECK' || o === 'CARD') }));
    await user.click(allAccepted());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ [SWITCH]: ALL_ACCEPTED }));
  });

  it('shows a saved subset ticked, and leaves out a saved method the company no longer accepts', () => {
    render(<Harness accepted={{ data: CHECK_ONLY, isError: false }} initial={{ ...presetSet('DISPATCHER'), [SWITCH]: ['CHECK'] }} />);
    expect(allAccepted()).not.toBeChecked();
    expect(within(list()).getByRole('checkbox', { name: 'Check' })).toBeChecked();
    expect(checklist()).toEqual(['Check']);
  });

  it('says the company\'s methods are loading, not a made-up list, while they are being read', async () => {
    const user = userEvent.setup();
    render(<Harness accepted={{ isError: false }} />);
    await user.click(allAccepted());
    expect(checklist()).toEqual([]);
    expect(within(list()).getByText('Loading the payment methods your company accepts...')).toBeInTheDocument();
  });

  it('says the company\'s methods could not be read when the read failed', async () => {
    const user = userEvent.setup();
    render(<Harness accepted={{ isError: true }} />);
    await user.click(allAccepted());
    expect(checklist()).toEqual([]);
    expect(within(list()).getByText("Your company's accepted payment methods can't be shown right now.")).toBeInTheDocument();
  });

  it('names no vendor in the editor\'s labels or lines, in any of the company states', async () => {
    const user = userEvent.setup();
    const vendors = /ctm|calltracking|supabase|render|stripe|twilio|resend|quickbooks/i;
    for (const state of [CHECK_AND_CARD, CHECK_ONLY, EVERY_METHOD]) {
      const view = render(<Harness accepted={{ data: state, isError: false }} />);
      await user.click(allAccepted());
      expect(list().textContent).not.toMatch(vendors);
      view.unmount();
    }
  });

  it('reads the saved set as words when it is not editable', () => {
    render(
      <TooltipProvider>
        <SwitchSetEditor catalog={FIXTURE_CATALOG} values={{ ...presetSet('DISPATCHER'), [SWITCH]: ['CHECK'] }} editable={false} onChange={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Check')).toBeInTheDocument();
  });
});

// ─── The routed screens ────────────────────────────────────────────────────────────────────────────────────────

const ROLES = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 1, type: 'system' },
];
const DISPATCHER = { key: 'DISPATCHER', label: 'Dispatcher', type: 'built_in' };
const person = (id: string, first: string, last: string, role: string) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role,
  is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
});

const manager = {
  ability: buildAbility([
    { action: 'manage_roles', subject: 'Role' },
    { action: 'read', subject: 'Role' },
    { action: 'read', subject: 'User' },
  ]),
  switches: { manage_roles_and_permissions: true, show_users_teams_page: true },
};

/** Serve the reads of both screens; the accepted-methods read answers `accepted` (or fails). */
function serve(accepted: AcceptedPaymentMethods | 'fails') {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: manager.switches, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/permission-switches/accepted-payment-methods') {
      return accepted === 'fails' ? Promise.reject(new Error('Request failed with status code 500')) : Promise.resolve({ data: accepted });
    }
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/roles/DISPATCHER/permissions') {
      return Promise.resolve({
        data: {
          role: 'DISPATCHER', label: 'Dispatcher', type: 'system', editable: true, base_role: 'DISPATCHER',
          made_from_role_key: null, made_from_blank: false, values: presetSet('DISPATCHER'), all_views_off: false,
        },
      });
    }
    if (url === '/api/users') return Promise.resolve({ data: { users: [person('u1', 'Dee', 'Spatch', 'DISPATCHER')] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users/u1/permissions') {
      return Promise.resolve({
        data: { user_id: 'u1', admin_box: false, editable: true, based_on: DISPATCHER, values: presetSet('DISPATCHER'), differences: [], difference_count: 0 },
      });
    }
    return Promise.resolve({ data: [] });
  });
}

function open(path: string) {
  return renderWithProviders(
    <Suspense fallback={null}>
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability: manager.ability },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe.each([
  ['Settings > Roles', '/settings/roles', async () => userEvent.click(await screen.findByRole('button', { name: /Dispatcher/ }))],
  ['a person\'s Permissions page', '/settings/users/u1/permissions', async () => {}],
])('Allowed payment methods on %s', (_name, path, openScreen) => {
  it('offers Check and Credit Card for a company that ticked Check with the processor live', async () => {
    serve(CHECK_AND_CARD);
    const user = userEvent.setup();
    open(path);
    await openScreen();
    const group = await screen.findByRole('group', { name: LIST_LABEL });
    await user.click(within(group).getByRole('checkbox', { name: 'All accepted methods' }));
    const items = await within(group).findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(OPTIONS.filter((o) => CHECK_AND_CARD.methods.includes(o as PaymentMethod)).map(label));
  });

  it('offers no Credit Card when the company has Check and no live processor', async () => {
    serve(CHECK_ONLY);
    const user = userEvent.setup();
    open(path);
    await openScreen();
    const group = await screen.findByRole('group', { name: LIST_LABEL });
    await user.click(within(group).getByRole('checkbox', { name: 'All accepted methods' }));
    expect((await within(group).findAllByRole('listitem')).map((li) => li.textContent)).toEqual(['Check']);
  });

  it('offers every method and shows the "hasn\'t chosen" line when the company has chosen none', async () => {
    serve(EVERY_METHOD);
    const user = userEvent.setup();
    open(path);
    await openScreen();
    const group = await screen.findByRole('group', { name: LIST_LABEL });
    expect(await within(group).findByText(HASNT_CHOSEN)).toBeInTheDocument();
    await user.click(within(group).getByRole('checkbox', { name: 'All accepted methods' }));
    expect((await within(group).findAllByRole('listitem')).map((li) => li.textContent)).toEqual(OPTIONS.map(label));
  });

  it('still draws the screen, with a notice in the list, when the accepted methods cannot be read', async () => {
    serve('fails');
    const user = userEvent.setup();
    open(path);
    await openScreen();
    const group = await screen.findByRole('group', { name: LIST_LABEL });
    await user.click(within(group).getByRole('checkbox', { name: 'All accepted methods' }));
    expect(await within(group).findByText("Your company's accepted payment methods can't be shown right now.")).toBeInTheDocument();
  });
});
