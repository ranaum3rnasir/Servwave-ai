/**
 * Roles & Permissions S07.18 - the Price Book's vendor surfaces follow View vendors.
 *
 * Mounted with the REAL data hooks over a recording HTTP seam, as the routed Price Book page. A person without View
 * vendors is served brands with no `defaultVendorId` key; the brand form must have no Default Vendor field (never a
 * blank one) and a brand saved from it must carry no default vendor. The downloaded file has no vendor column for
 * anyone. The ability is built from the rules the switches compile to, never from a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility, type AbilityRule } from '@/lib/ability';

const h = vi.hoisted(() => {
  const state = { withVendors: false, posts: [] as Array<{ url: string; body: Record<string, unknown> }> };
  const downloads: Array<{ csv: string }> = [];
  const VENDOR_ID = 'f0000000-0000-4000-8000-000000000001';
  const ITEM = {
    id: 'bbbbbbb1-0000-4000-8000-000000007018', sku: 'PB-7018', name: 'Catalog hinge', category: 'Hinges', trade: 'locksmith',
    kind: 'material', type: 'MATERIAL', uom: 'EA', sellPrice: 178, serialized: false, hazmat: false, trackInventory: false,
    taxable: true, isActive: true, status: 'active', updatedAt: '2026-07-01T00:00:00.000Z',
  };
  function bodyFor(path: string): unknown {
    switch (path) {
      case '/api/price-book/catalog-items':
        return { data: [state.withVendors ? { ...ITEM, vendor: 'Acme Supply' } : ITEM], meta: { totalPages: 1 } };
      case '/api/inventory/brands':
        return {
          brands: [{
            id: 'br1', name: 'Acme Locks', isActive: true,
            ...(state.withVendors ? { defaultVendorId: VENDOR_ID } : {}),
          }],
        };
      case '/api/inventory/vendors':
        return { vendors: [{ id: VENDOR_ID, name: 'Acme Supply', category: 'Hardware', status: 'active' }] };
      case '/api/inventory/item-groups': return { itemGroups: [] };
      case '/api/inventory/categories': return { categories: [{ id: 'ca1', name: 'Hinges' }] };
      case '/api/inventory/finishes': return { finishes: [] };
      case '/api/inventory/uom-options': return { uomOptions: [{ id: 'u1', code: 'EA' }] };
      default: return undefined;
    }
  }
  return { state, downloads, VENDOR_ID, bodyFor };
});

vi.mock('@/lib/axios', () => ({
  default: {
    get: vi.fn((url: string) => {
      const body = h.bodyFor(url.split('?')[0]!);
      if (!body) return Promise.reject(Object.assign(new Error('Forbidden'), { response: { status: 403, data: {} } }));
      return Promise.resolve({ data: body });
    }),
    post: vi.fn((url: string, body: Record<string, unknown>) => {
      h.state.posts.push({ url, body });
      return Promise.resolve({ data: { brand: { id: 'br1', name: 'Acme Locks' } } });
    }),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock('@/lib/inventory/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory/csv')>();
  return { ...actual, downloadCSV: (csv: string) => void h.downloads.push({ csv }) };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const VIEW_PRICE_BOOK: AbilityRule = { action: 'read', subject: 'PriceBook' };
// Create price book items needs Edit price book items.
const EDIT_PRICE_BOOK: AbilityRule = { action: 'update', subject: 'PriceBook' };
const CREATE_PRICE_BOOK: AbilityRule = { action: 'create', subject: 'PriceBook' };
const EXPORT_PRICE_BOOK: AbilityRule = { action: 'export', subject: 'PriceBook' };
const VIEW_VENDORS: AbilityRule = { action: 'read', subject: 'Vendor' };

beforeEach(() => {
  h.state.posts.length = 0;
  h.downloads.length = 0;
});

async function openBrandEditor(rules: AbilityRule[]) {
  renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'], ability: buildAbility(rules) });
  await screen.findByText('Catalog hinge');
  await userEvent.click(screen.getByRole('tab', { name: /Brands/i }));
  await userEvent.click(await screen.findByRole('button', { name: 'Edit Acme Locks' }));
  return within(await screen.findByRole('dialog'));
}

describe('the brand form', () => {
  it('has no Default Vendor field without View vendors, and a saved brand carries no default vendor', async () => {
    h.state.withVendors = false;
    const dialog = await openBrandEditor([VIEW_PRICE_BOOK, EDIT_PRICE_BOOK, CREATE_PRICE_BOOK]);

    expect(dialog.queryByText('Default Vendor')).not.toBeInTheDocument();
    expect(dialog.queryByRole('combobox', { name: 'Default vendor' })).not.toBeInTheDocument();

    await userEvent.click(dialog.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(h.state.posts.length).toBeGreaterThan(0));
    const sent = h.state.posts.find((p) => p.url === '/api/price-book/brands')!.body;
    expect(sent).not.toHaveProperty('defaultVendorId');
  });

  it('has the Default Vendor field with View vendors, holding the stored vendor, and a saved brand keeps it', async () => {
    h.state.withVendors = true;
    const dialog = await openBrandEditor([VIEW_PRICE_BOOK, EDIT_PRICE_BOOK, CREATE_PRICE_BOOK, VIEW_VENDORS]);

    expect(dialog.getByText('Default Vendor')).toBeInTheDocument();
    expect(await dialog.findByRole('combobox', { name: 'Default vendor' })).toHaveTextContent('Acme Supply');

    await userEvent.click(dialog.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(h.state.posts.length).toBeGreaterThan(0));
    expect(h.state.posts.find((p) => p.url === '/api/price-book/brands')!.body).toMatchObject({ defaultVendorId: h.VENDOR_ID });
  });
});

describe('the downloaded file', () => {
  it.each([
    ['without View vendors', false, [VIEW_PRICE_BOOK, EXPORT_PRICE_BOOK]],
    ['with View vendors', true, [VIEW_PRICE_BOOK, EXPORT_PRICE_BOOK, VIEW_VENDORS]],
  ])('has no vendor column %s', async (_name, withVendors, rules) => {
    h.state.withVendors = withVendors;
    renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'], ability: buildAbility(rules as AbilityRule[]) });
    await screen.findByText('Catalog hinge');

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(h.downloads).toHaveLength(1));
    const csv = h.downloads[0]!.csv;
    expect(csv.split('\r\n')[0]).toContain('SKU');
    expect(csv).not.toMatch(/vendor|Acme Supply/i);
  });
});
