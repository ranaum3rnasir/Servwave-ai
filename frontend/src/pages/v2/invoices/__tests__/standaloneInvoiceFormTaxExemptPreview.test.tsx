import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import StandaloneInvoiceFormPage from '@/pages/v2/invoices/StandaloneInvoiceFormPage';
import { buildAbility } from '@/lib/ability';

/**
 * #2041 — the standalone-invoice form's tax preview reads `tax_exempt` off the picked
 * customer via the org-wide picker's expand endpoint (`GET /api/customers/picker/:id`).
 * A previous fix repointed this expand call to the picker without adding `tax_exempt` to the
 * picker projection, so the query became a silent no-op (documented, then fixed, in the
 * controller's `projectPickerRow`). This pins the preview reading the field back through the
 * picker, not `/api/customers/:id`.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// SelectField (location picker) / other kit form controls call ResizeObserver via `new`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const EXEMPT_ROW = {
  id: 'c0000000-0000-0000-0000-0000000000e1',
  first_name: 'Tax',
  last_name: 'Exemptus',
  company_name: null,
  phone: '5125550111',
  phone_ext: null,
  email: 'exempt@example.com',
  ad_source: null,
  tax_exempt: true,
  service_locations: [
    {
      id: 'l0000000-0000-0000-0000-0000000000e1',
      address_line1: '1 Exempt Way',
      address_line2: null,
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      is_primary: true,
    },
  ],
  restricted: false as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/state-tax-rates') {
      return { data: { data: [{ state_code: 'TX', state_name: 'Texas', tax_rate: 0.0825 }] } };
    }
    if (url === '/api/customers/picker') {
      return { data: { customers: [EXEMPT_ROW] } };
    }
    if (url === `/api/customers/picker/${EXEMPT_ROW.id}`) {
      return { data: { customer: EXEMPT_ROW } };
    }
    return { data: { data: [] } };
  });
});

describe('StandaloneInvoiceFormPage — tax-exempt preview reads the picker projection (#2041)', () => {
  it('shows "Tax (exempt)" for a customer picked through the org-wide picker', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });

    await user.type(screen.getByLabelText(/first name/i), 'Ta');
    const resultButton = await screen.findByText(/Tax Exemptus/);
    await user.click(resultButton);

    // The expand call the tax preview depends on.
    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith(`/api/customers/picker/${EXEMPT_ROW.id}`),
    );

    expect(await screen.findByText('Tax (exempt)')).toBeInTheDocument();
  });
});
