import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocationStockHealth } from '@/components/inventory/LocationStockHealth';
import type { Item, Location } from '@/lib/api/inventory';

// One-item / one-location fixture. The item is a `material` stocked below its
// `min` at the location, so the component exercises the low-stock / worst-item
// branches rather than just the empty path.
const location: Location = {
  id: 'loc-1',
  name: 'Main Warehouse',
  type: 'warehouse',
  branch: 'br-1',
};

const item: Item = {
  id: 'item-1',
  sku: 'SKU-001',
  name: 'Deadbolt',
  category: 'cat-1',
  trade: 'locksmith',
  kind: 'material',
  uom: 'ea',
  unitCost: 10,
  sellPrice: 20,
  serialized: false,
  hazmat: false,
  status: 'active',
  vendor: 'ven-1',
  stock: [{ locationId: 'loc-1', onHand: 1, min: 10 }],
  updatedAt: '2026-05-28T00:00:00.000Z',
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('LocationStockHealth — render smoke test', () => {
  it('renders without throwing on a one-item / one-location fixture', () => {
    expect(() =>
      renderWithProviders(
        <LocationStockHealth
          items={[item]}
          locations={[location]}
          activeLocationId="all"
          onSelectLocation={() => {}}
        />,
      ),
    ).not.toThrow();

    // Heading and the seeded location surface in the rendered output.
    expect(screen.getByText('Low-Stock Health by Location')).toBeInTheDocument();
    expect(screen.getByText('Main Warehouse')).toBeInTheDocument();
  });
});
