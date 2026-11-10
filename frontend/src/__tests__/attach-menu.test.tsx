// #3024 - "Attach to a lead or job", across every customer with the number (parent #3013, Q41; Ran's rulings of 2026-11-06).
//
// The menu as a component, the API answered at the house network edge (@/lib/axios), no own module mocked:
//   • it lists the leads and jobs of every customer carrying the number, grouped by customer, as the server answers them;
//   • a pick names the lead or job; "No lead or job" sits at the bottom and unties;
//   • with 100+ leads and jobs it keeps a search and a scrolling list of its own;
//   • for a number no customer carries it searches every lead and job, as before.
// And the inbox's trigger for it: each text's lead or job as grey text, then "Change" for a person with Attach only.
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { AttachMenu } from '@/components/communication/shared/AttachMenu';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { AttachTargetsAnswer, MessageThread, PhoneCustomer } from '@/lib/api/communication';
import { MY_SWITCHES_URL, VIEWS_CUSTOMERS_ANSWER } from './support/viewsCustomers';

const mockApi = vi.mocked(api);

// Radix dropdown-menu internals touch scrollIntoView, which jsdom lacks.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
// floating-ui (under Radix popper) does `new ResizeObserver(...)`; the global arrow-fn mock from setup.ts is not constructible.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const attacher = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'attach', subject: 'Communication' },
]);
const readerOnly = buildAbility([{ action: 'read', subject: 'Communication' }]);

