/**
 * Roles & Permissions S07.16 - the routed Price Book page works on View price book alone.
 *
 * Mounted with the REAL data hooks over a recording HTTP seam, so the test sees exactly which endpoints the page
 * reads. A person holding View price book and nothing else (no View stock, no View vendors) must get the page with
 * names, categories and sell prices, and the page must never ask for stock or vendor data it would be refused.
 * The ability is built from the rules the switches compile to, never from a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility, type AbilityRule } from '@/lib/ability';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const toasts: string[] = [];
  const CATALOG_ITEM = {
    id: 'bbbbbbb1-0000-4000-8000-000000007016',
    sku: 'PB-7016',
    name: 'Catalog-only hinge',
    category: 'Hinges',
    trade: 'locksmith',
    kind: 'material',
    type: 'MATERIAL',
    uom: 'EA',
    sellPrice: 178,
    serialized: false,
    hazmat: false,
    trackInventory: false,
    taxable: true,
    isActive: true,
    status: 'active',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const BODIES: Record<string, unknown> = {
    '/api/price-book/catalog-items': { data: [CATALOG_ITEM], meta: { totalPages: 1 } },
    '/api/inventory/brands': { brands: [{ id: 'br1', name: 'Acme Locks', isActive: true }] },
    '/api/inventory/item-groups': { itemGroups: [] },
    '/api/inventory/categories': { categories: [{ id: 'ca1', name: 'Hinges' }] },
    '/api/inventory/finishes': { finishes: [] },
    '/api/inventory/uom-options': { uomOptions: [{ id: 'u1', code: 'EA' }] },
  };
  return { calls, toasts, BODIES };
});

vi.mock('@/lib/axios', () => ({
  default: {
    get: vi.fn((url: string) => {
      const path = url.split('?')[0]!;
      h.calls.push(path);
      const body = h.BODIES[path];
      // A read the page has no business making answers like the server would for this person.
      if (!body) return Promise.reject(Object.assign(new Error('Forbidden'), { response: { status: 403, data: {} } }));
      return Promise.resolve({ data: body });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>();
  const record = (message: unknown) => { h.toasts.push(String(message)); };
  return { ...actual, toast: Object.assign((m: unknown) => record(m), { error: record, success: record, warning: record, info: record }) };
});

const held = (...rules: AbilityRule[]) => buildAbility(rules);
const VIEW_PRICE_BOOK: AbilityRule = { action: 'read', subject: 'PriceBook' };

const STOCK_OR_VENDOR_READS = [
  '/api/inventory/items',
  '/api/inventory/vendors',
  '/api/inventory/locations',
  '/api/inventory/branches',
  '/api/inventory/techs',
];

beforeEach(() => {
  h.calls.length = 0;
  h.toasts.length = 0;
});

describe('S07.16 - the Price Book page with View price book alone', () => {
  it('loads names, categories and sell prices, reads no stock or vendor endpoint, and shows no error', async () => {
    renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'], ability: held(VIEW_PRICE_BOOK, { action: 'read', subject: 'Prices' } as AbilityRule) });

    expect(await screen.findByText('Catalog-only hinge')).toBeInTheDocument();
    expect(screen.getAllByText('Hinges').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$178.00').length).toBeGreaterThan(0);

    // Let every query settle before judging what was asked.
    await waitFor(() => expect(h.calls).toContain('/api/inventory/brands'));
    expect(h.calls).toContain('/api/price-book/catalog-items');
    for (const path of STOCK_OR_VENDOR_READS) expect(h.calls, path).not.toContain(path);
    expect(h.toasts).toEqual([]);
  });

  it('asks for the vendor list only with View vendors', async () => {
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
      ability: held(VIEW_PRICE_BOOK, { action: 'read', subject: 'Vendor' }),
    });
    await screen.findByText('Catalog-only hinge');
    await waitFor(() => expect(h.calls).toContain('/api/inventory/vendors'));
  });

  describe('the item form', () => {
    const CREATE: AbilityRule = { action: 'create', subject: 'PriceBook' };

    async function openAddItem(ability: ReturnType<typeof held>) {
      renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'], ability });
      await screen.findByText('Catalog-only hinge');
      await userEvent.click(screen.getAllByRole('button', { name: /add item/i })[0]!);
      await screen.findByRole('dialog');
    }

    it('has no vendor field and no reserve levels without View vendors and Edit stock', async () => {
      await openAddItem(held(VIEW_PRICE_BOOK, CREATE));
      expect(screen.queryByText('Vendor / Source')).not.toBeInTheDocument();
      expect(screen.queryByText('Starting Stock')).not.toBeInTheDocument();
      // Opening the form is no licence to ask for stock or vendor lists the person would be refused.
      for (const path of STOCK_OR_VENDOR_READS) expect(h.calls, path).not.toContain(path);
      expect(h.toasts).toEqual([]);
    });

    it('shows the vendor field with View vendors and the reserve levels with Edit stock', async () => {
      await openAddItem(held(
        VIEW_PRICE_BOOK, CREATE,
        { action: 'read', subject: 'Vendor' },
        { action: 'read', subject: 'Inventory' }, { action: 'update', subject: 'Inventory' },
      ));
      expect(screen.getByText('Vendor / Source')).toBeInTheDocument();
      expect(screen.getByText('Starting Stock')).toBeInTheDocument();
    });
  });
});
