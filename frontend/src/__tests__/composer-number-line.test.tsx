// #3023 (parent #3013, row 2): one line above EVERY text box names both numbers, asked for with exactly the fields the text
// box's send names, so the line can never describe a different send. Every text box, in one table (the source guard in
// composer-number-line-guard.test.ts fails the day a new one appears without it):
//   - the inbox, a reply in a conversation;
//   - a customer: Text on the customer's page opens the inbox's New message to that customer;
//   - a lead: its Communication tab; and Text on the lead's card (the number tapped, with the lead);
//   - a job: its Communication tab; and Text on the job's card or header (the number tapped, with the job);
//   - the dialer's message panel during a call.
// Then a reply from a number no longer in use: the line says so, and the screen opens the main-line conversation the server
// filed the reply in. The real components run; only the network layer (the app's HTTP client) is faked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState, type ReactElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { MY_SWITCHES_URL, VIEWS_CUSTOMERS_ANSWER } from './support/viewsCustomers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import { MessagePanel } from '@/components/communication/phone/Dialer';
import type { MessageThread, PhoneCustomer, SendingNumbers } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000003023';
const LEAD_ID = 'e0000000-0000-0000-0000-000000019835';
const JOB_ID = 'b0000000-0000-0000-0000-000000003023';
const DANAS = 'a0000000-0000-0000-0000-000000001111';
const MAIN = 'a0000000-0000-0000-0000-000000000000';

const JORDAN: PhoneCustomer = {
  id: CUSTOMER_ID,
  name: 'Jordan Lee',
  type: 'residential',
  site: 'Austin',
  contacts: [{ id: 'ct-1', name: 'Jordan Lee', preferredLang: 'en', channels: [{ id: 'ch-1', kind: 'phone', value: '+15550105252' }] }],
};

function conversation(id: string, ourNumberE164: string, body: string, ts: string): MessageThread {
  return {
    id,
    customerId: CUSTOMER_ID,
    linkedCustomer: { id: CUSTOMER_ID, name: 'Jordan Lee' },
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [{ id: `${id}-m`, direction: 'in', body, ts, status: 'received' }],
    pair: {
      otherPartyE164: '+15550105252', ourNumberE164, ourLine: ourNumberE164 === '+15550100000' ? { kind: 'main_line' } : { kind: 'person', name: 'Dana Ruiz' },
      // #3021: the server names every customer carrying the number with the pair.
      customers: [{ id: CUSTOMER_ID, name: 'Jordan Lee' }],
    },
  };
}
const ON_DANAS_NUMBER = conversation(DANAS, '+15550101111', 'When is install?', '2026-11-05T15:00:00Z');
const ON_THE_MAIN_LINE = conversation(MAIN, '+15550100000', 'Is the office open Saturday?', '2026-11-01T15:00:00Z');

/** Each wording the server can give the line. */
const FROM_DANAS: SendingNumbers = { to: '+15550105252', from: '+15550101111', fromIsYours: false, noLongerInUse: null, cannotSendTexts: null };
const FROM_YOURS: SendingNumbers = { to: '+15550105252', from: '+15550101111', fromIsYours: true, noLongerInUse: null, cannotSendTexts: null };
const CANNOT_TEXT: SendingNumbers = { to: '+15550105252', from: '+15550100000', fromIsYours: false, noLongerInUse: null, cannotSendTexts: '+15550101111' };
const RELEASED: SendingNumbers = { to: '+15550105252', from: '+15550100000', fromIsYours: false, noLongerInUse: '+15550101111', cannotSendTexts: null };

let numbersFor: (params: Record<string, string>) => SendingNumbers = () => FROM_DANAS;
let listed: MessageThread[] = [ON_DANAS_NUMBER];
let sendAnswer: (args: Record<string, string>) => Record<string, unknown> = () => ({});

beforeEach(() => {
  vi.clearAllMocks();
  numbersFor = () => FROM_DANAS;
  listed = [ON_DANAS_NUMBER];
  sendAnswer = () => ({});
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: '00000000-0000-0000-0000-000000000001', email: 'tech@test.com', first_name: 'Test', last_name: 'Tech',
        role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  mockApi.get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
    if (url === MY_SWITCHES_URL) return VIEWS_CUSTOMERS_ANSWER;
    if (url === '/api/organization') return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/contacts') return { data: { contacts: [JORDAN] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: listed } };
    if (url === '/api/communication/sms/numbers') return { data: numbersFor(config?.params ?? {}) };
    if (url === `/api/leads/${LEAD_ID}/communications` || url === `/api/jobs/${JOB_ID}/communications`) return { data: { items: [] } };
    return { data: {} };
  });
  mockApi.post.mockImplementation(async (_url: string, args?: unknown) => ({
    data: {
      message: { id: 'm-out', direction: 'out', body: (args as { body: string }).body, ts: '2026-11-06T10:00:00Z', status: 'sent' },
      delivery: 'sent',
      ...sendAnswer(args as Record<string, string>),
    },
  }));
});

