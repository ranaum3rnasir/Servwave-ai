/**
 * Calendar Entries (Slice 01, spec §4) — the Events row on the LIVE Roles & Permissions screen.
 *
 * This file deliberately imports `@/pages/v2/settings/RolesPage`, NOT `@/pages/settings/RolesPage`.
 * There are two RolesPage files. `pages/v2/routes/settings.routes.tsx` mounts `/settings/roles` from
 * `import('../settings/RolesPage')` — and because that import sits in `pages/v2/routes/`, it resolves
 * to `pages/v2/settings/RolesPage.tsx`. The copy at `pages/settings/RolesPage.tsx` is a dead v1 fork
 * whose only importers are `settings-roles.test.tsx` and `settings-roles-custom.test.tsx`.
 *
 * Slice 01 first shipped its MODULES row into the v1 fork. Both existing suites stayed green — they
 * render the dead file — while the screen an admin actually opens had no Events row at all. This
 * test exists so that cannot happen silently again: it pins the row to the file that is routed.
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
    SUBJECTS.map((s) => [
      s,
      // DISPATCHER holds all four CalendarEntry grants by default (defaultGrants.ts); SALES holds none.
      s === 'CalendarEntry' && role === 'DISPATCHER'
        ? { read: true, create: true, update: true, delete: true }
        : { read: false, create: false, update: false, delete: false },
    ]),
  ),
  sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
  toggles: { dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false },
  scope: Object.fromEntries(SUBJECTS.map((s) => [s, 'All'])),
  general: { description: `${role} role` },
});

const ROLES = [
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 2, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
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

describe('v2 RolesPage — the Events row (Calendar Entries slice 01)', () => {
  it('renders an Events row on the screen that is actually routed at /settings/roles', async () => {
    renderWithProviders(<RolesPage />);
    expect(await screen.findByText('Events')).toBeInTheDocument();
  });

  it("shows DISPATCHER's four Events cells ticked", async () => {
    renderWithProviders(<RolesPage />);
    const label = await screen.findByText('Events');
    const row = label.closest('tr');
    expect(row).not.toBeNull();
    // The cells are Radix checkboxes: <button data-state="checked|unchecked">, not
    // <input type="checkbox">, and they carry no accessible role here — so query the state
    // attribute the component itself owns rather than an ARIA role it does not expose.
    // Scope to the button itself: Radix stamps data-state on both the checkbox root and its
    // inner indicator, so an unscoped [data-state] query returns eight nodes for four cells.
    const boxes = Array.from((row as HTMLElement).querySelectorAll('button[data-state]'));
    expect(boxes).toHaveLength(4);
    for (const b of boxes) expect(b.getAttribute('data-state')).toBe('checked');
  });
});
