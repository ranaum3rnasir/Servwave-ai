/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.19 - the routed v2 sidebar follows the person's switches.
 *
 * A record module's entry shows when its View is on (the Show-page switches are retired, P1); a page's entry (Schedule, Reports,
 * Billing, Marketing) when its Access switch is on; the Dashboard entry always. The values come from the "me"
 * answer (`GET /api/permission-switches/me`); the compiled rules are never what decides a menu entry here, so every
 * person below holds an EMPTY ability and only their switches differ. Each person is a custom role built from
 * switch values, never a built-in role name. The preset values are read from the backend catalog file itself (the
 * source of truth), the way the Schedule board's switch suite does, because the catalog module is not importable
 * into the browser build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility, emptyAbility, type AbilityRule } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/Dialer', () => ({ GlobalDialer: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

const mockApi = vi.mocked(api);

// ─── The catalog, read from its source ──────────────────────────────────────────────────────────────────

type BuiltInRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';
const PRESET_ORDER: BuiltInRole[] = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'];

interface CatalogToggle {
  key: string;
  grants: Array<{ action: string; subject: string }>;
  presets: Record<BuiltInRole, boolean>;
}

const CATALOG: CatalogToggle[] = (() => {
  const source = readFileSync(
    join(__dirname, '../../../../../backend/src/lib/permissions/switches/catalog.ts'),
    'utf8',
  );
  const out: CatalogToggle[] = [];
  for (const block of source.split(/\n {2}entry\(\{/).slice(1)) {
    const key = /key: '([a-z_0-9]+)'/.exec(block)?.[1];
    const presetArgs = /presets: presets\(([^)]*)\)/.exec(block)?.[1];
    if (!key || !presetArgs) continue;
    const values = presetArgs.split(',').map((v) => v.trim());
    if (values.some((v) => v !== 'true' && v !== 'false')) continue; // a choice or list switch
    const grantsText = /grants: \[([\s\S]*?)\],\n\s+(?:serverChecks|pending|presets)/.exec(block)?.[1] ?? '';
    const grants = [...grantsText.matchAll(/action: '(\w+)', subject: '(\w+)'/g)].map((m) => ({
      action: m[1]!,
      subject: m[2]!,
    }));
    out.push({
      key,
      grants,
      presets: Object.fromEntries(PRESET_ORDER.map((r, i) => [r, values[i] === 'true'])) as Record<BuiltInRole, boolean>,
    });
  }
  return out;
})();

/** A custom role: every switch off except these. */
function valuesWith(...on: string[]): Record<string, boolean> {
  const values = Object.fromEntries(CATALOG.map((e) => [e.key, false]));
  for (const key of on) {
    if (!(key in values)) throw new Error(`unknown switch ${key}`);
    values[key] = true;
  }
  return values;
}

/** A custom role copied from a preset. */
function copiedFrom(role: BuiltInRole): Record<string, boolean> {
  return Object.fromEntries(CATALOG.map((e) => [e.key, e.presets[role]]));
}

/** The rules a person's switches compile into (class-level, as the server compiles them). */
function rulesFrom(values: Record<string, boolean>): AbilityRule[] {
  return CATALOG.filter((e) => values[e.key]).flatMap((e) =>
    e.grants.map((g) => ({ action: g.action, subject: g.subject }) as AbilityRule),
  );
}

// ─── Harness ─────────────────────────────────────────────────────────────────────────────────────────────

const USER_ID = '00000000-0000-0000-0000-000000000001';

/** A real org with every plan feature, so a plan lock is never why a row is missing. */
const ORG_USER = {
  id: USER_ID,
  email: 'person@test.com',
  first_name: 'Test',
  last_name: 'Person',
  role: 'TECHNICIAN',
  org_features: ['leads', 'service_plans', 'automations', 'inventory', 'phone', 'email'],
};

function answerMe(values: Record<string, boolean>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') {
      return { data: { admin_box: false, values, rules: rulesFrom(values) } };
    }
    return { data: {} };
  });
}

function renderShell(user: Record<string, unknown> = ORG_USER, ability = emptyAbility) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null } as never),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={ability}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Every destination row's label, in the order the column renders them. */
function menu(): string[] {
  const nav = document.querySelector('[data-slot="sidebar-nav"]');
  return Array.from(nav?.querySelectorAll('[data-slot="sidebar-item"]') ?? []).map(
    (row) => row.getAttribute('title') ?? '',
  );
}