const asked = () =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/communication/sms/numbers').map(([, config]) => (config as { params: object }).params);
const sends = () =>
  mockApi.post.mock.calls.filter(([url]) => url === '/api/communication/sms').map(([, args]) => args as Record<string, string>);

function Inbox() {
  const [threads, setThreads] = useState<MessageThread[]>(listed);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

/** Writes in the text box (an input or a textarea, found by its placeholder) and presses its Send. */
async function writeAndSend(placeholder: RegExp, body: string, sendButton: RegExp = /^send$/i) {
  const box = await screen.findByPlaceholderText(placeholder);
  await waitFor(() => expect(box).toBeEnabled());
  fireEvent.change(box, { target: { value: body } });
  const buttons = screen.getAllByRole('button', { name: sendButton });
  fireEvent.click(buttons[buttons.length - 1]!);
  await waitFor(() => expect(sends()).toHaveLength(1));
}

type TextBox = {
  name: string;
  render: () => ReactElement;
  entries?: string[];
  /** The conversations the inbox lists, when not just Dana's. */
  threads?: MessageThread[];
  placeholder: RegExp;
  /** What the line is asked with, which is what the send names besides the words. */
  fields: Record<string, string>;
};

const TEXT_BOXES: TextBox[] = [
  {
    name: 'the inbox, a reply in Dana\'s conversation',
    render: () => <Inbox />,
    placeholder: /Type an SMS reply/,
    fields: { threadId: DANAS },
  },
  {
    name: 'a customer: Text on the page of a customer with no conversation yet (the inbox\'s New message to the customer)',
    render: () => <Inbox />,
    entries: [`/communication/text?customerId=${CUSTOMER_ID}`],
    threads: [],
    placeholder: /Write a message to Jordan Lee/,
    fields: { customerId: CUSTOMER_ID },
  },
  {
    name: 'a lead: its Communication tab',
    render: () => <LeadCommunicationsTab leadId={LEAD_ID} leadLabel="L19835" customerId={CUSTOMER_ID} customerName="Jordan Lee" customerPhone="5550105252" />,
    placeholder: /Text Jordan Lee/,
    fields: { customerId: CUSTOMER_ID, leadId: LEAD_ID },
  },
  {
    name: 'a lead: Text on the lead\'s card (the number tapped, with the lead)',
    render: () => <Inbox />,
    entries: [`/communication/text?to=5550105252&owner=customer&name=Jordan+Lee&leadId=${LEAD_ID}`],
    placeholder: /Write a message to/,
    fields: { toNumber: '+15550105252', leadId: LEAD_ID },
  },
  {
    name: 'a job: its Communication tab',
    render: () => <JobCommunicationsTab jobId={JOB_ID} jobNumber="J-3023" customerId={CUSTOMER_ID} customerName="Jordan Lee" customerPhone="5550105252" />,
    placeholder: /Text Jordan Lee/,
    fields: { customerId: CUSTOMER_ID, jobId: JOB_ID },
  },
  {
    name: 'a job: Text on the job\'s card or header (the number tapped, with the job)',
    render: () => <Inbox />,
    entries: [`/communication/text?to=5550105252&owner=customer&name=Jordan+Lee&jobId=${JOB_ID}`],
    placeholder: /Write a message to/,
    fields: { toNumber: '+15550105252', jobId: JOB_ID },
  },
  {
    name: 'the dialer\'s message panel during a call',
    render: () => (
      <MessagePanel customer={JORDAN} number="+15550105252" onClose={() => {}} onConference={() => {}} onToast={() => {}} />
    ),
    placeholder: /Type an SMS/,
    fields: { customerId: CUSTOMER_ID },
  },
];

describe('every text box has the line above it, asked for with the fields its send names', () => {
  it.each(TEXT_BOXES)('$name', async ({ render, entries, threads, placeholder, fields }) => {
    if (threads) listed = threads;
    renderWithProviders(render(), { ability: communicationSectionAbility(), ...(entries && { initialEntries: entries }) });

    const line = await screen.findByText(/^Texting/);
    expect(line.textContent).toBe('Texting (555) 010-5252 from (555) 010-1111');
    await writeAndSend(placeholder, 'Thursday works');

    expect(asked()).toContainEqual(fields);
    expect(sends()).toEqual([{ ...fields, body: 'Thursday works' }]);
  });

  it('the person\'s own number: the line says "from your number"', async () => {
    numbersFor = () => FROM_YOURS;
    renderWithProviders(<Inbox />, { ability: communicationSectionAbility() });

    const line = await screen.findByText(/^Texting/);

    expect(line.textContent).toBe('Texting (555) 010-5252 from your number, (555) 010-1111');
  });
});

describe('after (555) 010-1111 is released, a reply leaves from the main line and the screen opens its conversation', () => {
  it('the line reads "(555) 010-1111 is no longer in use.", and the reply opens the main-line conversation it was filed in', async () => {
    listed = [ON_DANAS_NUMBER, ON_THE_MAIN_LINE];
    numbersFor = (params) => (params.threadId === DANAS ? RELEASED : { ...FROM_DANAS, from: '+15550100000' });
    sendAnswer = () => ({ threadId: MAIN, to: '+15550105252' });
    renderWithProviders(<Inbox />, { ability: communicationSectionAbility() });

    const line = await screen.findByText(/no longer in use/);
    expect(line.textContent).toBe('(555) 010-1111 is no longer in use.');
    await writeAndSend(/Type an SMS reply/, 'Are you still home?');

    expect(sends()).toEqual([{ threadId: DANAS, body: 'Are you still home?' }]);
    // The main-line conversation is open: its own text shows in the conversation pane, and its line is asked for.
    const pane = document.querySelector('[data-slot="sms-composer"]')!.parentElement!;
    await waitFor(() => expect(within(pane).getByText('Is the office open Saturday?')).toBeInTheDocument());
    expect(within(pane).getByText('Are you still home?')).toBeInTheDocument();
    await waitFor(() => expect(asked()).toContainEqual({ threadId: MAIN }));
    expect((await within(pane).findByText(/^Texting/)).textContent).toBe('Texting (555) 010-5252 from (555) 010-0000');
  });
});

describe('(555) 010-1111 still in use but unable to send texts: a reply leaves from the main line and the screen opens its conversation', () => {
  it('the line reads "(555) 010-1111 cannot send texts.", and the reply opens the main-line conversation it was filed in', async () => {
    listed = [ON_DANAS_NUMBER, ON_THE_MAIN_LINE];
    numbersFor = (params) => (params.threadId === DANAS ? CANNOT_TEXT : { ...FROM_DANAS, from: '+15550100000' });
    sendAnswer = () => ({ threadId: MAIN, to: '+15550105252' });
    renderWithProviders(<Inbox />, { ability: communicationSectionAbility() });

    const line = await screen.findByText(/cannot send texts/);
    expect(line.textContent).toBe('(555) 010-1111 cannot send texts.');
    await writeAndSend(/Type an SMS reply/, 'Are you still home?');

    expect(sends()).toEqual([{ threadId: DANAS, body: 'Are you still home?' }]);
    const pane = document.querySelector('[data-slot="sms-composer"]')!.parentElement!;
    await waitFor(() => expect(within(pane).getByText('Is the office open Saturday?')).toBeInTheDocument());
    expect(within(pane).getByText('Are you still home?')).toBeInTheDocument();
    await waitFor(() => expect(asked()).toContainEqual({ threadId: MAIN }));
    expect((await within(pane).findByText(/^Texting/)).textContent).toBe('Texting (555) 010-5252 from (555) 010-0000');
  });
});

describe('Text on a job\'s card for a customer phone the job changed: the line and the toast name the number texted', () => {
  it('the job shows (555) 010-5353 for the tapped (555) 010-5252: the line and "Message sent to" both name (555) 010-5353', async () => {
    const toasts: string[] = [];
    listed = [];
    // The person may see the customer's number in full, so the toast names it.
    const answers = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === MY_SWITCHES_URL
        ? { data: { ...VIEWS_CUSTOMERS_ANSWER.data, values: { ...VIEWS_CUSTOMERS_ANSWER.data.values, copy_customer_phone: true } } }
        : answers(url, config as never));
    numbersFor = () => ({ ...FROM_DANAS, to: '+15550105353' });
    sendAnswer = () => ({ threadId: DANAS, to: '+15550105353' });
    function InboxWithToasts() {
      const [threads, setThreads] = useState<MessageThread[]>(listed);
      return <SmsInboxView threads={threads} setThreads={setThreads} onToast={(t: string) => toasts.push(t)} />;
    }
    renderWithProviders(<InboxWithToasts />, {
      ability: communicationSectionAbility(),
      initialEntries: [`/communication/text?to=5550105252&owner=customer&name=Jordan+Lee&jobId=${JOB_ID}`],
    });

    const line = await screen.findByText(/^Texting/);
    expect(line.textContent).toBe('Texting (555) 010-5353 from (555) 010-1111');
    await writeAndSend(/Write a message to/, 'Thursday works');

    expect(sends()).toEqual([{ toNumber: '+15550105252', jobId: JOB_ID, body: 'Thursday works' }]);
    await waitFor(() => expect(toasts).toEqual(['✉️ Message sent to (555) 010-5353']));
  });
});

