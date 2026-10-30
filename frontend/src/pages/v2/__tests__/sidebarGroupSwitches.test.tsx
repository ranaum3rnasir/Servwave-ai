/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.20 - the Inventory and Communication groups, both Price Book entries and the
 * demo-only messaging child follow the person's switches in the routed v2 sidebar.
 *
 * Inventory shows when any child shows; each child follows its own View alone (the Show-page switches are retired, P1);
 * Price Book shows on View price book even when the rest is off, and so does the top-level Price Book entry. Communication shows when
 * Access Communication is on and at least one of Show Phone, Show Text, Show Email is on; each child follows its Show;
 * the demo-only messaging child follows Access Communication and never decides on its own whether the group shows.
 *
 * Every person below holds an EMPTY ability and only their switches differ, so the compiled rules cannot be what
 * decides an entry. The switch values come from the backend catalog file itself (the source of truth), because the
 * catalog module is not importable into the browser build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { emptyAbility } from '@/lib/ability';
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
    out.push({
      key,
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
      return { data: { admin_box: false, values, rules: [] } };
    }
    return { data: {} };
  });
}

function renderShell(user: Record<string, unknown> = ORG_USER) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null } as never),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={emptyAbility}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every destination row's label, in the order the column renders them. */
function menu(): string[] {
  const nav = document.querySelector('[data-slot="sidebar-nav"]');
  return Array.from(nav?.querySelectorAll('[data-slot="sidebar-item"]') ?? []).map(
    (row) => row.getAttribute('title') ?? '',
  );
}

/**
 * A known-shown entry switched on beside the one under test. It only draws once the answer is applied, so "the entry
 * under test is absent" is read from a menu that has been drawn from the answer, not from the pre-answer paint.
 */
const WITNESS = 'access_schedule';

async function drawn(...entries: string[]) {
  await waitFor(() => expect([...menu()].sort()).toEqual(['Dashboard', ...entries].sort()));
}

/** Opens a group and returns the labels of the rows nested under it. */
async function childrenOf(group: 'Inventory' | 'Communication'): Promise<string[]> {
  const toggle = screen.getByRole('button', { name: group });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  const nested = document.querySelectorAll('[data-slot="sidebar-item"].is-nested');
  return Array.from(nested).map((row) => row.getAttribute('title') ?? '');
}

const STOCK = ['view_stock'] as const;
const PO = ['view_purchase_orders'] as const;
const VENDORS = ['view_vendors'] as const;
const PRICE_BOOK = ['view_price_book'] as const;
const LOGISTIC = ['view_logistic_orders'] as const;

