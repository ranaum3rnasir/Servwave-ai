// Whole-diff ruling (Ran, 2026-11-07, "use the order live"; #3013 decision 5): the inbox side panel of a conversation on a
// shared number shows the conversation's one customer as the server works it out at each read - the first customer
// carrying the number in the fixed order (#3015) that the person can open, the one the header names first - never the
// customer the conversation happens to be stored on. Its customer card, its "Jobs · navigation" list and its Unrouted tray
// all follow it.
//
// Jordan Lee (newer, open lead) and Pat Morgan (older, no open work) share (555) 010-3002; Dana texted from Pat's page first,
// so the conversation is stored on Pat.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';
import { MY_SWITCHES_URL, VIEWS_CUSTOMERS_ANSWER } from './support/viewsCustomers';

const mockApi = vi.mocked(api);

// Attach conversations to jobs and leads: the Unrouted tray shows to a person who holds it.
const attacher = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'attach', subject: 'Communication' },
]);

const JORDAN = { id: 'c0000000-0000-0000-0000-000000004001', name: 'Jordan Lee' };
const PAT = { id: 'c0000000-0000-0000-0000-000000004002', name: 'Pat Morgan' };

function rosterEntry(c: { id: string; name: string }, site: string, phone: string): PhoneCustomer {
  return {
    id: c.id,
    name: c.name,
    type: 'residential',
    site,
    contacts: [
      { id: `${c.id}-ct`, name: c.name, role: 'Owner', preferredLang: 'en', channels: [{ id: `${c.id}-s`, kind: 'sms', value: phone, consented: true }] },
    ],
  };
}

const JORDAN_ROW = rosterEntry(JORDAN, '12 Elm St', '+15550103002');
const PAT_ROW = rosterEntry(PAT, '40 Oak Ave', '+15550103002');

/** Each customer's jobs, as GET /api/customers/:id gives them. */
const JOBS: Record<string, { id: string; job_number: string; status: string; service_location: { address_line1: string } }[]> = {
  [JORDAN.id]: [{ id: 'b0000000-0000-0000-0000-000000004301', job_number: 'J00301', status: 'SCHEDULED', service_location: { address_line1: '12 Elm St' } }],
  [PAT.id]: [{ id: 'b0000000-0000-0000-0000-000000004201', job_number: 'J00201', status: 'COMPLETED', service_location: { address_line1: '40 Oak Ave' } }],
};

/** The conversation as the server sends it: stored on Pat Morgan, named by `customers`, with the customer's untied answer. */
function storedOnPat(customers: { id: string; name: string }[], filedOn: { customerId: string; linkedCustomer?: typeof PAT } = { customerId: PAT.id, linkedCustomer: PAT }): MessageThread {
  return {
    id: 'pair-3002',
    ...filedOn,
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [
      { id: 'm-out', direction: 'out', body: 'Your door is ready', ts: '2026-11-06T14:00:00Z', status: 'delivered' },
      { id: 'm-in', direction: 'in', body: 'Can you come Tuesday?', ts: '2026-11-06T14:05:00Z', status: 'received' },
    ],
    pair: { otherPartyE164: '+15550103002', ourNumberE164: '+15550100000', ourLine: { kind: 'main_line' }, customers },
  };
}

function show(thread: MessageThread, roster: PhoneCustomer[]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === MY_SWITCHES_URL) return VIEWS_CUSTOMERS_ANSWER;
    if (url === '/api/communication/contacts') return { data: { contacts: roster } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [thread] } };
    if (url === `/api/communication/threads/${thread.id}`) return { data: { thread } };
    const customer = Object.keys(JOBS).find((id) => url === `/api/customers/${id}`);
    if (customer) return { data: { customer: { jobs: JOBS[customer] } } };
    return { data: {} };
  });
  renderWithProviders(<SmsInboxView threads={[thread]} setThreads={vi.fn()} onToast={vi.fn()} />, { ability: attacher });
}

/** The side panel, as the person reads it once its jobs are in: the customer on its card, its jobs, and the Unrouted tray. */
async function sidePanel() {
  const panel = (await screen.findByText('Jobs · navigation')).closest('aside') as HTMLElement;
  return {
    customer: panel.querySelector('p')?.textContent,
    jobs: within(panel).getAllByTitle(/^Open J/).map((b) => b.textContent),
    unrouted: within(panel).queryByText('Unrouted') !== null,
    text: panel.textContent ?? '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the side panel of a conversation stored on Pat Morgan, which the fixed order names on Jordan Lee', () => {
  it("shows Jordan Lee's card, Jordan's jobs and the Unrouted tray, and nothing of Pat's", async () => {
    show(storedOnPat([JORDAN, PAT]), [JORDAN_ROW, PAT_ROW]);

    const panel = await sidePanel();

    expect(panel).toMatchObject({ customer: 'Jordan Lee', jobs: ['J00301 · 12 Elm St'], unrouted: true });
    expect(panel.text).toContain('12 Elm St');
    expect(panel.text).not.toContain('Pat Morgan');
    expect(panel.text).not.toContain('J00201');
  });

  it('still shows Jordan Lee once (555) 010-3002 is removed from Pat Morgan', async () => {
    show(storedOnPat([JORDAN]), [JORDAN_ROW, PAT_ROW]);

    const panel = await sidePanel();

    expect(panel).toMatchObject({ customer: 'Jordan Lee', jobs: ['J00301 · 12 Elm St'], unrouted: true });
    expect(panel.text).not.toContain('Pat Morgan');
  });

  it('shows no customer once no customer carries the number, whoever it is stored on', async () => {
    show(storedOnPat([]), [JORDAN_ROW, PAT_ROW]);
    // Once the directory has come in, the panel would have a customer to show.
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/communication/contacts'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(mockApi.get).not.toHaveBeenCalledWith(`/api/customers/${PAT.id}`);
    expect(screen.getByText('Select a conversation.')).toBeInTheDocument();
    expect(screen.queryByText('Jobs · navigation')).not.toBeInTheDocument();
  });
});

describe('a person who opens Pat Morgan but not Jordan Lee', () => {
  it("is shown Pat Morgan, the customer they can open, and nothing of Jordan's", async () => {
    // As the server sends it to them: named by Pat alone; their directory holds Pat only.
    show(storedOnPat([PAT]), [PAT_ROW]);

    const panel = await sidePanel();

    expect(panel).toMatchObject({ customer: 'Pat Morgan', jobs: ['J00201 · 40 Oak Ave'], unrouted: true });
    expect(document.body.textContent).not.toContain('Jordan');
    expect(mockApi.get).not.toHaveBeenCalledWith(`/api/customers/${JORDAN.id}`);
  });
});
