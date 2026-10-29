import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

import CustomerDetailPage from '../CustomerDetailPage';

/**
 * Mobile slice 55: the customer header on the shared detail header.
 *
 * Below sm: Back and the customer on one row (the name wraps, the avatar is left out of the
 * row), the badges and tags, Create New full width, and the customer actions inside a labelled
 * "Customer actions" button. From sm up it is the old row: the avatar, Create New and the
 * three-dot icon menu on the right.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000005';
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }), useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);
const originalMatchMedia = window.matchMedia;

function setPhone(isPhone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isPhone && query === MEDIA.belowSm,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const LONG_COMPANY = 'Featherstonehaugh-Cholmondeley Heating, Cooling and Door Hardware Incorporated';

const CUSTOMER_DETAIL = {
  customer: {
    id: CUSTOMER_ID,
    customer_number: 'C00005',
    first_name: '',
    last_name: '',
    company_name: LONG_COMPANY,
    email: 'rita@example.test',
    phone: '5551230000',
    phone_ext: null,
    secondary_phone: null,
    ad_source: 'Referral',
    allow_billing: false,
    tax_exempt: false,
    payment_type: null,
    extra_emails: [],
    custom_fields: {},
    created_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    is_active: true,
    tags: [],
    service_locations: [],
    _count: { leads: 0, jobs: 0 },
    jobs: [],
    activity_notes: [],
    orphan_invoices: [],
    invoices: [],
  },
  summary: {
    financials: {
      lifetime_revenue: 0, total_invoiced: 0, past_due_balance: 0, due_balance: 0,
      paid_invoice_count: 0, unpaid_invoice_count: 0,
    },
    estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
    deposits: { collected: 0, pending: 0 },
    leads: { open: 0, active: 0 },
    tasks: { open: 0 },
  },
};

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function mount() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') return { data: { id: 'org-1', timezone: 'America/Chicago' } };
    if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL };
    if (url === '/api/leads') return { data: { leads: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } } };
    return { data: {} };
  });
  renderWithProviders(<CustomerDetailPage />, {
    initialEntries: [`/customers/${CUSTOMER_ID}`],
    ability: adminAbility,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
  window.history.replaceState(null, '');
});

describe('customer detail header on a phone (mobile slice 55)', () => {
  it('stacks: Back to the list, a wrapping name, Create New full width and a labelled actions menu', async () => {
    setPhone(true);
    const user = userEvent.setup();
    mount();

    const heading = await screen.findByRole('heading', { level: 1 });
    // The name wraps rather than overflowing the 320 px card.
    expect(heading.textContent).toContain(LONG_COMPANY);
    const header = screen.getByTestId('detail-header');
    expect(within(header).getByText(LONG_COMPANY, { selector: 'span' }).className).toContain('break-words');

    await user.click(screen.getByRole('button', { name: 'Back to customers' }));
    expect(mockNavigate).toHaveBeenCalledWith('/customers');

    const create = screen.getByRole('button', { name: /Create New/ });
    expect(create.parentElement!.className).toContain('[&>button]:h-11');

    const menu = screen.getByRole('button', { name: 'Customer actions' });
    expect(menu.textContent).toContain('Customer actions');
    expect(menu.className).toContain('w-full');
    await user.click(menu);
    expect(await screen.findByRole('menuitem', { name: /Edit client/ })).toBeInTheDocument();
  });

  it('lets the heading wrap so a long name takes its own line instead of a 90 px column', async () => {
    setPhone(true);
    mount();
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.className).toContain('flex-wrap');
  });

  it('keeps the badges (the lead source) in the header', async () => {
    setPhone(true);
    mount();
    const header = await screen.findByTestId('detail-header');
    expect(within(header).getByText('Referral')).toBeInTheDocument();
  });
});

describe('customer detail header from sm up (unchanged)', () => {
  it('has no Back control; Create New and an icon-only Customer actions menu sit beside the name', async () => {
    setPhone(false);
    mount();
    expect(await screen.findByRole('button', { name: /Create New/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to customers' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customer actions' }).textContent?.trim()).toBe('');
  });
});