describe('v2 sidebar - the Inventory group and both Price Book entries', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
  });

  it('shows Price Book alone as the Inventory group with one child, and as the top-level entry', async () => {
    answerMe(valuesWith(...PRICE_BOOK));
    renderShell();
    await drawn('Inventory', 'Price Book');
    expect(await childrenOf('Inventory')).toEqual(['Price Book']);
  });

  it.each([
    ['Stock', STOCK],
    ['Purchase Orders', PO],
    ['Vendors', VENDORS],
  ] as const)('shows %s alone as the Inventory group with that one child', async (label, pair) => {
    answerMe(valuesWith(...pair));
    renderShell();
    await drawn('Inventory');
    expect(await childrenOf('Inventory')).toEqual([label]);
  });

  it.each(['Stock', 'Purchase Orders', 'Vendors', 'Price Book'] as const)('keeps %s out of the group with its View off', async (label) => {
    // The witness (Schedule) is on, so the menu is only ever [Dashboard, Schedule] once drawn.
    answerMe(valuesWith(WITNESS));
    renderShell();
    await drawn('Schedule');
    expect(menu()).not.toContain('Inventory');
    expect(menu()).not.toContain(label);
  });

  it('shows each child on its own pair and hides the others', async () => {
    answerMe(valuesWith(...STOCK, ...VENDORS));
    renderShell();
    await drawn('Inventory');
    expect(await childrenOf('Inventory')).toEqual(['Stock', 'Vendors']);
  });

  it('follows the top-level Price Book entry on View price book alone', async () => {
    answerMe(valuesWith(WITNESS));
    const first = renderShell();
    await drawn('Schedule');
    expect(menu()).not.toContain('Price Book');
    first.unmount();
    localStorage.clear();

    answerMe(valuesWith(WITNESS, ...PRICE_BOOK));
    renderShell();
    await drawn('Schedule', 'Inventory', 'Price Book');
  });

  it('keeps the top-level Price Book entry off for a person with the rest of Inventory but not Price Book', async () => {
    answerMe(valuesWith(...STOCK, ...PO, ...VENDORS));
    renderShell();
    await drawn('Inventory');
    expect(await childrenOf('Inventory')).toEqual(['Stock', 'Purchase Orders', 'Vendors']);
  });

  it('lists a Price Book child beside the others only once its own View is on, without a second top-level row', async () => {
    answerMe(valuesWith(...STOCK, ...PRICE_BOOK));
    renderShell();
    await drawn('Inventory', 'Price Book');
    expect(await childrenOf('Inventory')).toEqual(['Stock']);
  });

  it('keeps the plan lock on top of the switches', async () => {
    answerMe(valuesWith(...PRICE_BOOK));
    renderShell({ ...ORG_USER, org_features: ['leads'] });
    await waitFor(() => expect(menu()).toContain('Inventory'));
    expect(screen.getByText('Inventory').closest('[data-slot="sidebar-item"]')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Price Book').closest('[data-slot="sidebar-item"]')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('v2 sidebar - the Logistic Orders child of the Inventory group', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
  });

  it('shows the child alone as the Inventory group with one child, opening the Logistic Orders tab', async () => {
    answerMe(valuesWith(...LOGISTIC));
    renderShell();
    await drawn('Inventory');
    expect(await childrenOf('Inventory')).toEqual(['Logistic Orders']);
    expect(screen.getByText('Logistic Orders').closest('a')).toHaveAttribute('href', '/inventory/logistic-orders');
  });

  it('shows the child beside the other children while the Stock entry is hidden', async () => {
    answerMe(valuesWith(...PO, ...VENDORS, ...LOGISTIC));
    renderShell();
    await drawn('Inventory');
    expect(await childrenOf('Inventory')).toEqual(['Purchase Orders', 'Vendors', 'Logistic Orders']);
  });

  it('still shows the child when the Stock entry is hidden by View stock off', async () => {
    answerMe(valuesWith(...LOGISTIC));
    renderShell();
    await drawn('Inventory');
    expect(await childrenOf('Inventory')).toEqual(['Logistic Orders']);
  });

  it('draws no second entry when the Stock entry shows', async () => {
    answerMe(valuesWith(...STOCK, ...LOGISTIC));
    renderShell();
    await drawn('Inventory');
    expect(await childrenOf('Inventory')).toEqual(['Stock']);
  });

  it('hides the child, and the group with it, when View logistic orders is off', async () => {
    answerMe(valuesWith(WITNESS));
    renderShell();
    await drawn('Schedule');
    expect(menu()).not.toContain('Inventory');
    expect(menu()).not.toContain('Logistic Orders');
  });

  it('counts as a child for the group rule: it opens the group when nothing else in it shows', async () => {
    answerMe(valuesWith(WITNESS, ...LOGISTIC));
    renderShell();
    await drawn('Schedule', 'Inventory');
  });

  it('keeps the plan lock on top of the switches', async () => {
    answerMe(valuesWith(...LOGISTIC));
    renderShell({ ...ORG_USER, org_features: ['leads'] });
    await waitFor(() => expect(menu()).toContain('Inventory'));
    expect(screen.getByText('Inventory').closest('[data-slot="sidebar-item"]')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText('Logistic Orders')).toBeNull();
  });
});