/** Waits for the "me" answer to land and the menu to settle on `entries` (compared as a set, Dashboard included). */
async function expectMenu(entries: string[]) {
  await waitFor(() => expect([...menu()].sort()).toEqual([...entries].sort()));
}

/**
 * Waits until the "me" answer has landed in the query cache and been drawn. A menu assertion made before this point
 * would pass on the pre-answer paint (Dashboard only) whatever the registry does, so every assertion that an entry is
 * ABSENT either waits here first or renders a witness entry (see WITNESS) that only appears once the answer is in.
 */
async function answerApplied(client: QueryClient) {
  await waitFor(() => {
    const state = client.getQueryState(['permission-switches', 'me', USER_ID]);
    expect(state?.status).toBe('success');
    expect(state?.dataUpdatedAt).toBeGreaterThan(0);
  });
  await act(async () => {});
}

/**
 * A second, known-shown entry switched on beside the one under test. It only draws once the answer is applied, so
 * "the entry under test is absent" is read from a menu that has been drawn from the answer, not from the pre-answer
 * paint. It is never one of the record modules under test.
 */
const WITNESS = { label: 'Schedule', access: 'access_schedule' } as const;

const ALL_ACCESS: Array<[label: string, access: string]> = [
  ['Schedule', 'access_schedule'],
  ['Reports', 'access_reports'],
  ['Billing', 'access_billing'],
  ['Marketing', 'access_marketing'],
];

