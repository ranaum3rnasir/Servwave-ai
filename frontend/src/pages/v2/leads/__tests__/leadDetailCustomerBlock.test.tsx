/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.2 - the lead page's customer details under the contact display
   policy. Renders the ROUTED lead page (pages/v2/leads/LeadDetailPage).

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend
   catalog file, never typed here). Every case is a custom switch set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { LEAD_FIXTURE } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

stubBrowser();

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }),
    useNavigate: () => mockNavigate,
  };
});

// Whether the company has the phone service, toggled per test.
const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => phoneService.value,
}));

const mockApi = vi.mocked(api);

type Switches = { copyPhone: boolean; copyEmail: boolean; contact: boolean; view: boolean };
const EVERYTHING_ON: Switches = { copyPhone: true, copyEmail: true, contact: true, view: true };

/** The "Me" answer for a person holding exactly these four switches. */
function meAnswer(s: Switches) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: s.copyPhone,
      [catalogToggle('Copy customer email').key]: s.copyEmail,
      [catalogToggle('Contact customers').key]: s.contact,
      [catalogToggle('View customers').key]: s.view,
    },
  };
}

/** The lead detail as the server answers it: the customer carries every phone and every email. */
const LEAD = {
  ...LEAD_FIXTURE,
  customer: {
    ...LEAD_FIXTURE.customer,
    phones: [
      { phone: '5551234567', label: 'Mobile', extension: null, is_primary: true },
      { phone: '5559876543', label: "Wife's cell", extension: '12', is_primary: false },
    ],
    emails: [
      { email: 'john@doe.com', label: null, is_primary: true },
      { email: 'billing@doe.com', label: 'Billing', is_primary: false },
    ],
  },
};

function renderLeadPage(switches: Switches, opts: { service?: boolean } = {}) {
  phoneService.value = opts.service ?? true;
  // A second render in one case must not start from the first one's remembered answer.
  localStorage.clear();
  serveLeadDetail({ lead: LEAD, me: meAnswer(switches) });
  return renderLeadDetail();
}

/**
 * Until the person's switches arrive the page draws the strictest version, so a "nothing is offered" check
 * made before they land would pass for the wrong reason. Wait for the answer, then let it be applied.
 */
async function switchesLoaded() {
  await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The shared reader keeps the last answer per person; a case starts without the previous case's.
  localStorage.clear();
  phoneService.value = true;
});

describe('the lead page customer details', () => {
  it('lists every phone with its label and extension and every email', async () => {
    renderLeadPage(EVERYTHING_ON);

    expect(await screen.findByText('(555) 123-4567')).toBeInTheDocument();
    expect(screen.getByText('(555) 987-6543 ext. 12')).toBeInTheDocument();
    expect(screen.getByText("Wife's cell")).toBeInTheDocument();
    expect(screen.getByText('john@doe.com')).toBeInTheDocument();
    expect(screen.getByText('billing@doe.com')).toBeInTheDocument();
    expect(screen.getByText('Billing')).toBeInTheDocument();
  });

  it('asks the in-app dialer for the number, with the lead attached, when a phone is tapped', async () => {
    const user = userEvent.setup();
    renderLeadPage({ ...EVERYTHING_ON, copyPhone: false });

    await user.click(await screen.findByRole('button', { name: '(555) 987-6543 ext. 12' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Call' }));

    expect(requestCall).toHaveBeenCalledWith('5559876543', {
      leadId: LEAD.id,
      leadLabel: 'L00001',
      customerId: LEAD.customer.id,
      customerName: 'John Doe',
    });
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  // SPEC-4 §6.8: the lead rides along, so the first reply on that customer's conversation is filed on this lead.
  it('opens the in-app composer from Text on a tapped phone, carrying the lead', async () => {
    const user = userEvent.setup();
    renderLeadPage(EVERYTHING_ON);

    await user.click(await screen.findByRole('button', { name: '(555) 123-4567' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Text' }));

    expect(mockNavigate).toHaveBeenCalledWith(
      `/communication/text?customerId=${LEAD.customer.id}&leadId=e0000000-0000-0000-0000-000000000001`,
    );
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it('carries the lead on Text for a person with View customers off too, going by the tapped number', async () => {
    const user = userEvent.setup();
    renderLeadPage({ ...EVERYTHING_ON, view: false });

    await user.click(await screen.findByRole('button', { name: '(555) 123-4567' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Text' }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const url = new URL(String(mockNavigate.mock.lastCall?.[0]), 'https://app.test');
    expect(url.pathname).toBe('/communication/text');
    expect(url.searchParams.get('owner')).toBe('customer');
    expect(url.searchParams.get('leadId')).toBe(LEAD.id);
  });

  it('shows the digits with no copy control, no selection and no native link with Copy customer phone off', async () => {
    renderLeadPage({ ...EVERYTHING_ON, copyPhone: false }, { service: false });

    const digits = await screen.findByText('(555) 123-4567');
    await switchesLoaded();
    expect(digits.className).toContain('select-none');
    expect(screen.queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
    expect(screen.getByText('(555) 987-6543 ext. 12')).toBeInTheDocument();
  });

  it('shows the copy control for the person whose switch is on and for no one else', async () => {
    const { unmount } = renderLeadPage({ ...EVERYTHING_ON, copyPhone: false });
    await screen.findByText('(555) 123-4567');
    await switchesLoaded();
    expect(screen.queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
    unmount();

    renderLeadPage({ ...EVERYTHING_ON, copyPhone: true });
    expect((await screen.findAllByRole('button', { name: 'Copy phone number' })).length).toBeGreaterThan(0);
  });

  it('gives a copyable phone a device call link when the company has no phone service', async () => {
    renderLeadPage(EVERYTHING_ON, { service: false });

    await screen.findByText('(555) 123-4567');
    await waitFor(() => expect(document.querySelector('a[href="tel:5551234567"]')).not.toBeNull());
    expect(screen.queryByRole('menuitem', { name: 'Call' })).not.toBeInTheDocument();
  });

  it('leaves the address text with no mail link or copy control with Copy customer email off', async () => {
    renderLeadPage({ ...EVERYTHING_ON, copyEmail: false });

    const address = await screen.findByText('billing@doe.com');
    await switchesLoaded();
    expect(address.className).toContain('select-none');
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy email address' })).not.toBeInTheDocument();
  });

  it('makes the customer name a link to the customer page with View customers on, and plain text with it off', async () => {
    const { unmount } = renderLeadPage(EVERYTHING_ON);
    const link = await screen.findByRole('link', { name: 'John Doe' });
    expect(link.getAttribute('href')).toContain(`/customers/${LEAD.customer.id}`);
    unmount();

    renderLeadPage({ ...EVERYTHING_ON, view: false });
    await screen.findByText('(555) 123-4567');
    await switchesLoaded();
    expect(screen.queryByRole('link', { name: 'John Doe' })).not.toBeInTheDocument();
    expect(screen.getAllByText('John Doe').length).toBeGreaterThan(0);
  });
});