describe('v2 sidebar - the Communication group', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
  });

  it.each([
    ['Phone', 'show_phone'],
    ['Text', 'show_text'],
    ['Email', 'show_email'],
  ] as const)('shows the group with %s as its one real child when only %s is on beside Access', async (label, show) => {
    answerMe(valuesWith('access_communication', show));
    renderShell();
    await drawn('Communication');
    const children = await childrenOf('Communication');
    expect(children).toContain(label);
    expect(children.filter((child) => child !== 'WhatsApp')).toEqual([label]);
  });

  it('shows all three real children when all three Shows are on', async () => {
    answerMe(valuesWith('access_communication', 'show_phone', 'show_text', 'show_email'));
    renderShell();
    await drawn('Communication');
    expect([...(await childrenOf('Communication'))].sort()).toEqual(['Email', 'Phone', 'Text', 'WhatsApp']);
  });

  // Roles & Permissions S08.17 - Show Phone off takes the Phone entry out of the menu while the group stays for the others.
  it('hides the Phone entry with Show Phone off and keeps Text and Email', async () => {
    answerMe(valuesWith('access_communication', 'show_text', 'show_email'));
    renderShell();
    await drawn('Communication');
    const children = await childrenOf('Communication');
    expect(children).not.toContain('Phone');
    expect(children).toEqual(expect.arrayContaining(['Text', 'Email']));
  });

  it('hides the group with the Shows on and Access Communication off', async () => {
    answerMe(valuesWith(WITNESS, 'show_phone', 'show_text', 'show_email'));
    renderShell();
    await drawn('Schedule');
    expect(menu()).not.toContain('Communication');
  });

  it('hides the group with Access Communication on and every Show off, whatever the demo-only child holds', async () => {
    answerMe(valuesWith(WITNESS, 'access_communication'));
    renderShell({ ...ORG_USER, org_is_demo: true });
    await drawn('Schedule');
    expect(menu()).not.toContain('Communication');
  });

  it('never lets the demo-only messaging child open the group on its own, in a demo org or a real one', async () => {
    for (const user of [ORG_USER, { ...ORG_USER, org_is_demo: true }]) {
      localStorage.clear();
      answerMe(valuesWith(WITNESS, 'access_communication'));
      const view = renderShell(user);
      await drawn('Schedule');
      expect(menu()).not.toContain('Communication');
      expect(menu()).not.toContain('WhatsApp');
      view.unmount();
    }
  });

  it('shows the demo-only child, locked in a real org, once the group shows', async () => {
    answerMe(valuesWith('access_communication', 'show_text'));
    renderShell();
    await drawn('Communication');
    await childrenOf('Communication');
    expect(screen.getByText('WhatsApp').closest('[data-slot="sidebar-item"]')).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the demo-only child live in a demo org', async () => {
    answerMe(valuesWith('access_communication', 'show_text'));
    renderShell({ ...ORG_USER, org_is_demo: true });
    await drawn('Communication');
    await childrenOf('Communication');
    expect(screen.getByText('WhatsApp').closest('[data-slot="sidebar-item"]')).not.toHaveAttribute('aria-disabled');
  });
});

describe('v2 sidebar - the two groups for a person copied from each built-in role', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
  });

  it.each(PRESET_ORDER)('draws the groups the %s preset values call for', async (role) => {
    const values = copiedFrom(role);
    const on = (key: string) => values[key] === true;
    const inventoryChildren = [
      on('view_stock') && on('view_stock') && 'Stock',
      on('view_purchase_orders') && on('view_purchase_orders') && 'Purchase Orders',
      on('view_vendors') && on('view_vendors') && 'Vendors',
      on('view_price_book') && on('view_price_book') && 'Price Book',
    ].filter(Boolean);
    const communicationShows =
      on('access_communication') && (on('show_phone') || on('show_text') || on('show_email'));

    answerMe(values);
    renderShell();
    await waitFor(() => expect(menu().length).toBeGreaterThan(1));
    await act(async () => {});
    expect(menu().includes('Inventory')).toBe(inventoryChildren.length > 0);
    expect(menu().includes('Communication')).toBe(communicationShows);
    expect(menu().includes('Price Book')).toBe(on('view_price_book') && on('view_price_book'));
    // No preset's menu changes: the Logistic Orders child never joins the group a preset sees.
    if (inventoryChildren.length > 0) {
      expect(await childrenOf('Inventory')).not.toContain('Logistic Orders');
    }
  });
});
