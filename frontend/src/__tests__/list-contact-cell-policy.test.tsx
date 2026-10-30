/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.5 - the list pages' contact cell draws a customer's phone and email through
   the contact display policy. Renders the ROUTED pages (pages/v2/leads/LeadsPage, pages/v2/customers/CustomersPage).

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend catalog
   file, never typed here). Every case is a custom switch set, never a built-in role name. The "Me" route is answered
   by the api stub itself, so the refetch after first paint cannot wipe the seeded switches.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { renderWithProviders, seedMySwitches } from './helpers';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { catalogToggle } from './support/backendSwitchCatalog';
import LeadsPage from '@/pages/v2/leads/LeadsPage';
import CustomersPage from '@/pages/v2/customers/CustomersPage';

vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

type Switches = { copyPhone: boolean; copyEmail: boolean; contact: boolean };

function meValues(s: Switches): Record<string, boolean> {
  return {
    [catalogToggle('Copy customer phone').key]: s.copyPhone,
    [catalogToggle('Copy customer email').key]: s.copyEmail,
    [catalogToggle('Contact customers').key]: s.contact,
    [catalogToggle('View customers').key]: true,
  };
}

const PHONE_TEXT = '(555) 123-4567';
const EMAIL = 'dana@example.test';

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  customer_number: 'C00001',
  first_name: 'Dana',
  last_name: 'Reyes',
  company_name: null,
  email: EMAIL,
  phone: '5551234567',
  ad_source: null,
  created_at: '2026-01-15T00:00:00.000Z',
  service_locations: [],
  _count: { leads: 1, jobs: 2 },
  tags: [],
};

const LEAD_ROW = {
  id: 'e0000000-0000-0000-0000-000000000001',
  lead_number: 'L00001',
  status: 'NEW',
  service_request: 'AC not cooling',
  job_type: null,
  service_city: 'Austin',
  service_state: 'TX',
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  contacted_at: null,
  service_location_id: null,
  created_at: '2026-08-24T22:00:00.000Z',
  customer: { ...CUSTOMER, phone: '5551234567' },
  commission_owner: null,
  lead_assignees: [],
  estimates: [],
};

function stubApi(s: Switches) {
  seedMySwitches(meValues(s));
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: meValues(s) } };
    if (url === '/api/leads') {
      return {
        data: {
          leads: [LEAD_ROW],
          pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
          stats: { total: 1, new_this_week: 0, no_owner: 0, won: 0, lost: 0 },
        },
      };
    }
    if (url === '/api/customers') {
      return { data: { customers: [CUSTOMER], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } } };
    }
    if (url === '/api/customers/stats') return { data: { total: 1, newThisMonth: 0, activeLeads: 0, activeJobs: 0 } };
    if (url.startsWith('/api/me/table-views/')) return { data: {} };
    return { data: {} };
  });
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

async function leadRow() {
  renderWithProviders(
    <>
      <LeadsPage />
      <Where />
    </>,
  );
  await screen.findByText('AC not cooling');
  return within(screen.getByText('AC not cooling').closest('tr')!);
}

async function customerRow() {
  renderWithProviders(<CustomersPage />);
  await screen.findByText('Dana Reyes');
  return within(screen.getByText('Dana Reyes').closest('tr')!);
}

/** A copy event the page lets through reports `true`; one it blocks (preventDefault) reports `false`. */
const copyIsAllowed = (el: HTMLElement) => fireEvent.copy(el);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  phoneService.value = true;
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