const id = (n: number) => `b0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** What the server answers for a reply from (555) 010-3002: three customers carry the number. */
const SHARED_ANSWER: AttachTargetsAnswer = {
  rule: 'carriers',
  groups: [
    {
      customer: { id: id(1), name: 'Jordan Lee' },
      jobs: [{ id: id(11), number: 'J00101', location: '12 Elm St' }],
      leads: [{ id: id(12), number: 'L00055', detail: 'Fix the door' }],
    },
    {
      customer: { id: id(2), name: 'Pat Morgan' },
      jobs: [{ id: id(21), number: 'J00218', location: '40 Oak Ave' }],
      leads: [{ id: id(22), number: 'L00060', detail: 'New lock' }],
    },
    {
      customer: { id: id(3), name: 'Alex Kim' },
      jobs: [],
      leads: [{ id: id(32), number: 'L00077', detail: 'Gate opener' }],
    },
  ],
};

/** 120 leads and jobs over three customers carrying the number. */
const LONG_ANSWER: AttachTargetsAnswer = {
  rule: 'carriers',
  groups: ['Jordan Lee', 'Pat Morgan', 'Alex Kim'].map((name, g) => ({
    customer: { id: id(100 + g), name },
    jobs: Array.from({ length: 20 }, (_, i) => ({ id: id(1000 + g * 100 + i), number: `J0${g}${String(i).padStart(3, '0')}`, location: `${i} Main St` })),
    leads: Array.from({ length: 20 }, (_, i) => ({ id: id(2000 + g * 100 + i), number: `L0${g}${String(i).padStart(3, '0')}`, detail: 'Service call' })),
  })),
};

function answering(targets: AttachTargetsAnswer, extra: (url: string, params?: unknown) => unknown = () => undefined) {
  mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (/^\/api\/communication\/sms\/[^/]+\/attach-targets$/.test(url)) return { data: targets };
    const more = extra(url, config?.params);
    if (more) return more;
    return { data: {} };
  });
}

function Menu({ onPick }: { onPick: (p: unknown) => void }) {
  return (
    <AttachMenu target={{ kind: 'sms', id: 'm1' }} onPick={onPick}>
      <button type="button">Change</button>
    </AttachMenu>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Attach to a lead or job', () => {
  it("on a reply from (555) 010-3002 lists Jordan Lee's, Pat Morgan's and Alex Kim's leads and jobs, grouped by customer", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    answering(SHARED_ANSWER);
    renderWithProviders(<Menu onPick={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByText('Attach to a lead or job')).toBeInTheDocument();
    const list = await screen.findByRole('group', { name: 'Leads and jobs' });
    const groups = within(list).getAllByRole('group').map((g) => ({
      customer: g.getAttribute('aria-label'),
      items: within(g).getAllByRole('menuitem').map((i) => i.textContent),
    }));
    expect(groups).toEqual([
      { customer: 'Jordan Lee', items: ['J00101 · 12 Elm St', 'L00055 · Fix the door'] },
      { customer: 'Pat Morgan', items: ['J00218 · 40 Oak Ave', 'L00060 · New lock'] },
      { customer: 'Alex Kim', items: ['L00077 · Gate opener'] },
    ]);
    expect(within(list).getByText('Pat Morgan')).toBeInTheDocument();
  });

  it("picking Pat Morgan's J00218 names that job; \"No lead or job\" is the last item and unties", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    answering(SHARED_ANSWER);
    const onPick = vi.fn();
    renderWithProviders(<Menu onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(await screen.findByRole('menuitem', { name: /J00218/ }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'job', id: id(21), label: 'J00218' });

    await user.click(screen.getByRole('button', { name: 'Change' }));
    await screen.findByRole('menuitem', { name: /J00218/ });
    const items = screen.getAllByRole('menuitem');
    expect(items[items.length - 1]).toHaveTextContent('No lead or job');
    await user.click(items[items.length - 1]!);
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it('stays usable with 120 leads and jobs: a search, and a list that scrolls on its own between the search and "No lead or job"', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    answering(LONG_ANSWER);
    const onPick = vi.fn();
    renderWithProviders(<Menu onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: 'Change' }));
    const list = await screen.findByRole('group', { name: 'Leads and jobs' });
    expect(within(list).getAllByRole('menuitem')).toHaveLength(120);
    // Its own scroll: the list is the scrolling box; the search and "No lead or job" sit outside it, always in reach.
    expect(list).toHaveClass('overflow-y-auto');
    const search = screen.getByRole('searchbox', { name: 'Search leads and jobs' });
    expect(list).not.toContainElement(search);
    expect(list).not.toContainElement(screen.getByRole('menuitem', { name: 'No lead or job' }));

    // A record's number finds it among the 120.
    await user.type(search, 'J01007');
    expect(within(list).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['J01007 · 7 Main St']);
    expect(within(list).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Pat Morgan']);
    // A customer's name finds their work.
    await user.clear(search);
    await user.type(search, 'alex');
    expect(within(list).getAllByRole('menuitem')).toHaveLength(40);
    await user.click(within(list).getByRole('menuitem', { name: /L02019/ }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'lead', id: id(2219), label: 'L02019' });
  });

  it('for a number no customer carries, searches every lead and job, as before', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    answering({ rule: 'any', groups: [] }, (url, params) => {
      const search = (params as { search?: string } | undefined)?.search;
      if (url === '/api/jobs' && search === 'J003') {
        return { data: { jobs: [{ id: id(301), job_number: 'J00300', status: 'SCHEDULED', service_location: { address_line1: '9 Pine Rd' } }] } };
      }
      if (url === '/api/leads' && search === 'J003') return { data: { leads: [] } };
      return undefined;
    });
    const onPick = vi.fn();
    renderWithProviders(<Menu onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByText('Type to search leads and jobs')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search leads and jobs' }), 'J003');
    await user.click(await screen.findByRole('menuitem', { name: /J00300/ }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'job', id: id(301), label: 'J00300' });
  });
});

// ─── The inbox: each text's lead or job as grey text, then "Change" ──────────

const CUSTOMER_ID = id(2);
const CONTACTS: PhoneCustomer[] = [
  { id: CUSTOMER_ID, name: 'Pat Morgan', type: 'residential', site: '40 Oak Ave', contacts: [] },
];

const THREAD: MessageThread = {
  id: 'thr_shared',
  customerId: CUSTOMER_ID,
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [
    // On J00218 and the lead it was made from (a job's own lead rides along with it).
    { id: 'on-job', direction: 'out', body: 'Your tech is on the way.', ts: '2026-11-05T14:00:00Z', status: 'delivered', jobId: id(21), jobLabel: 'J00218', leadId: id(22), leadLabel: 'L00060' },
    { id: 'on-lead', direction: 'out', body: 'Your estimate is ready.', ts: '2026-11-05T14:01:00Z', status: 'delivered', leadId: id(22), leadLabel: 'L00060' },
    { id: 'm1', direction: 'in', body: 'Is Tuesday free?', ts: '2026-11-05T14:05:00Z', status: 'received' },
  ],
};

function Inbox() {
  const [threads, setThreads] = useState<MessageThread[]>([structuredClone(THREAD)]);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

/** The grey text under each text, in the conversation's order, and how many "Change" buttons there are. */
function tiesShown() {
  return {
    ties: screen.getAllByText(/^(J\d+|L\d+|No lead or job)$/).map((el) => el.textContent),
    changes: screen.queryAllByRole('button', { name: 'Change' }).length,
  };
}

describe('the inbox shows each text\'s lead or job as grey text, then "Change"', () => {
  beforeEach(() => {
    answering(SHARED_ANSWER, (url) => {
      if (url === MY_SWITCHES_URL) return VIEWS_CUSTOMERS_ANSWER;
      if (url === '/api/communication/contacts') return { data: { contacts: CONTACTS } };
      if (url === '/api/communication/threads') return { data: { threads: [] } };
      return undefined;
    });
    mockApi.patch.mockResolvedValue({ data: { message: {} } });
  });

  it('the job number, the lead number when the text is only on a lead, "No lead or job" when untied; Change with Attach', async () => {
    renderWithProviders(<Inbox />, { ability: attacher });
    await screen.findAllByText('Is Tuesday free?');
    expect(tiesShown()).toEqual({ ties: ['J00218', 'L00060', 'No lead or job'], changes: 3 });
  });

  it('a person without Attach sees the grey text without Change, and no Unrouted "Assign"', async () => {
    renderWithProviders(<Inbox />, { ability: readerOnly });
    await screen.findAllByText('Is Tuesday free?');
    expect(tiesShown()).toEqual({ ties: ['J00218', 'L00060', 'No lead or job'], changes: 0 });
    expect(screen.queryByText('Assign')).not.toBeInTheDocument();
  });

  it("Change, then Pat Morgan's J00218: the text is attached and its grey text reads J00218", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Inbox />, { ability: attacher });
    await screen.findAllByText('Is Tuesday free?');

    // The third text's Change (the untied reply).
    await user.click(screen.getAllByRole('button', { name: 'Change' })[2]!);
    await user.click(await screen.findByRole('menuitem', { name: /J00218/ }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/communication/sms/m1/job', { job_id: id(21) }));
    await waitFor(() => expect(tiesShown()).toEqual({ ties: ['J00218', 'L00060', 'J00218'], changes: 3 }));
  });

  it("a text on Pat Morgan's L00060 attached to Jordan Lee's J00101 leaves L00060 (the server's answer), so L00060 is offered again", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // J00101 was made from scratch: the server answers the text with no lead.
    mockApi.patch.mockResolvedValue({ data: { message: { id: 'on-lead', jobId: id(11), jobLabel: 'J00101' } } });
    renderWithProviders(<Inbox />, { ability: attacher });
    await screen.findAllByText('Is Tuesday free?');

    await user.click(screen.getAllByRole('button', { name: 'Change' })[1]!);
    const jordansJob = await screen.findByRole('menuitem', { name: /J00101/ });
    expect(screen.queryByRole('menuitem', { name: /L00060/ })).not.toBeInTheDocument();
    await user.click(jordansJob);
    await waitFor(() => expect(tiesShown()).toEqual({ ties: ['J00218', 'J00101', 'No lead or job'], changes: 3 }));

    await user.click(screen.getAllByRole('button', { name: 'Change' })[1]!);
    expect(await screen.findByRole('menuitem', { name: /L00060/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /J00101/ })).not.toBeInTheDocument();
  });

  it("a text on Pat Morgan's J00218 moved to Alex Kim's lead ends on that lead alone: its grey text reads L00077", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Inbox />, { ability: attacher });
    await screen.findAllByText('Is Tuesday free?');

    await user.click(screen.getAllByRole('button', { name: 'Change' })[0]!);
    await user.click(await screen.findByRole('menuitem', { name: /L00077/ }));

    // One change: the server takes the text off its job as it puts it on the lead, so nothing can be left half done.
    await waitFor(() => expect(tiesShown()).toEqual({ ties: ['L00077', 'L00060', 'No lead or job'], changes: 3 }));
    expect(mockApi.patch.mock.calls).toEqual([['/api/communication/sms/on-job/lead', { lead_id: id(32) }]]);
  });

  it('"No lead or job" on a text on a job and its lead unties both in one change', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Inbox />, { ability: attacher });
    await screen.findAllByText('Is Tuesday free?');

    await user.click(screen.getAllByRole('button', { name: 'Change' })[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'No lead or job' }));

    await waitFor(() => expect(tiesShown()).toEqual({ ties: ['No lead or job', 'L00060', 'No lead or job'], changes: 3 }));
    expect(mockApi.patch.mock.calls).toEqual([['/api/communication/sms/on-job/job', { job_id: null }]]);
  });

  it('the Unrouted tray\'s "Assign" opens the same menu, and "No lead or job" there unties', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Inbox />, { ability: attacher });
    await user.click(await screen.findByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Attach to a lead or job')).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Alex Kim' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'No lead or job' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/communication/sms/m1/job', { job_id: null }));
  });
});
