import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomerDetailPage from '../CustomerDetailPage';

/**
 * #2041 AC2 — a customer the requester's row-scope excludes 404s at the API, and the LIVE v2
 * detail page (`pages/v2/routes/customers.routes.tsx` mounts this file at `/customers/:id`, not
 * the unrouted v1 `pages/CustomerDetailPage.tsx`) already renders the standard not-found state
 * for ANY failed detail query — no code change needed here (spec: "assert it, do not rebuild
 * it"). This pins that assertion so a future refactor of the error branch cannot silently drop it.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-00000000b041';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});

const mockApi = vi.mocked(api);

describe('CustomerDetailPage — not-found state on a scoped-out 404', () => {
  it('renders "Customer not found." with no crash or blank page, and a way back to the list', async () => {
    mockApi.get.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: 'Customer not found' } },
    });

    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    expect(await screen.findByText('Customer not found.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to customers/i })).toBeInTheDocument();
  });
});
