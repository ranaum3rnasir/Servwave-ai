/**
 * Manual Communication Log — slice 4: the sensitive-capability switch on the LIVE Roles screen.
 *
 * WHICH RolesPage. There are two. `pages/v2/routes/settings.routes.tsx` mounts `/settings/roles`
 * from `import('../settings/RolesPage')`, and because that import sits in `pages/v2/routes/` it
 * resolves to `pages/v2/settings/RolesPage.tsx`. The copy at `pages/settings/RolesPage.tsx` is a
 * dead v1 fork whose only importers are `settings-roles.test.tsx` and
 * `settings-roles-custom.test.tsx` — which is exactly why this file is a sibling of
 * `settings-roles-v2-events-row.test.tsx` rather than an addition to either of those: extending
 * the suite that drives the dead fork is how a control ships to a screen no admin can open while
 * the tests stay green. It has happened here before (slice 01's Events row).
 *
 * A SWITCH, NOT A MATRIX ROW. The grid is modules × create/read/update/delete, and adding
 * `Communication` to it would expose the baseline `create Communication` grant — which gates
 * click-to-call, texts, WhatsApp and email — as an admin-editable cell. So the capability sits
 * with the other consequential single grants, and the specs below assert both halves: that the
 * switch is there, and that no Communication row appeared in the grid beside it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';

const mockApi = vi.mocked(api);

// The Save button lives in the v2 settings shell, not in the page, so the page hands the shell a
// saver through this context. Capture it and invoke it, the way the shell's button would.
let capturedSave: (() => Promise<void> | void) | null = null;
vi.mock('@/pages/v2/settings/settingsBar', () => ({
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void }) => {
      capturedSave = fns.save;
    },
  }),
}));

const LABEL = /log past communications/i;

/**
 * The view model the API really returns, in miniature: `Communication` IS in the backend's
 * `MODULES`, so it arrives as a matrix cell whether or not the page renders a row for it. That
 * matters — the page posts the whole draft back, so the baseline `create Communication` grant
 * rides through this screen on every Save.
 */
const vm = (role: string, logPast = false) => ({
  role,
  editable: true,
  matrix: {
    Customer: { read: true, create: false, update: false, delete: false },
    Lead: { read: true, create: true, update: true, delete: false },
    Communication: { read: true, create: true, update: false, delete: false },
  },
  sensitive: {
    seeFinancials: true,
    managePayments: true,
    viewReports: false,
    editRecordIds: false,
    logPastCommunications: logPast,
  },
  toggles: {
    dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false,
    cancelJobs: false, enRouteJobs: false, arriveJobs: false, startJobs: false,
    completeJobs: false, rescheduleJobs: false,
  },
  scope: { Lead: 'All', Job: 'All', Estimate: 'All', Invoice: 'All' },
  general: { description: `${role} role` },
});

const ROLES = [
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
];

function mockRole(logPast = false) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    const m = url.match(/\/api\/roles\/(\w+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1], logPast) });
    return Promise.resolve({ data: [] });
  });
}

/** The Switch beside a named sensitive row. The switches carry no label association of their own,
 *  so address it the way the Events-row spec addresses a grid cell: find the text, scope to it. */
function switchFor(label: RegExp | string) {
  const row = screen.getByText(label).closest('div') as HTMLElement;
  return within(row).getByRole('switch');
}

/** What the page posted, once. */
function savedVm() {
  expect(mockApi.put).toHaveBeenCalledTimes(1);
  const [url, body] = mockApi.put.mock.calls[0] as [string, Record<string, never>];
  expect(url).toBe('/api/roles/SALES/permissions');
  return body as unknown as ReturnType<typeof vm>;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedSave = null;
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockApi.put.mockResolvedValue({ data: {} });
  mockRole();
});

describe('v2 RolesPage — logging past communications', () => {
  it('offers the capability as a sensitive switch on the screen that is actually routed', async () => {
    renderWithProviders(<RolesPage />);

    const label = await screen.findByText(LABEL);
    expect(label).toBeInTheDocument();
    expect(switchFor(LABEL)).toHaveAttribute('aria-checked', 'false');
    // It sits with the other consequential grants, not on its own somewhere.
    expect(screen.getByText('See financial data')).toBeInTheDocument();
    expect(screen.getByText('Record & refund payments')).toBeInTheDocument();
  });

  it('is NOT a row in the CRUD grid', async () => {
    renderWithProviders(<RolesPage />);
    const label = await screen.findByText(LABEL);

    // The switch is outside the table entirely…
    expect(label.closest('tr')).toBeNull();
    expect(label.closest('table')).toBeNull();
    // …and no module row was added for it either, so `create Communication` is not on screen as a
    // cell anybody can untick.
    expect(screen.queryByText('Communication')).not.toBeInTheDocument();
    // The grid itself is genuinely rendered - otherwise the two assertions above are vacuous.
    expect(within(screen.getByRole('table')).getByText('Leads')).toBeInTheDocument();
  });

  it('reads the switch back ON for a role that already holds the capability', async () => {
    mockRole(true);
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    expect(switchFor(LABEL)).toHaveAttribute('aria-checked', 'true');
  });

  it('ticking it and saving grants the capability to that role', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().sensitive.logPastCommunications).toBe(true);
  });

  it('unticking it and saving revokes it', async () => {
    const user = userEvent.setup();
    mockRole(true);
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().sensitive.logPastCommunications).toBe(false);
  });

  // THE TWO THINGS A SAVE MUST NOT MOVE.
  //
  // `create Communication` is SHARED_BASELINE and gates click-to-call, sending texts, WhatsApp and
  // email. The page posts the WHOLE draft, so that cell travels through this screen on every Save
  // even though no row renders it - which is precisely why it has to be asserted here rather than
  // assumed from the absence of a row.
  it('leaves the role’s Communication grants exactly as they arrived', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().matrix.Communication).toEqual(vm('SALES').matrix.Communication);
    expect(savedVm().matrix.Communication.create).toBe(true);
  });

  it('leaves See financial data and Record & refund payments alone', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const saved = savedVm().sensitive;
    expect(saved.seeFinancials).toBe(true);
    expect(saved.managePayments).toBe(true);
    // …and the switches on screen still say so, which is what the admin would check.
    expect(switchFor('See financial data')).toHaveAttribute('aria-checked', 'true');
    expect(switchFor('Record & refund payments')).toHaveAttribute('aria-checked', 'true');
  });
});
