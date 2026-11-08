// Spec C slice 7 - staff text threads are VISIBLE in Communication, and
// unmistakable for a conversation with a customer.
//
// The inbox already knew how to RENDER a team thread (icon, "Team ·" meta line,
// the team information panel). What it had no lane for was SHOWING one: the
// conversations filter matched only threads whose kind resolves to `customer`
// and the only other lane was the archive, so a staff thread was written,
// stored and invisible. This suite pins the third lane.
//
// The fixtures below mirror what the automation recorder actually writes
// (services/automations/smsRecord.ts): kind 'team', campaign_type 'tech_ops',
// title = the person's name, user_id set, NO subtitle and NO job attribution.
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

window.HTMLElement.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000077';
const STAFF_USER_ID = 'u0000000-0000-0000-0000-000000000012';

/** An owned, texting-capable number - wire shape of GET /api/communication/numbers. */
const SMS_NUMBER = {
  id: 'num-1',
  e164: '+15512827064',
  sms_enabled: true,
  created_at: '2026-07-01T00:00:00Z',
};

const CONTACTS_FIXTURE: PhoneCustomer[] = [
  {
    id: CUSTOMER_ID,
    name: 'Rolex 5th Ave',
    type: 'commercial',
    site: '665 Fifth Ave, NY',
    contacts: [
      {
        id: 'ct_rolex_fm',
        name: 'Daniel Cohen',
        role: 'Facilities Manager',
        preferredLang: 'en',
        channels: [{ id: 'ch_rolex_s', kind: 'sms', value: '+12125551042', consented: true }],
      },
    ],
  },
];

const CUSTOMER_THREAD: MessageThread = {
  id: 'thr_customer',
  customerId: CUSTOMER_ID,
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [
    {
      id: 'cm1',
      direction: 'out',
      body: 'Confirmed: Thu 8:00 AM, vault corridor re-key.',
      ts: '2026-06-09T14:00:00Z',
      status: 'delivered',
    },
  ],
};

/** Exactly what smsRecord.ts writes for a staff-addressed automation text. */
const STAFF_THREAD: MessageThread = {
  id: 'thr_staff',
  customerId: '',
  channel: 'sms',
  campaignType: 'tech_ops',
  kind: 'team',
  unread: 0,
  title: 'Mike Reyes',
  userId: STAFF_USER_ID,
  linkedUser: { id: STAFF_USER_ID, name: 'Mike Reyes' },
  messages: [
    {
      id: 'sm1',
      direction: 'out',
      body: 'J00042 assigned to you - 8:00 AM at 665 Fifth Ave.',
      ts: '2026-06-09T13:00:00Z',
      status: 'sent',
      automated: true,
    },
  ],
};

/** Prod shape of GET /api/customers/:id -> customer.jobs. */
const CUSTOMER_JOBS_FIXTURE = [
  {
    id: 'b0000000-0000-0000-0000-000000000042',
    job_number: 'J00042',
    status: 'SCHEDULED',
    service_location: { address_line1: '665 Fifth Ave' },
  },
];

/** The line that replaces the composer on a staff thread. */
const STAFF_COMPOSER_NOTE = 'Replies to staff threads are not available yet.';

const fresh = (t: MessageThread): MessageThread => structuredClone(t);

function Harness({ initial }: { initial: MessageThread[] }) {
  const [threads, setThreads] = useState(initial);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

/** The lane pills and the thread rows are all buttons; only the pills carry a
 *  lane label, so selecting one by name is unambiguous. */
async function pickLane(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
}

/** A FULLY enabled texting org. The staff-thread composer must stay disabled
 *  here, on its own reason - not as a side effect of the org-level gate, which
 *  would make the assertion pass for the wrong reason. */
function mockEnabledOrg() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization')
      return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/numbers') return { data: { numbers: [SMS_NUMBER] } };
    if (url === '/api/communication/contacts') return { data: { contacts: CONTACTS_FIXTURE } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [] } };
    if (url === `/api/customers/${CUSTOMER_ID}`)
      return { data: { customer: { jobs: CUSTOMER_JOBS_FIXTURE } } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/contacts') return { data: { contacts: CONTACTS_FIXTURE } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [] } };
    if (url === `/api/customers/${CUSTOMER_ID}`)
      return { data: { customer: { jobs: CUSTOMER_JOBS_FIXTURE } } };
    return { data: {} };
  });
});