// #3023 (#3013 decision 2): Text on a customer, or on a lead's customer phone, lands in the conversation the customer's own
// text box continues - the server names it with the line (`conversationId`) - never the customer's most recently updated one.
describe('Text on a customer opens the conversation the customer\'s text box continues', () => {
  const PAT = 'c0000000-0000-0000-0000-000000003002';
  /** The line's answer for the customer (and the lead) names Dana's conversation; a reply in a conversation names its own number. */
  const continuesDanas = (params: Record<string, string>): SendingNumbers =>
    params.threadId === MAIN ? { ...FROM_DANAS, from: '+15550100000', conversationId: MAIN }
      : params.threadId ? { ...FROM_DANAS, conversationId: params.threadId }
        : { ...FROM_DANAS, conversationId: DANAS };
  const paneOf = () => document.querySelector('[data-slot="sms-composer"]')!.parentElement!;

  it('Text on a lead\'s customer phone opens Dana\'s conversation, not the main-line one the customer updated more recently', async () => {
    // The list is newest-updated first: the customer texted the main line after Dana's conversation was last touched.
    listed = [ON_THE_MAIN_LINE, ON_DANAS_NUMBER];
    numbersFor = continuesDanas;
    renderWithProviders(<Inbox />, {
      ability: communicationSectionAbility(),
      initialEntries: [`/communication/text?customerId=${CUSTOMER_ID}&leadId=${LEAD_ID}`],
    });

    await waitFor(() => expect(within(paneOf()).getByText('When is install?')).toBeInTheDocument());
    expect(within(paneOf()).queryByText('Is the office open Saturday?')).toBeNull();
    expect(asked()).toContainEqual({ customerId: CUSTOMER_ID, leadId: LEAD_ID });
    expect((await within(paneOf()).findByText(/^Texting/)).textContent).toBe('Texting (555) 010-5252 from (555) 010-1111');
    await writeAndSend(/Type an SMS reply/, 'Thursday works');

    expect(sends()).toEqual([{ threadId: DANAS, leadId: LEAD_ID, body: 'Thursday works' }]);
  });

  it('opens it when the inbox does not list it: a shared number\'s conversation, filed on another customer carrying the number', async () => {
    // The person's list holds only Pat's main-line conversation; Dana's is filed on Jordan Lee and shown on Pat Morgan too.
    const patsMainLine: MessageThread = { ...ON_THE_MAIN_LINE, customerId: PAT, linkedCustomer: { id: PAT, name: 'Pat Morgan' } };
    const shared: MessageThread = {
      ...ON_DANAS_NUMBER,
      pair: { ...ON_DANAS_NUMBER.pair!, customers: [{ id: CUSTOMER_ID, name: 'Jordan Lee' }, { id: PAT, name: 'Pat Morgan' }] },
    };
    listed = [patsMainLine];
    numbersFor = continuesDanas;
    const answers = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === `/api/communication/threads/${DANAS}` ? { data: { thread: shared } } : answers(url, config as never));
    renderWithProviders(<Inbox />, {
      ability: communicationSectionAbility(),
      initialEntries: [`/communication/text?customerId=${PAT}`],
    });

    await waitFor(() => expect(within(paneOf()).getByText('When is install?')).toBeInTheDocument());
    expect(screen.getByTestId('sms-conversation-heading').textContent).toContain('On Jordan Lee and Pat Morgan');
    await writeAndSend(/Type an SMS reply/, 'Thursday works');

    expect(sends()).toEqual([{ threadId: DANAS, body: 'Thursday works' }]);
  });

  // Spec r3 M3; Ran (2026-11-06): a text from a lead keeps the lead, so the customer's answer is tied to it (#3020).
  it.each([
    ['the inbox lists it', true],
    ['the inbox does not list it', false],
  ])('Text on Pat\'s lead opens the shared conversation filed on Jordan Lee (%s), and the reply carries Pat\'s lead', async (_name, isListed) => {
    const patsMainLine: MessageThread = { ...ON_THE_MAIN_LINE, customerId: PAT, linkedCustomer: { id: PAT, name: 'Pat Morgan' } };
    const shared: MessageThread = {
      ...ON_DANAS_NUMBER,
      pair: { ...ON_DANAS_NUMBER.pair!, customers: [{ id: CUSTOMER_ID, name: 'Jordan Lee' }, { id: PAT, name: 'Pat Morgan' }] },
    };
    listed = isListed ? [patsMainLine, shared] : [patsMainLine];
    numbersFor = continuesDanas;
    const answers = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === `/api/communication/threads/${DANAS}` ? { data: { thread: shared } } : answers(url, config as never));
    renderWithProviders(<Inbox />, {
      ability: communicationSectionAbility(),
      initialEntries: [`/communication/text?customerId=${PAT}&leadId=${LEAD_ID}`],
    });

    await waitFor(() => expect(within(paneOf()).getByText('When is install?')).toBeInTheDocument());
    await waitFor(() => expect(asked()).toContainEqual({ threadId: DANAS, leadId: LEAD_ID }));
    await writeAndSend(/Type an SMS reply/, 'Thursday works');

    expect(sends()).toEqual([{ threadId: DANAS, leadId: LEAD_ID, body: 'Thursday works' }]);
  });

  it('with no conversation with the customer\'s number, New message to the customer, even beside one with a number they no longer carry', async () => {
    const onTheirOldNumber: MessageThread = { ...ON_DANAS_NUMBER, pair: { ...ON_DANAS_NUMBER.pair!, otherPartyE164: '+15550109999' } };
    listed = [onTheirOldNumber];
    numbersFor = (params) => ({ ...FROM_DANAS, conversationId: params.threadId ?? null });
    renderWithProviders(<Inbox />, {
      ability: communicationSectionAbility(),
      initialEntries: [`/communication/text?customerId=${CUSTOMER_ID}`],
    });

    await writeAndSend(/Write a message to Jordan Lee/, 'Thursday works');

    expect(asked()).toContainEqual({ customerId: CUSTOMER_ID });
    expect(sends()).toEqual([{ customerId: CUSTOMER_ID, body: 'Thursday works' }]);
  });
});