describe('v2 sidebar - follows View, or Access', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
  });

  it.each([
    ['Customers', 'view_customers'],
    ['Leads', 'view_leads'],
    ['Jobs', 'view_jobs'],
    ['Estimates', 'view_estimates'],
    ['Invoices', 'view_invoices'],
    ['Payments', 'view_payments'],
    ['Tasks', 'view_tasks'],
    ['Service Plans', 'view_service_plans'],
    ['Automations', 'view_automations'],
  ])('%s shows with %s on', async (label, view) => {
    answerMe(valuesWith(view));
    renderShell();
    await expectMenu(['Dashboard', label]);
  });

  it.each([
    ['Customers', 'view_customers'],
    ['Leads', 'view_leads'],
    ['Jobs', 'view_jobs'],
    ['Estimates', 'view_estimates'],
    ['Invoices', 'view_invoices'],
    ['Payments', 'view_payments'],
    ['Tasks', 'view_tasks'],
    ['Service Plans', 'view_service_plans'],
    ['Automations', 'view_automations'],
  ])('%s is missing with its View off', async (label) => {
    // The witness (Schedule) is on, so the menu is only ever [Dashboard, Schedule] once the answer is drawn; the
    // entry under test must be absent from that drawn menu.
    answerMe(valuesWith(WITNESS.access));
    renderShell();
    await expectMenu(['Dashboard', WITNESS.label]);
    expect(menu()).not.toContain(label);
  });

  it.each([
    ['Schedule', 'access_schedule'],
    ['Reports', 'access_reports'],
    ['Billing', 'access_billing'],
  ])('%s shows only with %s on', async (label, access) => {
    answerMe(valuesWith(access));
    renderShell();
    await expectMenu(['Dashboard', label]);
  });

  it.each(ALL_ACCESS)('%s is hidden when its Access switch is off, whatever the other pages hold', async (label) => {
    // Every other page's Access is on; only this one is off. Marketing is a demo-org page, so the person is in one.
    const others = ALL_ACCESS.filter(([other]) => other !== label);
    answerMe(valuesWith(...others.map(([, access]) => access)));
    renderShell({ ...ORG_USER, org_is_demo: true });
    await expectMenu(['Dashboard', ...others.map(([other]) => other)]);
    expect(menu()).not.toContain(label);
  });

  it('shows the Dashboard entry for a person with every switch off, once the answer is in', async () => {
    answerMe(valuesWith());
    const { client } = renderShell();
    await answerApplied(client);
    expect(menu()).toEqual(['Dashboard']);
  });

  it('shows the Dashboard entry for a person with every switch on, once the answer is in', async () => {
    answerMe(Object.fromEntries(CATALOG.map((e) => [e.key, true])));
    const { client } = renderShell();
    await answerApplied(client);
    expect(menu()).toContain('Dashboard');
    expect(menu().length).toBeGreaterThan(5);
  });

  it.each(PRESET_ORDER)('shows the Dashboard entry for a custom role copied from %s, once the answer is in', async (role) => {
    answerMe(copiedFrom(role));
    const { client } = renderShell();
    await answerApplied(client);
    expect(menu()).toContain('Dashboard');
  });

  it('shows the Dashboard entry before the answer has arrived', () => {
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    renderShell();
    expect(menu()).toEqual(['Dashboard']);
  });

  it('draws the last answer for this person while the fresh one is on its way', () => {
    localStorage.setItem(
      `servwave_my_switches:${USER_ID}`,
      JSON.stringify({ values: valuesWith('view_jobs') }),
    );
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    renderShell();
    expect(menu()).toEqual(['Dashboard', 'Jobs']);
  });

  it('draws the Customers entry on View customers alone, whatever the rules allow (P1: the sidebar follows View)', async () => {
    // The Dispatcher preset used to hold View customers with the page hidden; with the Show switch retired the entry
    // follows View, so that person now sees it.
    const values = valuesWith('view_customers', 'view_jobs');
    answerMe(values);
    renderShell(ORG_USER, buildAbility(rulesFrom(values)));
    await expectMenu(['Dashboard', 'Customers', 'Jobs']);
    expect(buildAbility(rulesFrom(values)).can('read', 'Customer')).toBe(true);
  });

  it('shows no entry on a rule the person holds but a switch they do not', async () => {
    // View invoices off while the rules still read invoices.
    const held = valuesWith('view_invoices', WITNESS.access);
    answerMe(valuesWith(WITNESS.access));
    renderShell(ORG_USER, buildAbility(rulesFrom(held)));
    await expectMenu(['Dashboard', WITNESS.label]);
    expect(buildAbility(rulesFrom(held)).can('read', 'Invoice')).toBe(true);
  });

  it('keeps a plan lock on top of the switches', async () => {
    answerMe(valuesWith('view_automations', 'view_leads'));
    renderShell({ ...ORG_USER, org_features: ['leads'] });
    await waitFor(() => expect(menu()).toContain('Leads'));
    const automations = screen.getByText('Automations').closest('[data-slot="sidebar-item"]');
    expect(automations).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Leads').closest('[data-slot="sidebar-item"]')).not.toHaveAttribute('aria-disabled');
  });

  describe('Marketing', () => {
    const DEMO_USER = { ...ORG_USER, org_is_demo: true };

    it('follows Access Marketing and not the report-read rule', async () => {
      // Reports on (and its rule granted) with Access Marketing off: no entry.
      const reportsOnly = valuesWith('access_reports');
      answerMe(reportsOnly);
      const first = renderShell(DEMO_USER, buildAbility(rulesFrom(reportsOnly)));
      await expectMenu(['Dashboard', 'Reports']);
      first.unmount();

      // Access Marketing on with Access Reports off and no report rule: the entry shows.
      answerMe(valuesWith('access_marketing'));
      renderShell(DEMO_USER, emptyAbility);
      await expectMenu(['Dashboard', 'Marketing']);
    });

    it('keeps the rollout limit: a real org sees the entry locked, not live', async () => {
      answerMe(valuesWith('access_marketing'));
      renderShell(ORG_USER);
      await waitFor(() => expect(menu()).toContain('Marketing'));
      expect(screen.getByText('Marketing').closest('[data-slot="sidebar-item"]')).toHaveAttribute('aria-disabled', 'true');
    });
  });

  it('gives the Sales preset today\'s Sales menu plus the Dashboard', async () => {
    // "Today's Sales menu" is every entry the Sales preset's compiled rules open under the old rule (read a record
    // type / a page). The new rule, on the same preset's values, must open exactly those and the Dashboard.
    const values = copiedFrom('SALES');
    const rules = buildAbility(rulesFrom(values));
    const todays = [
      ['Schedule', 'read', 'Job'], ['Tasks', 'read', 'Task'], ['Leads', 'read', 'Lead'], ['Jobs', 'read', 'Job'],
      ['Customers', 'read', 'Customer'], ['Estimates', 'read', 'Estimate'], ['Invoices', 'read', 'Invoice'],
      ['Service Plans', 'read', 'ServicePlan'], ['Automations', 'read', 'Automation'], ['Billing', 'read', 'Report'],
      ['Reports', 'read', 'Report'],
    ]
      .filter(([, action, subject]) => rules.can(action as never, subject as never))
      .map(([label]) => label as string);
    expect(todays.length).toBeGreaterThan(5);

    answerMe(values);
    renderShell(ORG_USER, rules);
    await waitFor(() => expect(menu()).toContain('Leads'));
    const shown = menu().filter((label) => !['Dashboard', 'Price Book', 'Inventory', 'Communication'].includes(label));
    expect([...shown].sort()).toEqual([...todays].sort());
    expect(menu()).toContain('Dashboard');
  });
});