describe('SmsInboxView - the staff (team) lane', () => {
  it('lists a staff thread under its own lane, by the person name and a team meta line', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);
    await screen.findByRole('button', { name: /Rolex 5th Ave/ });

    await pickLane(user, 'Team');

    const row = screen.getByRole('button', { name: /Mike Reyes/ });
    expect(within(row).getByText('Mike Reyes')).toBeInTheDocument();
    expect(within(row).getByText(/^Team ·/)).toBeInTheDocument();
  });

  it('keeps a staff thread OUT of the customer conversations lane', async () => {
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);

    // The customer thread is listed...
    expect(await screen.findByRole('button', { name: /Rolex 5th Ave/ })).toBeInTheDocument();
    // ...and the staff thread is not a row in this lane.
    expect(screen.queryByRole('button', { name: /Mike Reyes/ })).not.toBeInTheDocument();
  });

  it('keeps a customer thread OUT of the team lane', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);
    await screen.findByRole('button', { name: /Rolex 5th Ave/ });

    await pickLane(user, 'Team');

    expect(screen.getByRole('button', { name: /Mike Reyes/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rolex 5th Ave/ })).not.toBeInTheDocument();
  });
});

describe('SmsInboxView - the empty team lane', () => {
  it('names the lane it is empty rather than calling staff threads "conversations"', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockEnabledOrg();
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD)]} />);
    await screen.findByRole('button', { name: /Rolex 5th Ave/ });

    await pickLane(user, 'Team');

    expect(screen.getByText('No team conversations.')).toBeInTheDocument();
  });
});

describe('SmsInboxView - an open staff thread', () => {
  it('shows the team information panel instead of the customer-and-job context panel', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockEnabledOrg();
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);
    await screen.findByRole('button', { name: /Rolex 5th Ave/ });

    await pickLane(user, 'Team');

    expect(await screen.findByText('Internal team thread')).toBeInTheDocument();
    expect(screen.getAllByText('J00042 assigned to you - 8:00 AM at 665 Fifth Ave.').length).toBeGreaterThan(0);
    // The customer-and-job context panel is gone with it.
    expect(screen.queryByText('Jobs · navigation')).not.toBeInTheDocument();
  });

  it('shows no job attribution UI at all - no pills, no assign control, no unrouted tray', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockEnabledOrg();
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);
    await screen.findByRole('button', { name: /Rolex 5th Ave/ });

    await pickLane(user, 'Team');
    await screen.findByText('Internal team thread');

    expect(screen.queryByText('no job')).not.toBeInTheDocument();
    expect(screen.queryByText('Unrouted')).not.toBeInTheDocument();
    expect(screen.queryByText('Assign')).not.toBeInTheDocument();
  });

  it('disables the reply composer and says why, in an org whose texting is fully live', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockEnabledOrg();
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);

    // The gate is open: the CUSTOMER thread's composer is live.
    const input = await screen.findByPlaceholderText('Type an SMS reply…');
    await waitFor(() => expect(input).toBeEnabled());

    await pickLane(user, 'Team');

    expect(await screen.findByText(STAFF_COMPOSER_NOTE)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type an SMS reply…')).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('cannot send from a staff thread even if the input is driven directly', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockEnabledOrg();
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);
    await screen.findByRole('button', { name: /Rolex 5th Ave/ });

    await pickLane(user, 'Team');
    await screen.findByText(STAFF_COMPOSER_NOTE);

    // Bypass the disabled attribute the way a stray keystroke would not be able
    // to, and prove the handler itself refuses: no POST is ever made, so the
    // server never gets the chance to answer.
    const input = screen.getByPlaceholderText('Type an SMS reply…');
    fireEvent.change(input, { target: { value: 'are you there?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('SmsInboxView - the customer lane is unchanged', () => {
  it('still lists customer threads with their campaign meta line and job pills', async () => {
    mockEnabledOrg();
    renderWithProviders(<Harness initial={[fresh(CUSTOMER_THREAD), fresh(STAFF_THREAD)]} />);

    const row = await screen.findByRole('button', { name: /Rolex 5th Ave/ });
    expect(within(row).getByText(/Customer care · SMS/)).toBeInTheDocument();
    // Job attribution UI is alive on the customer side.
    expect(await screen.findByText('no job')).toBeInTheDocument();
    expect(screen.queryByText('Internal team thread')).not.toBeInTheDocument();
  });

  it('still shows archived threads of ANY kind under Archive', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockEnabledOrg();
    const archivedStaff = { ...fresh(STAFF_THREAD), id: 'thr_staff_archived', archived: true };
    const archivedCustomer = { ...fresh(CUSTOMER_THREAD), id: 'thr_cust_archived', archived: true, title: 'Old Customer' };
    renderWithProviders(<Harness initial={[archivedCustomer, archivedStaff]} />);
    await screen.findByRole('button', { name: /^Archive/ });

    await pickLane(user, 'Archive');

    expect(screen.getByRole('button', { name: /Mike Reyes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Old Customer/ })).toBeInTheDocument();
    // ...and an archived staff thread is NOT double-listed in the team lane.
    await pickLane(user, 'Team');
    expect(screen.queryByRole('button', { name: /Mike Reyes/ })).not.toBeInTheDocument();
  });
});
