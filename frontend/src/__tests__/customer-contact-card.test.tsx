// The Customer & Contact card draws the customer through the contact display policy (Roles &
// Permissions, PRD 5): with the phone service and Contact customers on, Call and the phone row go to
// the in-app dialer with FULL entity attribution (jobId/jobLabel/customerId/customerName) and Text opens
// the in-app composer; without the phone service a native link follows Copy customer phone. The
// policy's own table is in components/contact/__tests__/contactDisplayPolicy.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { CustomerContactCard } from '@/components/jobs/overview/CustomerContactCard';
import { catalogToggle } from './support/backendSwitchCatalog';
import { CALL_NOT_SET_UP_MESSAGE } from '@/components/contact/contactDisplayPolicy';

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mockNavigate,
}));

// Org-level comms access — toggled per test (settings-unsaved-guard precedent).
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Mobile slice 50: whether the browser is on a phone, toggled per test.
const onPhone = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/device/isPhoneDevice', () => ({ isPhoneDevice: () => onPhone.value }));

// Task B4 — the call tile/row route through the cross-tab dial handoff, not
// the legacy in-app GlobalDialer popup; stub it so these specs assert the
// call was requested without needing a real window.open.
vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
}));

const JOB = {
  id: 'b0000000-0000-0000-0000-000000000001',
  job_number: 'J00042',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Daniel',
    last_name: 'Cohen',
    company_name: null,
    email: 'daniel@vaultcorp.com',
    phone: '5551234567',
  },
  service_location: null,
};

const EXPECTED_CONTEXT = {
  jobId: JOB.id,
  jobLabel: 'J00042',
  customerId: JOB.customer.id,
  customerName: 'Daniel Cohen',
};

const fullAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);

type Switches = { copyPhone: boolean; contact: boolean; view: boolean };

/** The person's "Me" answer for these switches; the recent-communications preview answers an empty list. */
function signedInWith({ copyPhone, contact, view }: Switches) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') {
      return {
        data: {
          admin_box: false,
          values: {
            [catalogToggle('Copy customer phone').key]: copyPhone,
            [catalogToggle('Copy customer email').key]: true,
            [catalogToggle('Contact customers').key]: contact,
            [catalogToggle('View customers').key]: view,
          },
        },
      };
    }
    return { data: { items: [] } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The shared reader keeps the last answer per person; a case starts without the previous case's.
  localStorage.clear();
  commAccess.value = true;
  onPhone.value = false;
  signedInWith({ copyPhone: true, contact: true, view: true });
});

