/**
 * Roles & Permissions S07.10 - a purchase order opened from a job opens on View purchase orders alone.
 *
 * The single-order address (`/inventory/purchase-orders/:poId`) is a record route: it carries no list guard
 * (the order opens whatever the list switches say), and the page asks the server. With the
 * order readable it draws the order; with the server's refusal, or without View purchase orders at all, it draws a
 * plain not-found state that says nothing about whether the order exists. The HTTP layer is mocked; the page is the one
 * the route renders.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import PurchaseOrderRecordPage from '@/pages/v2/inventory/PurchaseOrderRecordPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
vi.mock('@/lib/axios');

const PO_ID = 'f0000001-0000-4000-8000-000000000001';
const PO = {
  id: PO_ID, poNumber: 'PO-1001', vendor: 'Acme Supply', status: 'ordered', orderedAt: '2026-07-01T00:00:00.000Z',
  expectedDate: null, receivedAt: null, leadTimeDays: null, orderedBy: null, notes: null, signatureData: null,
  signatureName: null, signatureAt: null, createdAt: '2026-06-30T00:00:00.000Z',
  lines: [{ id: 'l1', itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: 0 }],
};

const READ_POS: AbilityRule = { action: 'read', subject: 'PurchaseOrder' };
const poCalls = () => mockApi.get.mock.calls.filter((c) => String(c[0]) === `/api/inventory/purchase-orders/${PO_ID}`);

const JOB_ID = 'f0000002-0000-4000-8000-000000000002';
// The answer for an order made from a job: the link is there (jobId, jobNumber), the stored customer text is not.
const FROM_A_JOB = { ...PO, jobId: JOB_ID, jobNumber: 'J00580' };
const READ_JOBS: AbilityRule = { action: 'read', subject: 'Job' };

function serve(po: 'found' | 'refused' | 'missing', answer: Record<string, unknown> = PO) {
  mockApi.get.mockImplementation((async (url: string) => {
    if (url === `/api/inventory/purchase-orders/${PO_ID}`) {
      if (po === 'found') return { data: { purchaseOrder: answer } };
      throw Object.assign(new Error('refused'), { response: { status: po === 'refused' ? 403 : 404, data: { error: 'x' } } });
    }
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: { view_purchase_orders: false }, rules: [] } };
    return { data: { data: [], locations: [], activity: [], users: [], total: 0 } };
  }) as typeof mockApi.get);
}

function open(rules: AbilityRule[]) {
  return renderWithProviders(
    <Routes><Route path="/inventory/purchase-orders/:poId" element={<PurchaseOrderRecordPage />} /></Routes>,
    { initialEntries: [`/inventory/purchase-orders/${PO_ID}`], ability: buildAbility(rules) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('a purchase order opened from a job', () => {
  it('opens on View purchase orders alone, with the list switch off', async () => {
    serve('found');
    open([READ_POS]);
    expect(await screen.findByText(/PO-1001/)).toBeInTheDocument();
    expect(screen.getByText('Run Capacitor')).toBeInTheDocument();
  });

  it('draws a plain not-found state when the server refuses the order', async () => {
    serve('refused');
    open([READ_POS]);
    expect(await screen.findByText('Purchase order not found')).toBeInTheDocument();
    expect(screen.queryByText(/PO-1001/)).not.toBeInTheDocument();
  });

  it('draws the same not-found state when the order does not exist', async () => {
    serve('missing');
    open([READ_POS]);
    expect(await screen.findByText('Purchase order not found')).toBeInTheDocument();
  });

  it('draws not-found without asking the server when View purchase orders is off', async () => {
    serve('found');
    open([]);
    expect(await screen.findByText('Purchase order not found')).toBeInTheDocument();
    expect(poCalls()).toHaveLength(0);
    expect(screen.queryByText(/PO-1001/)).not.toBeInTheDocument();
  });
});

describe('the header of a purchase order made from a job', () => {
  it('names the job, not "No job link", even with no customer text stored', async () => {
    serve('found', FROM_A_JOB);
    open([READ_POS]);
    await screen.findByText(/PO-1001/);
    expect(screen.queryByText('No job link')).not.toBeInTheDocument();
    expect(screen.getByText('J00580')).toBeInTheDocument();
  });

  it('links to the job for a person who can open jobs, and shows it as plain text for one who cannot', async () => {
    serve('found', FROM_A_JOB);
    const withJobs = open([READ_POS, READ_JOBS]);
    await screen.findByText(/PO-1001/);
    expect(screen.getByRole('link', { name: 'J00580' })).toHaveAttribute('href', `/jobs/${JOB_ID}`);
    withJobs.unmount();

    serve('found', FROM_A_JOB);
    open([READ_POS]);
    await screen.findByText(/PO-1001/);
    expect(screen.getByText('J00580')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'J00580' })).not.toBeInTheDocument();
  });

  it('still says "No job link" for an order with no job and no customer', async () => {
    serve('found');
    open([READ_POS]);
    await screen.findByText(/PO-1001/);
    expect(screen.getByText('No job link')).toBeInTheDocument();
  });
});

