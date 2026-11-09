/**
 * Roles & Permissions S07.13 - the Inventory page's tab set follows the person's switches, and the Logistic Orders tab
 * stands on its own two switches.
 *
 * Part one mounts the routed v2 `InventoryPage` with the HTTP layer mocked. The person is a custom role described only
 * by the switches under test (the "me" answer, whose keys are looked up in the backend catalog by the label a person
 * sees) beside the rules those switches compile into; the page reads no role name. Part two renders the REAL routed
 * table, so the guard and the page together decide where each deep link ends up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within, waitFor } from '@testing-library/react';
import { Outlet, Route, Routes, useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { inventoryElement, serveInventory } from '@/__tests__/harness/inventoryPage';
import { inventoryV2Routes } from '@/pages/v2/routes/inventory.routes';
import type { Item, Location } from '@/lib/api/inventory';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/lib/axios');
vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/RequireFeature', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));

const mockApi = vi.mocked(api);

const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';
const LOCATIONS: Location[] = [{ id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }];
const ITEM_ID = 'b0000000-0000-0000-0000-00000000b001';
const ITEMS: Item[] = [
  {
    id: ITEM_ID, sku: 'HNG-1', name: 'Brass Hinge', category: 'Hardware',
    trade: 'general' as Item['trade'], kind: 'material', uom: 'EA', unitCost: 4, sellPrice: 9, serialized: false,
    hazmat: false, status: 'active', vendor: 'Supply Co', stock: [{ locationId: WAREHOUSE, onHand: 12, min: 2 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];
const LOW_STOCK_ROW = {
  itemId: ITEM_ID, sku: 'HNG-1', name: 'Brass Hinge', locationId: WAREHOUSE, locationName: 'Main Warehouse',
  onHand: 1, min: 2, max: 10, vendor: 'Supply Co',
};

const key = (label: string) => catalogToggle(label).key;
const VIEW_STOCK = 'View stock';
const VIEW_LO = 'View logistic orders';

const callsTo = (prefix: string) => mockApi.get.mock.calls.filter((c) => String(c[0]).startsWith(prefix));

/** The person's switches (by label) and the compiled rules that go with the ones that grant a read. */
function serve(on: string[]) {
  const values = Object.fromEntries(on.map((label) => [key(label), true]));
  serveInventory({
    items: ITEMS,
    locations: LOCATIONS,
    routes: [
      { match: (url) => url === '/api/permission-switches/me', data: { admin_box: false, values, rules: [] } },
      { match: (url) => url.startsWith('/api/inventory/low-stock'), data: { data: [LOW_STOCK_ROW], meta: { page: 1, limit: 1, total: 1, totalPages: 1 } } },
    ],
  });
}