describe('CustomerContactCard Text entry (S05.1)', () => {
  it('phone service + Contact customers: Text opens the in-app composer for the customer, not an sms: link', async () => {
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    await userEvent.click(await screen.findByRole('button', { name: 'Text' }));

    expect(mockNavigate).toHaveBeenCalledWith(`/communication/text?customerId=${JOB.customer.id}`);
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it('phone service but Contact customers off: no Text action at all', async () => {
    signedInWith({ copyPhone: true, contact: false, view: true });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    await screen.findByText('(555) 123-4567');
    expect(screen.queryByRole('button', { name: /^Text/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
  });

  it('no phone service: Text keeps the native sms: anchor while Copy customer phone is on, and is gone with it off', async () => {
    commAccess.value = false;
    const { unmount } = renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });
    expect(await screen.findByRole('link', { name: 'Text' })).toHaveAttribute('href', 'sms:5551234567');
    unmount();
    localStorage.clear(); // a different person's answer: not the one the first render kept

    signedInWith({ copyPhone: false, contact: true, view: true });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });
    await screen.findByText('(555) 123-4567');
    expect(screen.queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
  });
});

describe('CustomerContactCard Map tile (mobile slice 50)', () => {
  const JOB_AT_SITE = {
    ...JOB,
    service_location: {
      address_line1: '12 Main St',
      address_line2: null,
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
    },
  };

  it('opens the device maps app through a universal maps link, not a vendor page', () => {
    renderWithProviders(<CustomerContactCard job={JOB_AT_SITE} />, { ability: readOnlyAbility });

    // jsdom is not an Apple device, so this is the universal search link Android hands to its maps app.
    expect(screen.getByRole('link', { name: 'Map' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=12%20Main%20St%2C%20Springfield%2C%20IL%2C%2062701',
    );
  });
});

describe('CustomerContactCard call entry (S05.1)', () => {
  it('phone service + Contact customers: the Call action goes to the dialer with full job context', async () => {
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    await userEvent.click(await screen.findByRole('button', { name: 'Call' }));

    expect(mockRequestCall).toHaveBeenCalledWith('5551234567', EXPECTED_CONTEXT);
    expect(screen.queryByRole('link', { name: 'Call' })).not.toBeInTheDocument();
  });

  it('phone service + Contact customers: tapping the phone row offers Call or Text, and Call dials with the same context', async () => {
    // Mobile slice 50: a tapped number never dials by itself.
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    await userEvent.click(await screen.findByRole('button', { name: '(555) 123-4567' }));
    expect(mockRequestCall).not.toHaveBeenCalled();
    expect(await screen.findByRole('menuitem', { name: /Text/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Call/ }));

    expect(mockRequestCall).toHaveBeenCalledWith('5551234567', EXPECTED_CONTEXT);
  });

  it('on a phone the Call action and the number go to the dialer hand-off, which opens the same-tab sheet (slice 63)', async () => {
    onPhone.value = true;
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    await userEvent.click(await screen.findByRole('button', { name: 'Call' }));
    expect(mockRequestCall).toHaveBeenCalledWith('5551234567', EXPECTED_CONTEXT);

    await userEvent.click(screen.getByRole('button', { name: '(555) 123-4567' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Call/ }));
    expect(mockRequestCall).toHaveBeenCalledTimes(2);
  });

  it('phone service but Contact customers off: the digits show, with nothing to tap and no native link', async () => {
    signedInWith({ copyPhone: true, contact: false, view: true });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    await screen.findByText('(555) 123-4567');
    expect(screen.queryByRole('button', { name: /^Call/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '(555) 123-4567' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(mockRequestCall).not.toHaveBeenCalled();
  });

  it('no phone service: Call and the number are native tel: anchors while Copy customer phone is on', async () => {
    commAccess.value = false;
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    expect(await screen.findByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:5551234567');
    expect(screen.getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute('href', 'tel:5551234567');
    expect(screen.queryByRole('button', { name: /^Call/ })).not.toBeInTheDocument();
  });

  it('no phone service and Copy customer phone off: digits only, a disabled Call and the plain support message', async () => {
    commAccess.value = false;
    signedInWith({ copyPhone: false, contact: true, view: true });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    expect(await screen.findByText('(555) 123-4567')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Call/ })).toBeDisabled();
    expect(screen.getByText(CALL_NOT_SET_UP_MESSAGE)).toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
  });
});

/**
 * Manual Communication Log (slice 7 remediation, carry-forward C8).
 *
 * This card previews the SAME aggregator endpoint the Communication tab renders
 * (GET /api/jobs/:id/communications), which has carried hand-logged entries since slice 5. The
 * feature's central constraint is that a typed-up record of an off-platform conversation must
 * never be mistakable for something the platform recorded — and a preview is exactly where a
 * reader glances before citing a "call" that never went through ServWave.
 *
 * The pair is what makes this discriminating: a hand-logged row carries the marker AND a platform
 * row in the same list does not. Asserting only the first half stays green if the marker is
 * rendered unconditionally, which would be a different lie.
 */
describe('CustomerContactCard communication history — hand-entered provenance (C8)', () => {
  const PLATFORM_CALL = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    channel: 'call',
    direction: 'out',
    who: 'Daniel Cohen',
    title: 'Outbound call · 4m 07s',
    preview: 'Recorded by the platform',
    at: '2026-08-20T15:00:00.000Z',
  };
  const HAND_LOGGED_CALL = {
    id: 'bbbbbbbb-0000-0000-0000-000000000002',
    channel: 'call',
    direction: 'out',
    who: 'Daniel Cohen',
    title: 'Outbound call',
    preview: 'Talked through the quote on my mobile',
    at: '2026-08-21T15:00:00.000Z',
    manuallyLogged: true,
    loggedByName: 'Dana Reyes',
    performedByName: 'Dana Reyes',
  };

  it('marks the hand-logged row and leaves the platform row in the same list unmarked', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [PLATFORM_CALL, HAND_LOGGED_CALL] } });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    const loggedRow = (
      await screen.findByText(/Talked through the quote/, { selector: 'p' })
    ).closest('div')!;
    expect(within(loggedRow).getByText('Logged')).toBeInTheDocument();

    const platformRow = screen.getByText(/Recorded by the platform/, { selector: 'p' })
      .closest('div')!;
    expect(within(platformRow).queryByText('Logged')).toBeNull();
  });

  it('gives the hand-logged row a provenance marker that is not sight-only', async () => {
    // The chip says it in words; this says it on the element the eye lands on first. It carries
    // an accessible name rather than only a tint — a marker only sighted users receive is not one.
    mockApi.get.mockResolvedValue({ data: { items: [PLATFORM_CALL, HAND_LOGGED_CALL] } });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    expect(
      await screen.findByRole('img', { name: /hand-entered, not a recorded call/i }),
    ).toBeInTheDocument();
    // Exactly one — the platform row must not have picked it up.
    expect(screen.getAllByRole('img', { name: /hand-entered/i })).toHaveLength(1);
  });
});

/**
 * A payment received (S08.10) arrives in the same list as a `portal` row with direction 'in'. It is money on an invoice,
 * not something the customer said, so the preview words it from its title, with no customer name in front, and shows the
 * money icon and a "Payment" label rather than the estimate-decision clipboard and "Customer".
 */
describe('CustomerContactCard communication history - payment entries (S08.10)', () => {
  const OFFICE_PAYMENT = {
    id: 'cccccccc-0000-0000-0000-000000000003',
    channel: 'portal',
    direction: 'in',
    who: 'Daniel Cohen',
    title: 'Payment received on invoice INV-7',
    preview: 'Recorded by the office',
    at: '2026-08-22T15:00:00.000Z',
    entry: 'payment_received',
    amount: 250,
    paidVia: 'office',
  };
  const ESTIMATE_APPROVED = {
    id: 'dddddddd-0000-0000-0000-000000000004',
    channel: 'portal',
    direction: 'in',
    who: 'Daniel Cohen',
    title: 'Estimate approved',
    preview: 'Estimate approved',
    at: '2026-08-21T15:00:00.000Z',
    entry: 'estimate_approved',
  };

  it('words a payment from its title and never attributes an office-recorded one to the customer', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [OFFICE_PAYMENT, ESTIMATE_APPROVED] } });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    const line = (await screen.findByText(/Recorded by the office/, { selector: 'p' })).closest('div')!;
    expect(line).toHaveTextContent('Payment received on invoice INV-7');
    expect(line).toHaveTextContent('Recorded by the office');
    expect(line).not.toHaveTextContent(/Daniel/);
    expect(within(line).getByTitle('Payment')).toBeInTheDocument();
    expect(within(line).queryByTitle('Customer')).toBeNull();
  });

  it('leaves an estimate decision worded as the customer\'s own action', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [OFFICE_PAYMENT, ESTIMATE_APPROVED] } });
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    const line = (await screen.findByText(/Estimate approved/, { selector: 'p' })).closest('div')!;
    expect(line).toHaveTextContent('Daniel');
    expect(within(line).getByTitle('Customer')).toBeInTheDocument();
  });
});
