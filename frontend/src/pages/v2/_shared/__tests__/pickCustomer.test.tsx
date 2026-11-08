/**
 * SRVW-261: the customer search dropdown must not cover the field it
 * belongs to.
 *
 * RED before the fix: the panel was `absolute ... w-full` with no
 * top/left, and it was the last child of a `relative flex flex-col`
 * wrapper. For an absolutely positioned child of a FLEX container, the
 * static position is the container's content-box start corner (not
 * "after the preceding siblings" as in a block container), so the panel
 * painted over the Label and Input instead of landing below them.
 *
 * jsdom performs no layout, so this pins the class-level anchor
 * (`top-full left-0 right-0`, the repo's established idiom) rather than
 * pretending to assert the rendered geometry.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import api from '@/lib/axios';
import { PickCustomerFields } from '../pickCustomer';
import type { CustomerContactFields } from '@/components/crm/PickOrCreateCustomer';

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { customers: [] } }) },
}));

const EMPTY_FIELDS: CustomerContactFields = {
  first_name: '',
  last_name: '',
  company_name: '',
  phone: '',
  email: '',
};

function renderFields(props: Partial<React.ComponentProps<typeof PickCustomerFields>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PickCustomerFields
        fields={{ ...EMPTY_FIELDS, first_name: 'Jo' }}
        onFieldChange={() => {}}
        selectedCustomer={null}
        onSelectCustomer={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('CustomerDropdown anchoring', () => {
  it('anchors the panel below the field via top-full, not the flex static position', async () => {
    const user = userEvent.setup();
    renderFields();

    await user.click(screen.getByLabelText(/first name/i));

    const panel = await waitFor(() => screen.getByText('No customers found').closest('div'));
    expect(panel).toHaveClass('top-full');
    expect(panel).toHaveClass('left-0');
    expect(panel).toHaveClass('right-0');
  });
});

/**
 * #2041 slice 1 — the create-form typeahead searches the ORG-WIDE picker endpoint (Ran's
 * carve-out), not the row-scoped `/api/customers` list, so a rep can still start a lead on a
 * customer they have never worked with once slice 2 scopes the list. See
 * `md_files/plans/agents/runs/issue-2041/slice-1.md`.
 */
describe('#2041 slice 1 — searches the org-wide picker endpoint', () => {
  it('calls GET /api/customers/picker, not the scoped /api/customers list', async () => {
    const getMock = vi.mocked(api.get);
    getMock.mockResolvedValue({ data: { customers: [] } });
    const user = userEvent.setup();
    renderFields();

    await user.click(screen.getByLabelText(/first name/i));

    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/api/customers/picker', { params: { search: 'Jo', limit: 6 } }),
    );
    expect(getMock.mock.calls.some(([url]) => url === '/api/customers')).toBe(false);
  });
});

describe('#2041 slice 1 — a restricted picker row selects cleanly', () => {
  it('passes a redacted row (no email/phone/service_locations) straight to onSelectCustomer, without throwing', async () => {
    const restrictedRow = {
      id: 'r0000000-0000-0000-0000-000000000001',
      first_name: 'Res',
      last_name: 'Tricted',
      company_name: null,
      phone_last4: '1234',
      city: 'Austin',
      restricted: true,
    };
    vi.mocked(api.get).mockResolvedValue({ data: { customers: [restrictedRow] } });
    const onSelectCustomer = vi.fn();
    const user = userEvent.setup();
    renderFields({ onSelectCustomer });

    await user.click(screen.getByLabelText(/first name/i));
    const resultButton = await screen.findByText(/Res Tricted/);
    await user.click(resultButton);

    expect(onSelectCustomer).toHaveBeenCalledTimes(1);
    expect(onSelectCustomer).toHaveBeenCalledWith(restrictedRow);
  });
});