function rulesFor(on: string[], extra: AbilityRule[] = []): AbilityRule[] {
  return [
    ...(on.includes(VIEW_STOCK) ? [{ action: 'read', subject: 'Inventory' } as AbilityRule] : []),
    ...(on.includes(VIEW_LO) ? [{ action: 'read', subject: 'LogisticOrder' } as AbilityRule] : []),
    ...extra,
  ];
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderPage(path: string, on: string[], extra: AbilityRule[] = []) {
  serve(on);
  return renderWithProviders(
    <>
      <Where />
      {inventoryElement()}
    </>,
    { initialEntries: [path], ability: buildAbility(rulesFor(on, extra)) },
  );
}

const tabNames = () => screen.getAllByRole('tab').map((t) => (t.textContent ?? '').replace(/\d+( pending| ready)?$/, '').trim());

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Inventory tab set per switch combination', () => {
  const ACTIVITY: AbilityRule = { action: 'see_inventory_activity', subject: 'Inventory' };

  it('shows the four Stock tabs, and no Activity or Logistic Orders tab, with View stock', async () => {
    renderPage('/inventory', [VIEW_STOCK]);

    await screen.findByText('Brass Hinge');
    expect(tabNames()).toEqual(['Items', 'Staging', 'Assets', 'Low stock']);
  });

  it('adds the Activity tab with See inventory activity', async () => {
    renderPage('/inventory', [VIEW_STOCK], [ACTIVITY]);

    await screen.findByText('Brass Hinge');
    expect(tabNames()).toEqual(['Items', 'Staging', 'Assets', 'Low stock', 'Activity']);
  });

  it('adds the Logistic Orders tab with View logistic orders', async () => {
    renderPage('/inventory', [VIEW_STOCK, VIEW_LO]);

    await screen.findByText('Brass Hinge');
    await waitFor(() => expect(tabNames()).toEqual(['Items', 'Staging', 'Assets', 'Low stock', 'Logistic Orders']));
  });

  it('shows no Logistic Orders tab with View logistic orders off', async () => {
    renderPage('/inventory', [VIEW_STOCK]);

    await screen.findByText('Brass Hinge');
    expect(screen.queryByRole('tab', { name: /Logistic Orders/ })).not.toBeInTheDocument();
    expect(callsTo('/api/logistic-orders')).toHaveLength(0);
  });

  it('shows no Stock tab with View stock off, and reads no stock for the count pills', async () => {
    renderPage('/inventory/logistic-orders', [VIEW_LO]);

    await screen.findByRole('tab', { name: /Logistic Orders/ });
    expect(tabNames()).toEqual(['Logistic Orders']);
    expect(callsTo('/api/inventory/low-stock')).toHaveLength(0);
    expect(callsTo('/api/inventory/assets')).toHaveLength(0);
    expect(callsTo('/api/inventory/job-stages')).toHaveLength(0);
    expect(callsTo('/api/inventory/items')).toHaveLength(0);
  });
});

describe('a tab deep link without its switch', () => {
  it('lands the Assets link on the first tab the person may see (Logistic Orders when that is all they have)', async () => {
    renderPage('/inventory/assets', [VIEW_LO]);

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/inventory/logistic-orders'));
    expect(tabNames()).toEqual(['Logistic Orders']);
  });

  it('lands the Logistic Orders link on Items when View logistic orders is off', async () => {
    renderPage('/inventory/logistic-orders', [VIEW_STOCK]);

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/inventory$/));
    expect(await screen.findByText('Brass Hinge')).toBeInTheDocument();
  });

  it('lands the Activity link on Items without See inventory activity', async () => {
    renderPage('/inventory/activity', [VIEW_STOCK]);

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/inventory$/));
  });
});

describe('what a View stock person sees', () => {
  it('reads quantities, locations, categories and the low-stock list', async () => {
    renderPage('/inventory', [VIEW_STOCK]);

    const row = (await screen.findByText('Brass Hinge')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Hardware')).toBeInTheDocument();
    expect(within(row).getAllByText('12').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: /Low stock/ })).toBeInTheDocument();
  });
});

describe('the routed table', () => {
  function open(path: string, on: string[]) {
    serve(on);
    return renderWithProviders(
      <Suspense fallback={null}>
        <Where />
        <Routes>
          {inventoryV2Routes()}
          <Route path="/" element={<h1>Dashboard</h1>} />
          <Route path="*" element={<p>Nothing here</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: [path], ability: buildAbility(rulesFor(on)) },
    );
  }
  const where = () => screen.getByTestId('where').textContent;
  const dashboard = () => screen.findByRole('heading', { name: 'Dashboard' });

  it('sends the Logistic Orders link home with View logistic orders off', async () => {
    open('/inventory/logistic-orders', [VIEW_STOCK]);

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('opens the Logistic Orders link with that tab alone when View stock is off', async () => {
    open('/inventory/logistic-orders', [VIEW_LO]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Logistic Orders' })).toBeInTheDocument();
    expect(where()).toBe('/inventory/logistic-orders');
    expect(tabNames()).toEqual(['Logistic Orders']);
  });

  it.each(['/inventory', '/inventory/staging'])('sends the %s link home when View stock is off', async (path) => {
    open(path, [VIEW_LO]);

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });
});
