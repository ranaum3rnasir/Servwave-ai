/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.5 - the customer page's contact lines (the sidebar's phones and emails) are
   drawn through the contact display policy, for a person who can open the page (a custom role with View customers on
   and, here, Copy customer phone or email off). Renders the ROUTED customer page (pages/v2/customers/CustomerDetailPage).

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend catalog
   file, never typed here). The "Me" route is answered by the api stub itself, so the refetch after first paint cannot
   wipe the seeded switches.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders, seedMySwitches } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { requestCall } from '@/lib/communication/phoneTabHandoff';

import CustomerDetailPage from '../CustomerDetailPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000021';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'c0000000-0000-0000-0000-000000000021' }) };
});
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

// Whether the company has the phone service, toggled per test.
const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements')>();
  return {
    ...actual,
    useFeature: (feature: Parameters<typeof actual.useFeature>[0]) =>
      feature === 'phone' ? phoneService.value : actual.useFeature(feature),
  };
});

const mockApi = vi.mocked(api);

const PRIMARY_PHONE = '(555) 123-0021';
const SECONDARY_PHONE = '(555) 123-0022';
const PRIMARY_EMAIL = 'dana@example.test';
const EXTRA_EMAIL = 'billing@example.test';

const CUSTOMER_DETAIL = {
  customer: {
    id: CUSTOMER_ID,
    customer_number: 'C00021',
    first_name: 'Dana',
    last_name: 'Reyes',
    company_name: null,
    email: PRIMARY_EMAIL,
    phone: '5551230021',
    phone_ext: null,
    secondary_phone: '5551230022',
    secondary_phone_ext: null,
    ad_source: null,
    allow_billing: false,
    tax_exempt: false,
    payment_type: null,
    extra_emails: [{ id: 'e1', email: EXTRA_EMAIL, label: 'Billing' }],
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

type Switches = { copyPhone: boolean; copyEmail: boolean; contact: boolean };

function meValues(s: Switches): Record<string, boolean> {
  return {
    [catalogToggle('Copy customer phone').key]: s.copyPhone,
    [catalogToggle('Copy customer email').key]: s.copyEmail,
    [catalogToggle('Contact customers').key]: s.contact,
    [catalogToggle('View customers').key]: true,
  };
}

/** The ability the same person's switches compile into: they read customers, and contact them only with the switch. */
const abilityFor = (s: Switches) =>
  buildAbility([
    { action: 'read', subject: 'Customer' },
    ...(s.contact ? [{ action: 'create', subject: 'Communication' } as const] : []),
  ]);

async function openPage(s: Switches, opts: { phoneService?: boolean } = {}) {
  phoneService.value = opts.phoneService ?? true;
  seedMySwitches(meValues(s));
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: meValues(s) } };
    if (url === '/api/organization') return { data: { id: 'org-1', timezone: 'America/Chicago' } };
    if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL };
    if (url === '/api/leads') return { data: { leads: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } } };
    return { data: {} };
  });
  const user = userEvent.setup();
  renderWithProviders(<CustomerDetailPage />, {
    initialEntries: [`/customers/${CUSTOMER_ID}`],
    ability: abilityFor(s),
  });
  await screen.findByRole('heading', { level: 1 });
  const sidebar = (await screen.findByText('Contact Details')).parentElement as HTMLElement;
  return { user, sidebar: within(sidebar) };
}

/** A copy event the page lets through reports `true`; one it blocks (preventDefault) reports `false`. */
const copyIsAllowed = (el: HTMLElement) => fireEvent.copy(el);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  phoneService.value = true;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

