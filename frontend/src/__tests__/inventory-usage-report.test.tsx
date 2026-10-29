// Inventory P5 §3 — Inventory Usage report: registry dispatch at
// /reports/inventory-usage, KPI + table render, job drill-through links, and
// full cost suppression when the server strips cost data (no read Invoice).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import ReportRoute from '@/pages/reports/ReportRoute';
import type { InventoryUsagePayload } from '@/lib/reports/inventory-usage-data';

const hoisted = vi.hoisted(() => ({
  useInventoryUsage: vi.fn(),
}));

vi.mock('@/lib/reports/inventory-usage-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/inventory-usage-data')>();
  return { ...actual, useInventoryUsage: hoisted.useInventoryUsage };
});

// Real (non-demo) org — the catalog `live: true` flip is what lets the route
// through canShowReport; a stub here would mean the wiring regressed.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => false }));

const PAYLOAD: InventoryUsagePayload = {
  from: '2025-07-17T00:00:00.000Z',
  to: '2026-07-17T00:00:00.000Z',
  items: [
    {
      itemId: 'itm-1', sku: 'CAM-01', name: 'Dome Camera',
      units: 12.5, movementCount: 4, cost: 200.75, unpricedUnits: 2,
      jobs: [{ id: 'job-1', jobNumber: 'J00042' }],
      invoices: [{ id: 'inv-1', invoiceNumber: 'I00007' }],
    },
    {
      itemId: null, sku: 'LGC-9', name: 'Legacy Hinge',
      units: 3, movementCount: 1, cost: 50, unpricedUnits: 3,
      jobs: [], invoices: [],
    },
  ],
};

/** The same payload after the server cost-strip: cost keys ABSENT, not null. */
const STRIPPED: InventoryUsagePayload = {
  ...PAYLOAD,
  items: PAYLOAD.items.map(({ cost: _c, unpricedUnits: _u, ...rest }) => rest),
};

function renderReport() {
  return renderWithProviders(
    <Routes>
      <Route path="/reports/:slug" element={<ReportRoute />} />
    </Routes>,
    { initialEntries: ['/reports/inventory-usage'] },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.useInventoryUsage.mockReturnValue({ data: PAYLOAD, isLoading: false, isError: false });
});

describe('InventoryUsageReport (P5 §3, QA-703)', () => {
  it('/reports/inventory-usage dispatches to the built page (registry + live catalog entry)', async () => {
    renderReport();
    expect(
      await screen.findByRole('heading', { name: 'Inventory Usage' }),
    ).toBeInTheDocument();
    // Not the "coming soon" stub.
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('renders KPIs and the usage table from the payload', async () => {
    renderReport();

    expect(await screen.findByText('Units consumed')).toBeInTheDocument();
    expect(screen.getByText('15.5')).toBeInTheDocument(); // 12.5 + 3
    expect(screen.getByText('Material cost')).toBeInTheDocument();
    expect(screen.getByText('$250.75')).toBeInTheDocument();
    expect(screen.getByText('Dome Camera')).toBeInTheDocument();
    expect(screen.getByText('Legacy Hinge')).toBeInTheDocument(); // sku-fallback row (null itemId)
    expect(screen.getByText('Unpriced units')).toBeInTheDocument();
  });

  it('job and invoice drill-through chips link at the movements own refs (QA-703)', async () => {
    renderReport();

    expect(await screen.findByRole('link', { name: 'J00042' })).toHaveAttribute(
      'href',
      '/jobs/job-1',
    );
    expect(screen.getByRole('link', { name: 'I00007' })).toHaveAttribute(
      'href',
      '/invoices/inv-1',
    );
  });

  it('suppresses every cost surface when the payload carries no cost (server-stripped)', async () => {
    hoisted.useInventoryUsage.mockReturnValue({ data: STRIPPED, isLoading: false, isError: false });
    renderReport();

    expect(await screen.findByText('Units consumed')).toBeInTheDocument();
    expect(screen.queryByText('Material cost')).toBeNull();
    expect(screen.queryByText('Cost')).toBeNull();
    expect(screen.queryByText('Unpriced units')).toBeNull();
    expect(screen.queryByText('Top items by cost')).toBeNull();
    // Units-only report still shows the data.
    expect(screen.getByText('Dome Camera')).toBeInTheDocument();
  });
});
