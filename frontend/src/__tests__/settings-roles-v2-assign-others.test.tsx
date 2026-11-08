/**
 * Scoped assignee pool — slice 1: the "Assign work to other people" switch on the LIVE Roles
 * screen. Plan: md_files/plans/permissions/2026-08-31-assignee-pool/.
 *
 * WHICH RolesPage. There are two. `pages/v2/routes/settings.routes.tsx` mounts `/settings/roles`
 * from `import('../settings/RolesPage')`, and because that import sits in `pages/v2/routes/` it
 * resolves to `pages/v2/settings/RolesPage.tsx`. The copy at `pages/settings/RolesPage.tsx` is a
 * dead v1 fork whose only importers are `settings-roles.test.tsx` and
 * `settings-roles-custom.test.tsx`. Shipping a control into that fork is how a switch reaches a
 * screen no admin can open while every suite stays green — it happened here before, with slice
 * 01's Events row. Hence this file sits beside `settings-roles-v2-events-row.test.tsx`.
 *
 * A SWITCH, NOT A MATRIX CELL. `User` IS a backend MODULES subject, so it arrives as a matrix row
 * (labelled "Users") whether or not this capability renders beside it — and those four cells are
 * about administering staff RECORDS. An admin deciding who may name other people on work is not
 * being asked whether the role may also create and deactivate logins, so the specs below assert
 * both halves: the switch is present, and the Users grid row was left exactly as it arrived.
 *
 * INERT BY DESIGN. Nothing reads the grant this writes until slice 2 adds the crew and performer
 * validators. This file therefore tests the CONTROL — that it renders, reads back, and
 * round-trips — and asserts no behaviour beyond that, because there is none yet.
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

const LABEL = /assign work to other people/i;

const vm = (role: string, assignOthers = false) => ({
  role,
  editable: true,
  matrix: {
    Customer: { read: true, create: false, update: false, delete: false },
    Lead: { read: true, create: true, update: true, delete: false },
    // The Users row rides through this screen on every Save, so it has to be asserted rather
    // than assumed from the absence of a control.
    User: { read: true, create: false, update: false, delete: false },
  },
  sensitive: {
    seeFinancials: true,
    managePayments: true,
    viewReports: false,
    editRecordIds: false,
    assignOthers,
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

function mockRole(assignOthers = false) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    const m = url.match(/\/api\/roles\/(\w+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1], assignOthers) });
    return Promise.resolve({ data: [] });
  });
}

/** The Switch beside a named sensitive row — the switches carry no label association of their
 *  own, so find the text and scope to it, as the Events-row spec does for a grid cell. */
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

describe('v2 RolesPage — assigning work to other people', () => {
  it('offers the capability as a sensitive switch on the screen that is actually routed', async () => {
    renderWithProviders(<RolesPage />);

    expect(await screen.findByText(LABEL)).toBeInTheDocument();
    expect(switchFor(LABEL)).toHaveAttribute('aria-checked', 'false');
    // It sits with the other consequential grants, not on its own somewhere.
    expect(screen.getByText('See financial data')).toBeInTheDocument();
    expect(screen.getByText('Record & refund payments')).toBeInTheDocument();
  });

  it('names BOTH surfaces it governs, so an admin is not guessing', async () => {
    renderWithProviders(<RolesPage />);
    const label = await screen.findByText(LABEL);
    // One grant spans a job's crew and a walkthrough's performers. A label naming only one of
    // them is how the next person to need the other surface ends up adding a second grant.
    expect(label.textContent?.toLowerCase()).toContain('crew');
    expect(label.textContent?.toLowerCase()).toContain('walkthrough');
  });

  it('is NOT a cell in the CRUD grid', async () => {
    renderWithProviders(<RolesPage />);
    const label = await screen.findByText(LABEL);

    expect(label.closest('tr')).toBeNull();
    expect(label.closest('table')).toBeNull();
    // The grid itself is genuinely rendered — otherwise the two assertions above are vacuous.
    expect(within(screen.getByRole('table')).getByText('Leads')).toBeInTheDocument();
  });

  it('reads the switch back ON for a role that already holds the grant', async () => {
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
    expect(savedVm().sensitive.assignOthers).toBe(true);
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
    expect(savedVm().sensitive.assignOthers).toBe(false);
  });

  // WHAT A SAVE MUST NOT MOVE. The page posts the WHOLE draft, so the Users row and the other
  // sensitive switches travel through this screen every time the admin touches this one.
  it('leaves the role’s Users grid row exactly as it arrived', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().matrix.User).toEqual(vm('SALES').matrix.User);
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