describe('the customer page phones, Copy customer phone off', () => {
  it('shows both numbers as digits that cannot be selected, copied or dialled through a native link, without the phone service', async () => {
    const { sidebar } = await openPage({ copyPhone: false, copyEmail: true, contact: true }, { phoneService: false });

    for (const digits of [PRIMARY_PHONE, SECONDARY_PHONE]) {
      const el = sidebar.getByText(digits);
      expect(el).toHaveClass('select-none');
      expect(copyIsAllowed(el)).toBe(false);
      expect(sidebar.queryByRole('link', { name: digits })).toBeNull();
      expect(sidebar.queryByRole('button', { name: digits })).toBeNull();
    }
    expect(sidebar.queryByRole('button', { name: 'Copy phone number' })).toBeNull();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
  });

  it('with the phone service and Contact customers, a tap still opens the in-app dialer for the customer, with no copy button', async () => {
    const { user, sidebar } = await openPage({ copyPhone: false, copyEmail: true, contact: true });

    expect(sidebar.queryByRole('button', { name: 'Copy phone number' })).toBeNull();
    expect(sidebar.getByText(PRIMARY_PHONE)).toHaveClass('select-none');
    expect(copyIsAllowed(sidebar.getByText(PRIMARY_PHONE))).toBe(false);
    await user.click(sidebar.getByRole('button', { name: PRIMARY_PHONE }));
    await user.click(await screen.findByRole('menuitem', { name: /Call/ }));

    expect(requestCall).toHaveBeenCalledWith('5551230021', { customerId: CUSTOMER_ID, customerName: 'Dana Reyes' });
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
  });

  it('without Contact customers a tap does nothing: the digits are plain text', async () => {
    const { sidebar } = await openPage({ copyPhone: false, copyEmail: true, contact: false });

    expect(sidebar.getByText(PRIMARY_PHONE)).toHaveClass('select-none');
    expect(copyIsAllowed(sidebar.getByText(PRIMARY_PHONE))).toBe(false);
    expect(sidebar.queryByRole('button', { name: PRIMARY_PHONE })).toBeNull();
    expect(sidebar.queryByRole('link', { name: PRIMARY_PHONE })).toBeNull();
  });
});

describe('the customer page phones, Copy customer phone on', () => {
  it('keeps today: selectable digits, a copy button on each number and a native call link without the phone service', async () => {
    const { sidebar } = await openPage({ copyPhone: true, copyEmail: true, contact: true }, { phoneService: false });

    expect(sidebar.getAllByRole('button', { name: 'Copy phone number' })).toHaveLength(2);
    expect(sidebar.getByText(PRIMARY_PHONE)).not.toHaveClass('select-none');
    expect(sidebar.getByRole('link', { name: PRIMARY_PHONE })).toHaveAttribute('href', 'tel:5551230021');
  });

  it('with the phone service the number is an in-app Call or Text tap beside its copy button', async () => {
    const { sidebar } = await openPage({ copyPhone: true, copyEmail: true, contact: true });

    expect(sidebar.getByRole('button', { name: PRIMARY_PHONE })).toBeInTheDocument();
    expect(sidebar.getAllByRole('button', { name: 'Copy phone number' })).toHaveLength(2);
    expect(sidebar.queryByRole('link', { name: PRIMARY_PHONE })).toBeNull();
  });
});

describe('the customer page emails', () => {
  it('Copy customer email off, no phone service: both addresses are plain text with no mail link and no copy button', async () => {
    const { sidebar } = await openPage({ copyPhone: true, copyEmail: false, contact: true }, { phoneService: false });

    for (const address of [PRIMARY_EMAIL, EXTRA_EMAIL]) {
      const el = sidebar.getByText(address);
      expect(el).toHaveClass('select-none');
      expect(copyIsAllowed(el)).toBe(false);
      expect(sidebar.queryByRole('link', { name: address })).toBeNull();
      expect(sidebar.queryByRole('button', { name: address })).toBeNull();
    }
    expect(sidebar.queryByRole('button', { name: 'Copy email address' })).toBeNull();
  });

  it('Copy customer email off, with the in-app email composer: the address cannot be selected or copied but still opens the composer', async () => {
    const { user, sidebar } = await openPage({ copyPhone: true, copyEmail: false, contact: true });

    expect(sidebar.getByText(PRIMARY_EMAIL)).toHaveClass('select-none');
    expect(copyIsAllowed(sidebar.getByText(PRIMARY_EMAIL))).toBe(false);
    expect(sidebar.getByRole('button', { name: PRIMARY_EMAIL })).toBeInTheDocument();
    expect(sidebar.queryByRole('button', { name: 'Copy email address' })).toBeNull();
    await user.click(sidebar.getByRole('button', { name: PRIMARY_EMAIL }));
    expect(await screen.findByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('Copy customer email on keeps today: a mail link without the composer, a copy button on each address', async () => {
    const { sidebar } = await openPage({ copyPhone: true, copyEmail: true, contact: false }, { phoneService: false });

    expect(sidebar.getByRole('link', { name: PRIMARY_EMAIL })).toHaveAttribute('href', `mailto:${PRIMARY_EMAIL}`);
    expect(sidebar.getAllByRole('button', { name: 'Copy email address' })).toHaveLength(2);
    expect(sidebar.getByText(PRIMARY_EMAIL)).not.toHaveClass('select-none');
  });
});
