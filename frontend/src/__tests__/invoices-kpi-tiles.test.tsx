// The Invoices KPI row, driven through the page that actually routes.
//
// `/invoices` renders `pages/v2/invoices/InvoicesPage` (see
// `pages/v2/routes/invoices.routes.tsx`). The older `pages/InvoicesPage.tsx`
// has no importer outside tests, so `invoices-page.test.tsx` — which asserts
// a four-tile row including "Unsent Drafts" — is describing a page no user
// reaches. This file covers the routed one instead.
//
// Why pin the tile SET rather than a single label: `StatCardGroup` lays the
// row out as `xl:grid-cols-4`, so a fifth tile silently wraps onto a second
// row with one card stranded beside three empty columns. That is a layout
// regression no assertion about an individual tile would catch, and it is
// exactly what adding "Deposits Held" as a fifth tile did.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';

const mockApi = vi.mocked(api);

const STATS = {
  due: { total: 664926.42, count: 188 },
  overdue: { total: 664926.42, count: 188 },
  collected_this_month: { total: 27238.83, count: 2 },
  unsent: 30,
  need_invoices: 68,
  deposits_held: 1024286.65,
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  mockApi.get.mockReset();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/invoices') {
      return Promise.resolve({
        data: { invoices: [], total: 0, page: 1, pageSize: 25, stats: STATS },
      });
    }
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [] } });
    return Promise.resolve({ data: {} });
  });
});

const { default: InvoicesPage } = await import('@/pages/v2/invoices/InvoicesPage');

/** StatCard renders its label in its own `<span>`; matching that exact node
 *  avoids colliding with the "Due Date" column header. */
const tileLabels = () =>
  Array.from(document.querySelectorAll('span'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter((t) => ['Due', 'Overdue', 'Unsent Drafts', 'To Be Invoiced', 'Deposits Held'].includes(t));

describe('the Invoices KPI row', () => {
  it('shows exactly four tiles, so the xl:grid-cols-4 row does not wrap', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(screen.getByText('Due', { selector: 'span' })).toBeInTheDocument();
    });

    expect(tileLabels()).toEqual(['Due', 'Overdue', 'To Be Invoiced', 'Deposits Held']);
  });

  it('no longer offers the "Unsent Drafts" tile', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(screen.getByText('Due', { selector: 'span' })).toBeInTheDocument();
    });

    expect(screen.queryByText('Unsent Drafts', { selector: 'span' })).toBeNull();
  });

  it('still renders Deposits Held, which the removal was making room for', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(screen.getByText('Deposits Held', { selector: 'span' })).toBeInTheDocument();
    });

    expect(screen.getByText('$1,024,286.65')).toBeInTheDocument();
  });
});