describe('the Leads list Phone cell, Copy customer phone off', () => {
  it('shows the digits with no copy button, no selection and no tap action, without the phone service', async () => {
    phoneService.value = false;
    stubApi({ copyPhone: false, copyEmail: true, contact: true });
    const row = await leadRow();

    const digits = row.getByText(PHONE_TEXT);
    expect(row.queryByRole('button', { name: 'Copy phone number' })).toBeNull();
    expect(row.queryByRole('link', { name: PHONE_TEXT })).toBeNull();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
    expect(row.queryByRole('button', { name: PHONE_TEXT })).toBeNull();
    expect(digits).toHaveClass('select-none');
    expect(copyIsAllowed(digits)).toBe(false);
  });

  it('shows the digits with no tap action and no native link when the person may not contact customers', async () => {
    stubApi({ copyPhone: false, copyEmail: true, contact: false });
    const row = await leadRow();

    expect(row.getByText(PHONE_TEXT)).toHaveClass('select-none');
    expect(row.queryByRole('button', { name: PHONE_TEXT })).toBeNull();
    expect(row.queryByRole('link', { name: PHONE_TEXT })).toBeNull();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
    expect(row.queryByRole('button', { name: 'Copy phone number' })).toBeNull();
  });

  it('still opens the in-app dialer from a tap, with the lead attached, and never a native link', async () => {
    const user = userEvent.setup();
    stubApi({ copyPhone: false, copyEmail: true, contact: true });
    const row = await leadRow();

    expect(row.queryByRole('button', { name: 'Copy phone number' })).toBeNull();
    expect(row.getByText(PHONE_TEXT)).toHaveClass('select-none');
    await user.click(row.getByRole('button', { name: PHONE_TEXT }));
    await user.click(await screen.findByRole('menuitem', { name: /Call/ }));

    expect(requestCall).toHaveBeenCalledWith(
      '5551234567',
      expect.objectContaining({ leadId: LEAD_ROW.id, customerId: CUSTOMER.id }),
    );
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
  });
});

describe('the Leads list Phone cell, Copy customer phone on', () => {
  it('keeps today: a copy button, selectable digits, and a native call link without the phone service', async () => {
    phoneService.value = false;
    stubApi({ copyPhone: true, copyEmail: true, contact: true });
    const row = await leadRow();

    expect(row.getByRole('button', { name: 'Copy phone number' })).toBeInTheDocument();
    expect(row.getByText(PHONE_TEXT)).not.toHaveClass('select-none');
    expect(row.getByRole('link', { name: PHONE_TEXT })).toHaveAttribute('href', 'tel:5551234567');
  });

  it('keeps the copy button next to the in-app dialer tap with the phone service', async () => {
    stubApi({ copyPhone: true, copyEmail: true, contact: true });
    const row = await leadRow();

    expect(row.getByRole('button', { name: 'Copy phone number' })).toBeInTheDocument();
    expect(row.getByRole('button', { name: PHONE_TEXT })).toBeInTheDocument();
    expect(row.queryByRole('link', { name: PHONE_TEXT })).toBeNull();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
  });

  it('Text from the number opens the in-app composer and does not also open the row', async () => {
    const user = userEvent.setup();
    stubApi({ copyPhone: true, copyEmail: true, contact: true });
    const row = await leadRow();

    await user.click(row.getByRole('button', { name: PHONE_TEXT }));
    await user.click(await screen.findByRole('menuitem', { name: /Text/ }));
    // Text opens the in-app composer; the row (which would open the lead) must not also fire.
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/communication\/text$/);
  });
});

describe('the Customers list contact cells', () => {
  it('Copy customer phone off and Copy customer email off: neither can be selected, copied or tapped through a native link', async () => {
    phoneService.value = false;
    stubApi({ copyPhone: false, copyEmail: false, contact: true });
    const row = await customerRow();

    expect(row.queryByRole('button', { name: 'Copy phone number' })).toBeNull();
    expect(row.queryByRole('button', { name: 'Copy email address' })).toBeNull();
    expect(row.queryByRole('link', { name: PHONE_TEXT })).toBeNull();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
    const email = row.getByText(EMAIL);
    expect(email).toHaveClass('select-none');
    expect(copyIsAllowed(email)).toBe(false);
    expect(row.getByText(PHONE_TEXT)).toHaveClass('select-none');
  });

  it('Copy customer email off with Copy customer phone on: the email is dead text, the phone keeps its copy button', async () => {
    stubApi({ copyPhone: true, copyEmail: false, contact: true });
    const row = await customerRow();

    expect(row.queryByRole('button', { name: 'Copy email address' })).toBeNull();
    expect(row.queryByRole('link', { name: EMAIL })).toBeNull();
    expect(row.getByRole('button', { name: 'Copy phone number' })).toBeInTheDocument();
  });

  it('both on: the email is a mail link with a copy button and the phone a tap with a copy button', async () => {
    stubApi({ copyPhone: true, copyEmail: true, contact: true });
    const row = await customerRow();

    expect(row.getByRole('link', { name: EMAIL })).toHaveAttribute('href', `mailto:${EMAIL}`);
    expect(row.getByRole('button', { name: 'Copy email address' })).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Copy phone number' })).toBeInTheDocument();
    expect(row.getByText(EMAIL)).not.toHaveClass('select-none');
  });
});
