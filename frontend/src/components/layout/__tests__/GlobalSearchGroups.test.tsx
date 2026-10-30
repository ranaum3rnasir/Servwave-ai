/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 4, slice S04.7: top search shows the groups the server answers with.
//
// The server returns up to five rows each of jobs, leads, estimates, invoices and customers, every group
// already narrowed to what the person can open (an invoice they created on a job they are still on is
// one of them). The screen has to show every group it is given, so a field worker who finds their own
// invoice by search can open it, and has no heading for a group the server left empty.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import GlobalSearch from '../GlobalSearch';

const get = vi.fn();
vi.mock('@/lib/axios', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

const none = { jobs: [], customers: [], leads: [], estimates: [], invoices: [], servicePlans: [], calendarEntries: [] };

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<GlobalSearch />} />
          <Route path="/invoices/:id" element={<div>Invoice page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function searchFor(term: string) {
  const user = userEvent.setup();
  renderSearch();
  await user.type(screen.getByRole('combobox', { name: 'Search everything' }), term);
  return { user, list: await screen.findByRole('listbox') };
}

beforeEach(() => get.mockReset());

describe('top search groups', () => {
  it('shows the invoices the server returns, under their own heading, and opens one', async () => {
    get.mockResolvedValue({
      data: {
        results: {
          ...none,
          jobs: [{ id: 'j1', entity_type: 'job', title: 'J-1001', subtitle: 'Pat Payer', status: 'SCHEDULED' }],
          invoices: [{ id: 'i1', entity_type: 'invoice', title: 'INV-2001', subtitle: 'Pat Payer', status: 'DRAFT', total: 100 }],
        },
      },
    });
    const { user, list } = await searchFor('pat');

    expect(await within(list).findByText('Invoices')).toBeInTheDocument();
    const row = within(list).getByRole('option', { name: /INV-2001/ });
    expect(within(row).getByText(/^Draft/)).toBeInTheDocument();

    await user.click(row);
    expect(await screen.findByText('Invoice page')).toBeInTheDocument();
  });

  it('shows a heading only for a group the server answered with', async () => {
    get.mockResolvedValue({
      data: { results: { ...none, jobs: [{ id: 'j1', entity_type: 'job', title: 'J-1001', subtitle: 'Pat Payer' }] } },
    });
    const { list } = await searchFor('pat');

    expect(await within(list).findByText('Jobs')).toBeInTheDocument();
    for (const heading of ['Customers', 'Invoices', 'Leads', 'Estimates']) {
      expect(within(list).queryByText(heading)).toBeNull();
    }
  });
});