// Reviewers r2 (L-new-1, merge-2): the common real case of a moved reply - the customer never texted the main line, so the
// server makes the main-line conversation and the inbox does not list it yet. It stands in until the next poll, under the
// same customers (#3021: the same number, so the same carriers; trap 31).
describe('a reply moved to a main-line conversation the inbox does not list yet', () => {
  it('opens a stand-in for it with the reply, still on the same customers', async () => {
    const shared: MessageThread = {
      ...ON_DANAS_NUMBER,
      pair: { ...ON_DANAS_NUMBER.pair!, customers: [{ id: CUSTOMER_ID, name: 'Jordan Lee' }, { id: 'c0000000-0000-0000-0000-000000003002', name: 'Pat Morgan' }] },
    };
    listed = [shared];
    numbersFor = (params) => (params.threadId === DANAS ? RELEASED : { ...FROM_DANAS, from: '+15550100000' });
    sendAnswer = () => ({ threadId: MAIN, to: '+15550105252' });
    renderWithProviders(<Inbox />, { ability: communicationSectionAbility() });

    await screen.findByText(/no longer in use/);
    await writeAndSend(/Type an SMS reply/, 'Are you still home?');

    const pane = document.querySelector('[data-slot="sms-composer"]')!.parentElement!;
    await waitFor(() => expect(asked()).toContainEqual({ threadId: MAIN }));
    expect(within(pane).getByText('Are you still home?')).toBeInTheDocument();
    expect(within(pane).queryByText('When is install?')).toBeNull();
    expect(screen.getByTestId('sms-conversation-heading').textContent).toContain('On Jordan Lee and Pat Morgan');
    expect((await within(pane).findByText(/^Texting/)).textContent).toBe('Texting (555) 010-5252 from (555) 010-0000');
  });
});
