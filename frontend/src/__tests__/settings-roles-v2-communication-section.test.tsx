/**
 * #2046 — the Communication SECTION gate switch on the LIVE Roles screen (v2, the routed fork —
 * see `settings-roles-v2-log-past.test.tsx`'s header for why this is a sibling of that file
 * rather than an addition to it, or to the dead v1 fork).
 *
 * A SWITCH, NOT A MATRIX ROW, for the same reason `logPastCommunications` is one: `Communication`
 * already has a matrix row, and its `create`/`read` grants are SHARED_BASELINE (click-to-call,
 * texts, WhatsApp, email, and the per-record Communication tab) — exposing them as a tickable
 * cell would let an admin accidentally take those away while only meaning to gate the section.
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

const LABEL = /access the communication section/i;

/** The view model the API really returns, in miniature: `Communication` IS in the backend's
 *  `MODULES`, so it arrives as a matrix cell whether or not the page renders a row for it. */
const vm = (role: string, accessCommunicationSection = false) => ({
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
    logPastCommunications: false,
    accessCommunicationSection,
    assignOthers: false,
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

function mockRole(accessCommunicationSection = false) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    const m = url.match(/\/api\/roles\/(\w+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1], accessCommunicationSection) });
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

describe('v2 RolesPage — Communication section gate', () => {
  it('offers the capability as a sensitive switch on the screen that is actually routed', async () => {
    renderWithProviders(<RolesPage />);

    const label = await screen.findByText(LABEL);
    expect(label).toBeInTheDocument();
    expect(switchFor(LABEL)).toHaveAttribute('aria-checked', 'false');
    // It sits with the other consequential grants, not on its own somewhere.
    expect(screen.getByText(/log past communications/i)).toBeInTheDocument();
  });

  it('is NOT a row in the CRUD grid', async () => {
    renderWithProviders(<RolesPage />);
    const label = await screen.findByText(LABEL);

    expect(label.closest('tr')).toBeNull();
    expect(label.closest('table')).toBeNull();
    expect(screen.queryByText('Communication')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Leads')).toBeInTheDocument();
  });

  it('reads the switch back ON for a role that already holds the capability', async () => {
    mockRole(true);
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    expect(switchFor(LABEL)).toHaveAttribute('aria-checked', 'true');
  });

  it('ticking it and saving posts sensitive.accessCommunicationSection: true', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().sensitive.accessCommunicationSection).toBe(true);
  });

  it('unticking it and saving posts sensitive.accessCommunicationSection: false', async () => {
    const user = userEvent.setup();
    mockRole(true);
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().sensitive.accessCommunicationSection).toBe(false);
  });

  // A Save the admin makes for an UNRELATED switch must not move this one. The mirror type
  // (`frontend/src/lib/api/roles.ts`) carries `accessCommunicationSection` as a required boolean,
  // so the page can never build a draft that omits it and post an absent key — the page always
  // posts what it fetched unless the admin explicitly flips this switch. Backend's matching
  // "an omitted key is preserved, not deleted" guarantee is slice 1's `frozenAbsent`/`saveWithoutTheKey`
  // case (`permissions-communication-section-backfill.test.ts`).
  it('leaves the switch untouched by an unrelated Save', async () => {
    const user = userEvent.setup();
    mockRole(true);
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);
    expect(switchFor(LABEL)).toHaveAttribute('aria-checked', 'true');

    // Flip a different switch, not this one.
    await user.click(switchFor(/log past communications/i));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().sensitive.accessCommunicationSection).toBe(true);
  });

  it('leaves the role’s Communication CRUD grants exactly as they arrived', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText(LABEL);

    await user.click(switchFor(LABEL));
    await waitFor(() => expect(capturedSave).not.toBeNull());
    await capturedSave!();

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    expect(savedVm().matrix.Communication).toEqual(vm('SALES').matrix.Communication);
  });
});
