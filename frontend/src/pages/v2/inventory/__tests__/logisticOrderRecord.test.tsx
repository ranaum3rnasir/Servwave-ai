/**
 * Roles & Permissions S07.9 - a logistic order opened from its alert (or any link) opens on View logistic orders alone.
 *
 * The single-order address (`/inventory/logistic-orders/:orderId`) is a record route: it carries no list guard
 * (the order opens whatever the list switches say), and the page asks the server. With the
 * order readable it draws the one order sheet the list uses, with the buttons the server's `actions` list names; with the
 * server's refusal, or without View logistic orders at all, it draws a plain not-found state that says nothing about whether
 * the order exists. The HTTP layer is mocked; the page is the one the route renders and the data hooks are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import LogisticOrderRecordPage from '@/pages/v2/inventory/LogisticOrderRecordPage';
import type { LogisticOrderDetail } from '@/lib/api/logisticOrders';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
vi.mock('@/lib/axios');

const ORDER_ID = 'b0000000-0000-4000-8000-000000000001';
const ISO = '2026-07-18T10:00:00.000Z';

function order(actions: LogisticOrderDetail['actions']): LogisticOrderDetail {
  return {
    id: ORDER_ID, number: 'LO00001', seq: 1, status: 'PENDING_APPROVAL', notes: null, anchors: { jobId: 'j1', jobNumber: 'J00042' },
    lines: [{ id: 'l1', itemId: 'i1', itemSku: 'SKU1', itemName: 'Filter 20x20', qty: 2, fromLocationId: 'loc1', fromLocationName: 'Main', sequence: 0 }],
    lineCount: 1, createdBy: { id: 'u1', name: 'Dana' }, submittedBy: { id: 'u1', name: 'Dana' }, approvedBy: null, processedBy: null,
    takenBy: null, recordedBy: null, takenAt: null, submittedAt: ISO, approvedAt: null, processedAt: null, cancelledAt: null,
    cancelledReason: null, createdAt: ISO, updatedAt: ISO, actions,
  };
}

const READ_ORDERS: AbilityRule = { action: 'read', subject: 'LogisticOrder' };
const orderCalls = () => mockApi.get.mock.calls.filter((c) => String(c[0]) === `/api/logistic-orders/${ORDER_ID}`);

function serve(answer: LogisticOrderDetail | 'refused' | 'missing') {
  mockApi.get.mockImplementation((async (url: string) => {
    if (url === `/api/logistic-orders/${ORDER_ID}`) {
      if (typeof answer !== 'string') return { data: answer };
      throw Object.assign(new Error(answer), { response: { status: answer === 'refused' ? 403 : 404, data: { error: 'x' } } });
    }
    // The list is closed for this person; the order still opens on the server's answer.
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: { view_logistic_orders: false }, rules: [] } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: [{ id: 'loc1', name: 'Main', type: 'warehouse', branch: 'HQ' }] } };
    return { data: { data: [], locations: [], activity: [], users: [], total: 0 } };
  }) as typeof mockApi.get);
}

function open(rules: AbilityRule[]) {
  return renderWithProviders(
    <Routes><Route path="/inventory/logistic-orders/:orderId" element={<LogisticOrderRecordPage />} /></Routes>,
    { initialEntries: [`/inventory/logistic-orders/${ORDER_ID}`], ability: buildAbility(rules) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('a logistic order opened from its alert', () => {
  it('opens on View logistic orders alone, with the list switch off, and offers what the server lists', async () => {
    serve(order(['approve']));
    // The ability holds Approve too, but only what the server lists is offered: no Process, no Cancel.
    open([READ_ORDERS, { action: 'approve', subject: 'LogisticOrder' }, { action: 'process', subject: 'LogisticOrder' }]);

    expect(await screen.findByText('LO00001')).toBeInTheDocument();
    expect(screen.getByText('Filter 20x20')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Process' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
  });

  it('offers no action when the server lists none', async () => {
    serve(order([]));
    open([READ_ORDERS, { action: 'approve', subject: 'LogisticOrder' }]);

    expect(await screen.findByText('LO00001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('draws a plain not-found state, with no order content, when the server refuses the order', async () => {
    serve('refused');
    open([READ_ORDERS]);

    expect(await screen.findByText('Logistic order not found')).toBeInTheDocument();
    expect(screen.queryByText('LO00001')).not.toBeInTheDocument();
    expect(screen.queryByText('Filter 20x20')).not.toBeInTheDocument();
  });

  it('draws the same not-found state when the order does not exist', async () => {
    serve('missing');
    open([READ_ORDERS]);
    expect(await screen.findByText('Logistic order not found')).toBeInTheDocument();
  });

  it('draws not-found without asking the server when View logistic orders is off', async () => {
    serve(order(['approve']));
    open([]);

    expect(await screen.findByText('Logistic order not found')).toBeInTheDocument();
    expect(orderCalls()).toHaveLength(0);
    expect(screen.queryByText('LO00001')).not.toBeInTheDocument();
  });
});
